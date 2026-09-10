import * as core from '@actions/core';
import { resolveTestPath } from './safe-paths';
import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, TestResult, RunReport } from './types';
import { ensurePlaywright, ensurePlaywrightConfig, runTests, writeTests } from './test-runner';
import { healFailedTests } from './self-healer';
import { readExistingTests, formatExistingTestsForAPI } from './existing-tests';

export async function generateAndRunTests(
  context: ChangeContext,
  config: ActionConfig,
  llmClient: ILLMClient,
  workDir: string
): Promise<RunReport> {
  const startTime = Date.now();

  // 0. Read existing tests from testDir
  const existingTests = readExistingTests(workDir, config.testDir);
  if (existingTests.length > 0) {
    core.info(`📚 Found ${existingTests.length} existing test file(s) in ${config.testDir}`);
    context = { ...context, existingTests: formatExistingTestsForAPI(existingTests) };
  }

  // 1. Generate tests
  core.info('🧪 Generating tests...');
  const generatedTests = await llmClient.generateTests(context, config);
  core.info(`Generated ${generatedTests.length} test(s)`);

  if (generatedTests.length === 0) {
    return {
      testsGenerated: 0,
      testsPassed: 0,
      testsFailed: 0,
      testsHealed: 0,
      filesChanged: context.modifiedFiles.map((f) => f.filename),
      duration: Date.now() - startTime,
      tests: [],
      committedFiles: [],
    };
  }

  // 2. Write tests to disk. writeTests drops any test whose filename failed
  // validation, so report from what actually landed — not from what the model
  // proposed — or the PR comment claims tests that do not exist on disk.
  const writtenFiles = await writeTests(generatedTests, workDir, config.testDir);
  // Exact absolute-path membership, not basename: writeTests normalises
  // test.filename in place to the path it validated, so this is the same value
  // it pushed. Basename matching would conflate auth/login.spec.ts with
  // admin/login.spec.ts.
  const writtenSet = new Set(writtenFiles);
  const writtenTests = generatedTests.filter((t) => {
    // Resolve the same way writeTests did rather than relying on its in-place
    // normalisation of test.filename — resolveTestPath is idempotent, so this
    // matches whether or not the name has already been rewritten.
    try {
      return writtenSet.has(resolveTestPath(workDir, config.testDir, t.filename).absolute);
    } catch {
      return false;
    }
  });

  if (writtenTests.length !== generatedTests.length) {
    core.warning(
      `${generatedTests.length - writtenTests.length} generated test(s) were rejected and not written.`,
    );
  }

  // 2b. If generate-only mode, skip running tests entirely
  if (config.mode === 'generate-only') {
    core.info('📝 Generate-only mode: skipping test execution');
    return {
      testsGenerated: writtenTests.length,
      testsPassed: 0,
      testsFailed: 0,
      testsHealed: 0,
      filesChanged: context.modifiedFiles.map((f) => f.filename),
      duration: Date.now() - startTime,
      tests: writtenTests.map((t) => ({
        filename: t.filename,
        passed: true, // Treat as passed for commit purposes
        duration: 0,
      })),
      committedFiles: [],
    };
  }

  // 3. Run tests (installing Playwright + a minimal config if the repo lacks them)
  await ensurePlaywright(workDir);
  ensurePlaywrightConfig(workDir, config.baseUrl, config.testDir);
  core.info('🏃 Running tests...');
  const initialResults = await runTests(writtenTests, config, workDir);

  // 4. Self-heal failed tests
  const failedTests = initialResults
    // Pair against writtenTests: runTests was given that array, so index i
    // refers to it. Pairing with generatedTests here would mis-associate every
    // test after a rejected one.
    .map((result, i) => ({ test: writtenTests[i], result }))
    .filter(({ result }) => !result.passed);

  let healedTests: GeneratedTest[] = [];
  let healedResults: TestResult[] = [];
  let suspectedBugs: RunReport['suspectedBugs'] = [];

  if (failedTests.length > 0 && config.maxRetries > 0) {
    core.info(`🔧 Attempting to heal ${failedTests.length} failed test(s)...`);
    const healing = await healFailedTests(failedTests, context, config, llmClient, workDir);
    healedTests = healing.healed;
    healedResults = healing.results;
    suspectedBugs = healing.suspectedBugs;
  }

  // 5. Compile final results
  const passedInitial = initialResults.filter((r) => r.passed);
  const allResults = [
    ...passedInitial,
    ...healedResults,
  ];

  const totalPassed = allResults.filter((r) => r.passed).length;
  const totalFailed = allResults.filter((r) => !r.passed).length;

  return {
    testsGenerated: writtenTests.length,
    testsPassed: totalPassed,
    testsFailed: totalFailed,
    testsHealed: healedTests.length,
    filesChanged: context.modifiedFiles.map((f) => f.filename),
    duration: Date.now() - startTime,
    tests: allResults,
    committedFiles: [], // Filled in by index.ts after commit
    healedTests,
    suspectedBugs,
  };
}
