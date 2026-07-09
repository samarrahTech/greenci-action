import * as core from '@actions/core';
import * as path from 'path';
import { getConfig } from './config';
import { getPRContext, getChangedFiles, filterTestableFiles } from './diff-parser';
import { buildChangeContext } from './context-builder';
import { createLLMClient } from './llm-client';
import { generateAndRunTests } from './test-generator';
import { commitTests } from './git-ops';
import { postReport } from './pr-reporter';
import { runMigration, buildMigrationReportBody } from './migrator';
import { uploadTraces } from './trace-uploader';
import { uploadResults } from './results-uploader';
import { runBootstrap } from './bootstrap-runner';

async function run(): Promise<void> {
  try {
    const config = getConfig();
    const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';

    if (!token) {
      core.warning('No GitHub token provided. Commit and PR comment features will be disabled.');
    }

    // Bootstrap mode — build a foundational suite; runs from workflow_dispatch
    if (config.mode === 'bootstrap') {
      core.info('🌱 Running in bootstrap mode (foundational suite from journeys)');
      const llmClient = createLLMClient(config);
      const workDir = process.env.GITHUB_WORKSPACE || process.cwd();
      const github = await import('@actions/github');
      const outcome = await runBootstrap(config, llmClient, workDir, token, github.context.repo);

      core.setOutput('tests-generated', String(outcome.testsGenerated));
      core.setOutput('tests-passed', String(outcome.testsPassed));
      core.setOutput('tests-failed', String(outcome.testsFailed));
      if (outcome.prUrl) core.setOutput('report-url', outcome.prUrl);

      core.info(
        `🌱 Bootstrap complete: ${outcome.testsPassed}/${outcome.testsGenerated} tests passing` +
          (outcome.prUrl ? ` — PR: ${outcome.prUrl}` : ''),
      );
      return;
    }

    // Migration mode
    if (config.mode === 'migrate') {
      core.info('🔄 Running in migration mode (Cypress → Playwright)');
      const llmClient = createLLMClient(config);
      const workDir = process.env.GITHUB_WORKSPACE || process.cwd();
      const report = await runMigration(config, llmClient, workDir);

      // Commit and report — only if running in a PR context
      let prContext: ReturnType<typeof getPRContext> | null = null;
      try {
        prContext = getPRContext();
      } catch {
        core.info('ℹ️ No PR context — skipping commit and PR comment (migration results are in the output)');
      }

      // Commit converted tests if auto-commit is on
      if (config.autoCommit && token && report.converted > 0 && prContext) {
        core.info('📝 Committing converted tests...');
        const convertedPaths = report.files
          .filter((f) => f.status !== 'failed')
          .map((f) => `${workDir}/${f.target}`);
        await commitTests(token, prContext, convertedPaths, workDir);
      }

      // Post migration report as PR comment
      if (token && prContext) {
        const reportBody = buildMigrationReportBody(report);
        const github = await import('@actions/github');
        const octokit = github.getOctokit(token);
        await octokit.rest.issues.createComment({
          owner: prContext.owner,
          repo: prContext.repo,
          issue_number: prContext.prNumber,
          body: reportBody,
        });
      }

      core.setOutput('tests-generated', String(report.totalFiles));
      core.setOutput('tests-passed', String(report.converted));
      core.setOutput('tests-failed', String(report.failed));

      core.info(`🌱 GreenCI migration complete: ${report.converted}/${report.totalFiles} files converted`);
      return;
    }

    // 1. Get PR context
    core.info('📋 Getting PR context...');
    const prContext = getPRContext();
    core.info(`PR #${prContext.prNumber} on ${prContext.owner}/${prContext.repo}`);

    // 2. Get changed files
    core.info('📂 Fetching changed files...');
    const allFiles = await getChangedFiles(token, prContext);
    const testableFiles = filterTestableFiles(allFiles);
    core.info(`Found ${allFiles.length} changed files, ${testableFiles.length} testable`);

    if (testableFiles.length === 0) {
      core.info('No testable files changed. Skipping test generation.');
      core.setOutput('tests-generated', '0');
      core.setOutput('tests-passed', '0');
      core.setOutput('tests-failed', '0');
      return;
    }

    // 3. Build context
    core.info('🔍 Analyzing changes...');
    const changeContext = buildChangeContext(testableFiles);
    core.info(changeContext.summary);

    // 4. Generate and run tests
    const llmClient = createLLMClient(config);
    const workDir = process.env.GITHUB_WORKSPACE || process.cwd();
    const report = await generateAndRunTests(changeContext, config, llmClient, workDir);

    // 5. Commit passing tests
    if (config.autoCommit && token && report.testsPassed > 0) {
      core.info('📝 Committing passing tests...');
      const testDir = config.testDir || 'e2e';
      const passingFiles = report.tests
        .filter((t) => t.passed)
        .map((t) => path.join(workDir, testDir, t.filename));
      core.info(`Attempting to commit ${passingFiles.length} file(s): ${passingFiles.join(', ')}`);
      const committed = await commitTests(token, prContext, passingFiles, workDir);
      report.committedFiles = committed;
    }

    // 6. Post PR comment
    if (token) {
      core.info('💬 Posting PR report...');
      const reportUrl = await postReport(token, prContext, report);
      core.setOutput('report-url', reportUrl);
    }

    // 7. Upload run results + traces to the dashboard
    if (config.apiKey) {
      await uploadResults(config.greenCIApiUrl, config.apiKey, prContext, report);
    }
    const projectId = core.getInput('project-id');
    if (config.apiKey && projectId) {
      const runIdStr = process.env.GITHUB_RUN_ID || 'unknown';
      const testResultsDir = path.join(workDir, 'test-results');
      await uploadTraces(testResultsDir, config.greenCIApiUrl, config.apiKey, projectId, runIdStr);
    }

    // 8. Set outputs
    core.setOutput('tests-generated', String(report.testsGenerated));
    core.setOutput('tests-passed', String(report.testsPassed));
    core.setOutput('tests-failed', String(report.testsFailed));

    if (report.testsFailed > 0) {
      core.warning(`${report.testsFailed} test(s) failed after self-healing attempts`);
    }

    core.info(`🌱 GreenCI complete: ${report.testsPassed}/${report.testsGenerated} tests passing`);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unexpected error occurred');
    }
  }
}

run();
