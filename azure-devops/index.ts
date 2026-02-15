/**
 * GreenCI Azure DevOps Pipeline Task
 *
 * Reuses core logic from ../src/ where possible, with Azure DevOps-specific
 * integrations for PR diffs, comments, and pipeline variables.
 */

import * as tl from 'azure-pipelines-task-lib/task';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, execFileSync } from 'child_process';

// ─── Types (mirrored from ../src/types.ts to avoid import issues with @actions deps) ───

interface TaskConfig {
  apiKey: string;
  baseUrl: string;
  testDir: string;
  mode: 'generate' | 'migrate';
  provider: string;
  model: string;
  maxRetries: number;
  autoCommit: boolean;
  greenCIApiUrl: string;
  cypressDir: string;
}

interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied';
  additions: number;
  deletions: number;
  patch?: string;
}

interface GeneratedTest {
  filename: string;
  code: string;
  description: string;
  confidence: number;
}

interface TestResult {
  filename: string;
  passed: boolean;
  duration: number;
  error?: string;
  stdout?: string;
}

interface ChangeContext {
  routes: { path: string; file: string; isNew: boolean }[];
  components: { name: string; file: string; isNew: boolean; props?: string[] }[];
  apiEndpoints: { path: string; method: string; file: string; isNew: boolean }[];
  modifiedFiles: ChangedFile[];
  summary: string;
}

interface RunReport {
  testsGenerated: number;
  testsPassed: number;
  testsFailed: number;
  testsHealed: number;
  filesChanged: string[];
  duration: number;
  tests: TestResult[];
  committedFiles: string[];
}

// ─── Config ───

function getTaskConfig(): TaskConfig {
  const apiKey = tl.getInput('apiKey', true)!;
  if (!apiKey.startsWith('gci_')) {
    tl.warning('API key does not start with gci_ prefix — double-check your key.');
  }

  return {
    apiKey,
    baseUrl: tl.getInput('baseUrl', false) || 'http://localhost:3000',
    testDir: tl.getInput('testDir', false) || 'e2e',
    mode: (tl.getInput('mode', false) || 'generate') as 'generate' | 'migrate',
    provider: tl.getInput('provider', false) || 'greenci',
    model: tl.getInput('model', false) || '',
    maxRetries: parseInt(tl.getInput('maxRetries', false) || '2', 10),
    autoCommit: tl.getBoolInput('autoCommit', false) ?? true,
    greenCIApiUrl: tl.getInput('greenCIApiUrl', false) || 'https://api.greenci.ai',
    cypressDir: tl.getInput('cypressDir', false) || 'cypress/e2e',
  };
}

// ─── Azure DevOps API helpers ───

function getAzDoEnv() {
  const collectionUri = process.env['SYSTEM_TEAMFOUNDATIONCOLLECTIONURI'] || '';
  const project = process.env['SYSTEM_TEAMPROJECT'] || '';
  const repoId = process.env['BUILD_REPOSITORY_ID'] || '';
  const accessToken = process.env['SYSTEM_ACCESSTOKEN'] || '';
  const prId = process.env['SYSTEM_PULLREQUEST_PULLREQUESTID'] || '';
  const sourceBranch = process.env['BUILD_SOURCEBRANCH'] || '';
  const buildReason = process.env['BUILD_REASON'] || '';

  return { collectionUri, project, repoId, accessToken, prId, sourceBranch, buildReason };
}

function isPullRequest(): boolean {
  return getAzDoEnv().buildReason === 'PullRequest' && !!getAzDoEnv().prId;
}

async function azDoFetch(url: string, accessToken: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`:${accessToken}`).toString('base64')}`,
      ...((options.headers as Record<string, string>) || {}),
    },
  });
}

// ─── PR Diff fetching via Azure DevOps REST API ───

async function getPRChangedFiles(accessToken: string): Promise<ChangedFile[]> {
  const { collectionUri, project, repoId, prId } = getAzDoEnv();
  if (!prId) {
    tl.warning('Not a PR build — no changed files from PR.');
    return getGitDiffFiles();
  }

  const apiBase = `${collectionUri}${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}`;

  try {
    // Get iterations to find the diff
    const iterResp = await azDoFetch(`${apiBase}/iterations?api-version=7.1`, accessToken);
    if (!iterResp.ok) {
      tl.warning(`Failed to fetch PR iterations (${iterResp.status}), falling back to git diff`);
      return getGitDiffFiles();
    }
    const iterData = (await iterResp.json()) as { value: { id: number }[] };
    const latestIteration = iterData.value[iterData.value.length - 1];

    // Get changes for latest iteration
    const changesResp = await azDoFetch(
      `${apiBase}/iterations/${latestIteration.id}/changes?api-version=7.1`,
      accessToken
    );
    if (!changesResp.ok) {
      tl.warning(`Failed to fetch PR changes (${changesResp.status}), falling back to git diff`);
      return getGitDiffFiles();
    }

    const changesData = (await changesResp.json()) as {
      changeEntries: { changeType: string; item: { path: string } }[];
    };

    return changesData.changeEntries
      .filter((e) => e.item.path && !e.item.path.endsWith('/'))
      .map((entry) => ({
        filename: entry.item.path.replace(/^\//, ''),
        status: mapChangeType(entry.changeType),
        additions: 0,
        deletions: 0,
      }));
  } catch (error) {
    tl.warning(`Azure DevOps API error: ${error}. Falling back to git diff.`);
    return getGitDiffFiles();
  }
}

function mapChangeType(changeType: string): ChangedFile['status'] {
  const map: Record<string, ChangedFile['status']> = {
    add: 'added',
    edit: 'modified',
    delete: 'removed',
    rename: 'renamed',
  };
  return map[changeType.toLowerCase()] || 'modified';
}

function getGitDiffFiles(): ChangedFile[] {
  try {
    const targetBranch = process.env['SYSTEM_PULLREQUEST_TARGETBRANCH']?.replace('refs/heads/', '') || 'main';
    const output = execSync(`git diff --name-status origin/${targetBranch}...HEAD`, {
      encoding: 'utf-8',
    });

    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...parts] = line.split('\t');
        const filename = parts[parts.length - 1];
        const statusMap: Record<string, ChangedFile['status']> = {
          A: 'added',
          M: 'modified',
          D: 'removed',
          R: 'renamed',
          C: 'copied',
        };
        return {
          filename,
          status: statusMap[status.charAt(0)] || 'modified',
          additions: 0,
          deletions: 0,
        };
      });
  } catch {
    tl.warning('git diff failed. Returning empty file list.');
    return [];
  }
}

// ─── File filtering (reused logic from src/diff-parser.ts) ───

function filterTestableFiles(files: ChangedFile[]): ChangedFile[] {
  const testableExtensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte'];
  const ignorePaths = [
    'node_modules/', 'dist/', 'build/', '.github/', '__tests__/',
    '*.test.', '*.spec.', '.eslint', '.prettier',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  ];

  return files.filter((file) => {
    if (file.status === 'removed') return false;
    const hasTestableExt = testableExtensions.some((ext) => file.filename.endsWith(ext));
    if (!hasTestableExt) return false;
    const isIgnored = ignorePaths.some((pattern) => {
      if (pattern.startsWith('*')) return file.filename.includes(pattern.slice(1));
      return file.filename.includes(pattern);
    });
    return !isIgnored;
  });
}

// ─── Context building (reused logic from src/context-builder.ts) ───

function buildChangeContext(files: ChangedFile[]): ChangeContext {
  const routes: ChangeContext['routes'] = [];
  const components: ChangeContext['components'] = [];
  const apiEndpoints: ChangeContext['apiEndpoints'] = [];

  const routePatterns = [/app\/(.+?)\/page\.(tsx?|jsx?)$/, /pages\/(.+?)\.(tsx?|jsx?)$/];
  const apiPatterns = [/app\/api\/(.+?)\/route\.(ts|js)$/, /pages\/api\/(.+?)\.(ts|js)$/];

  for (const file of files) {
    // Routes
    for (const pattern of routePatterns) {
      const match = file.filename.match(pattern);
      if (match) {
        let routePath = '/' + (match[1] || '')
          .replace(/\/page$/, '')
          .replace(/\/index$/, '')
          .replace(/\[(.+?)\]/g, ':$1');
        routes.push({ path: routePath, file: file.filename, isNew: file.status === 'added' });
        break;
      }
    }

    // API endpoints
    const appApiMatch = file.filename.match(apiPatterns[0]);
    if (appApiMatch) {
      apiEndpoints.push({
        path: '/api/' + appApiMatch[1],
        method: 'GET',
        file: file.filename,
        isNew: file.status === 'added',
      });
      continue;
    }
    const pagesApiMatch = file.filename.match(apiPatterns[1]);
    if (pagesApiMatch) {
      apiEndpoints.push({
        path: '/api/' + pagesApiMatch[1],
        method: 'ALL',
        file: file.filename,
        isNew: file.status === 'added',
      });
      continue;
    }

    // Components
    if (/components?\//i.test(file.filename) || /src\/.*\.(tsx|jsx)$/.test(file.filename)) {
      if (!apiPatterns.some((p) => p.test(file.filename)) && !/page\.(tsx?|jsx?)$/.test(file.filename)) {
        const basename = file.filename.split('/').pop() || '';
        const name = basename.replace(/\.(tsx?|jsx?)$/, '');
        components.push({
          name: name.charAt(0).toUpperCase() + name.slice(1),
          file: file.filename,
          isNew: file.status === 'added',
        });
      }
    }
  }

  const parts = [`${files.length} file(s) changed`];
  if (routes.length > 0) parts.push(`${routes.length} route(s)`);
  if (components.length > 0) parts.push(`${components.length} component(s)`);
  if (apiEndpoints.length > 0) parts.push(`${apiEndpoints.length} API endpoint(s)`);

  return { routes, components, apiEndpoints, modifiedFiles: files, summary: parts.join(', ') };
}

// ─── GreenCI API client ───

async function callGenerateAPI(context: ChangeContext, config: TaskConfig): Promise<GeneratedTest[]> {
  console.log(`Calling GreenCI API at ${config.greenCIApiUrl}/v1/generate`);

  try {
    const response = await fetch(`${config.greenCIApiUrl}/v1/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        context: {
          routes: context.routes,
          components: context.components,
          apiEndpoints: context.apiEndpoints,
          files: context.modifiedFiles.map((f) => ({
            filename: f.filename,
            status: f.status,
            patch: f.patch,
          })),
          summary: context.summary,
        },
        config: {
          baseUrl: config.baseUrl,
          testDir: config.testDir,
          model: config.model || undefined,
        },
      }),
    });

    if (!response.ok) {
      tl.warning(`GreenCI API returned ${response.status}, using fallback`);
      return generateFallbackTests(context, config);
    }

    const data = (await response.json()) as { tests: GeneratedTest[] };
    return data.tests;
  } catch (error) {
    tl.warning(`GreenCI API call failed: ${error}. Using fallback.`);
    return generateFallbackTests(context, config);
  }
}

async function callHealAPI(
  test: GeneratedTest,
  error: string,
  attempt: number,
  context: ChangeContext,
  config: TaskConfig
): Promise<GeneratedTest> {
  try {
    const response = await fetch(`${config.greenCIApiUrl}/v1/heal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        test,
        error,
        attempt,
        context: {
          routes: context.routes,
          components: context.components,
          apiEndpoints: context.apiEndpoints,
          summary: context.summary,
        },
      }),
    });

    if (!response.ok) return test;
    const data = (await response.json()) as { test: GeneratedTest };
    return data.test;
  } catch {
    return test;
  }
}

function generateFallbackTests(context: ChangeContext, config: TaskConfig): GeneratedTest[] {
  const tests: GeneratedTest[] = [];

  for (const route of context.routes) {
    const name = route.path.replace(/^\//, '').replace(/\//g, '-') || 'home';
    tests.push({
      filename: `${config.testDir}/${name}.spec.ts`,
      code: `import { test, expect } from '@playwright/test';

test.describe('${route.path}', () => {
  test('should load successfully', async ({ page }) => {
    await page.goto('${config.baseUrl}${route.path}');
    await expect(page).toHaveURL('${config.baseUrl}${route.path}');
    await expect(page.locator('body')).toBeVisible();
  });

  test('should not have console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('${config.baseUrl}${route.path}');
    await page.waitForLoadState('networkidle');
    expect(errors).toHaveLength(0);
  });
});
`,
      description: `E2E test for route ${route.path}`,
      confidence: 0.8,
    });
  }

  for (const endpoint of context.apiEndpoints) {
    const name = endpoint.path.replace(/^\/api\//, '').replace(/\//g, '-');
    tests.push({
      filename: `${config.testDir}/api-${name}.spec.ts`,
      code: `import { test, expect } from '@playwright/test';

test.describe('API: ${endpoint.method} ${endpoint.path}', () => {
  test('should respond with valid status', async ({ request }) => {
    const response = await request.get('${config.baseUrl}${endpoint.path}');
    expect(response.status()).toBeLessThan(500);
  });
});
`,
      description: `API test for ${endpoint.method} ${endpoint.path}`,
      confidence: 0.75,
    });
  }

  if (tests.length === 0 && context.modifiedFiles.length > 0) {
    tests.push({
      filename: `${config.testDir}/smoke.spec.ts`,
      code: `import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('homepage loads successfully', async ({ page }) => {
    await page.goto('${config.baseUrl}');
    await expect(page.locator('body')).toBeVisible();
  });
});
`,
      description: 'Smoke test for modified components',
      confidence: 0.6,
    });
  }

  return tests;
}

// ─── Test writing & running ───

function writeTests(tests: GeneratedTest[], workDir: string): void {
  for (const test of tests) {
    const filePath = path.join(workDir, test.filename);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, test.code, 'utf-8');
    console.log(`Wrote test: ${test.filename}`);
  }
}

function runPlaywrightTest(testFile: string, config: TaskConfig, workDir: string): TestResult {
  const startTime = Date.now();
  try {
    const stdout = execFileSync('npx', ['playwright', 'test', testFile, '--reporter=json'], {
      cwd: workDir,
      encoding: 'utf-8',
      env: { ...process.env, BASE_URL: config.baseUrl, CI: 'true' },
      timeout: 120_000,
    });
    return {
      filename: testFile,
      passed: true,
      duration: Date.now() - startTime,
      stdout,
    };
  } catch (error: any) {
    return {
      filename: testFile,
      passed: false,
      duration: Date.now() - startTime,
      error: error.stderr || error.stdout || String(error),
      stdout: error.stdout,
    };
  }
}

// ─── Self-healing loop ───

async function healFailedTests(
  failed: { test: GeneratedTest; result: TestResult }[],
  context: ChangeContext,
  config: TaskConfig,
  workDir: string
): Promise<{ results: TestResult[]; healed: number }> {
  const results: TestResult[] = [];
  let healedCount = 0;

  for (const { test, result } of failed) {
    let currentTest = test;
    let currentResult = result;
    let wasHealed = false;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      console.log(`🔧 Self-healing ${test.filename} (attempt ${attempt}/${config.maxRetries})`);
      const healedTest = await callHealAPI(
        currentTest,
        currentResult.error || 'Unknown error',
        attempt,
        context,
        config
      );
      writeTests([healedTest], workDir);
      const healedResult = runPlaywrightTest(path.join(workDir, healedTest.filename), config, workDir);

      if (healedResult.passed) {
        console.log(`✅ ${test.filename} healed on attempt ${attempt}`);
        results.push(healedResult);
        healedCount++;
        wasHealed = true;
        break;
      }
      currentTest = healedTest;
      currentResult = healedResult;
    }

    if (!wasHealed) {
      console.log(`❌ ${test.filename} could not be healed after ${config.maxRetries} attempts`);
      results.push(currentResult);
    }
  }

  return { results, healed: healedCount };
}

// ─── PR Comment via Azure DevOps API ───

async function postPRComment(report: RunReport): Promise<void> {
  const { collectionUri, project, repoId, accessToken, prId } = getAzDoEnv();
  if (!prId || !accessToken) {
    tl.warning('Cannot post PR comment: missing PR ID or access token');
    return;
  }

  const statusEmoji = report.testsFailed === 0 ? '✅' : '⚠️';
  const duration = (report.duration / 1000).toFixed(1);

  let body = `## ${statusEmoji} GreenCI E2E Test Report\n\n`;
  body += `| Metric | Value |\n|--------|-------|\n`;
  body += `| Tests Generated | ${report.testsGenerated} |\n`;
  body += `| Tests Passed | ✅ ${report.testsPassed} |\n`;
  body += `| Tests Failed | ${report.testsFailed > 0 ? '❌' : '✅'} ${report.testsFailed} |\n`;
  if (report.testsHealed > 0) body += `| Tests Self-Healed | 🔧 ${report.testsHealed} |\n`;
  body += `| Duration | ${duration}s |\n\n`;

  if (report.tests.length > 0) {
    body += `### Test Results\n\n`;
    for (const t of report.tests) {
      const icon = t.passed ? '✅' : '❌';
      body += `- ${icon} \`${t.filename}\` (${(t.duration / 1000).toFixed(1)}s)\n`;
      if (!t.passed && t.error) {
        const preview = t.error.split('\n').slice(0, 5).join('\n');
        body += `  <details><summary>Error</summary>\n\n  \`\`\`\n  ${preview}\n  \`\`\`\n  </details>\n\n`;
      }
    }
  }

  if (report.committedFiles.length > 0) {
    body += `\n### 📝 Committed Files\n\n`;
    for (const f of report.committedFiles) body += `- \`${f}\`\n`;
  }

  body += `\n---\n*Generated by [GreenCI](https://greenci.ai) 🌱*\n`;

  const url = `${collectionUri}${project}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=7.1`;

  try {
    const resp = await azDoFetch(url, accessToken, {
      method: 'POST',
      body: JSON.stringify({
        comments: [{ parentCommentId: 0, content: body, commentType: 1 }],
        status: report.testsFailed === 0 ? 4 : 1, // 4 = closed, 1 = active
      }),
    });

    if (resp.ok) {
      console.log('💬 Posted PR comment successfully');
    } else {
      tl.warning(`Failed to post PR comment: ${resp.status} ${resp.statusText}`);
    }
  } catch (error) {
    tl.warning(`Failed to post PR comment: ${error}`);
  }
}

// ─── Git commit (for auto-commit) ───

function commitPassingTests(testFiles: string[], workDir: string): string[] {
  if (testFiles.length === 0) return [];

  try {
    for (const f of testFiles) {
      execSync(`git add "${f}"`, { cwd: workDir });
    }
    execSync('git commit -m "🤖 GreenCI: Add AI-generated E2E tests"', { cwd: workDir });
    execSync('git push', { cwd: workDir });
    console.log(`📝 Committed and pushed ${testFiles.length} test file(s)`);
    return testFiles;
  } catch (error) {
    tl.warning(`Auto-commit failed: ${error}`);
    return [];
  }
}

// ─── Main ───

async function run(): Promise<void> {
  try {
    const config = getTaskConfig();
    const workDir = process.env['BUILD_SOURCESDIRECTORY'] || process.cwd();

    console.log('🌱 GreenCI Azure DevOps Task starting...');
    console.log(`Mode: ${config.mode}`);
    console.log(`Base URL: ${config.baseUrl}`);
    console.log(`Test dir: ${config.testDir}`);

    // 1. Get changed files
    console.log('📂 Fetching changed files...');
    const { accessToken } = getAzDoEnv();
    const allFiles = await getPRChangedFiles(accessToken);
    const testableFiles = filterTestableFiles(allFiles);
    console.log(`Found ${allFiles.length} changed files, ${testableFiles.length} testable`);

    if (testableFiles.length === 0) {
      console.log('No testable files changed. Skipping test generation.');
      tl.setVariable('testsGenerated', '0');
      tl.setVariable('testsPassed', '0');
      tl.setVariable('testsFailed', '0');
      return;
    }

    // 2. Build context
    console.log('🔍 Analyzing changes...');
    const changeContext = buildChangeContext(testableFiles);
    console.log(changeContext.summary);

    // 3. Generate tests
    console.log('🧪 Generating tests...');
    const startTime = Date.now();
    const generatedTests = await callGenerateAPI(changeContext, config);
    console.log(`Generated ${generatedTests.length} test(s)`);

    if (generatedTests.length === 0) {
      tl.setVariable('testsGenerated', '0');
      tl.setVariable('testsPassed', '0');
      tl.setVariable('testsFailed', '0');
      return;
    }

    // 4. Write and run tests
    writeTests(generatedTests, workDir);
    console.log('🏃 Running tests...');
    const initialResults = generatedTests.map((t) =>
      runPlaywrightTest(path.join(workDir, t.filename), config, workDir)
    );

    // 5. Self-heal failed tests
    const failedPairs = initialResults
      .map((result, i) => ({ test: generatedTests[i], result }))
      .filter(({ result }) => !result.passed);

    let healedCount = 0;
    let healedResults: TestResult[] = [];

    if (failedPairs.length > 0 && config.maxRetries > 0) {
      console.log(`🔧 Attempting to heal ${failedPairs.length} failed test(s)...`);
      const healing = await healFailedTests(failedPairs, changeContext, config, workDir);
      healedResults = healing.results;
      healedCount = healing.healed;
    }

    // 6. Compile report
    const passedInitial = initialResults.filter((r) => r.passed);
    const allResults = [...passedInitial, ...healedResults];
    const totalPassed = allResults.filter((r) => r.passed).length;
    const totalFailed = allResults.filter((r) => !r.passed).length;

    const report: RunReport = {
      testsGenerated: generatedTests.length,
      testsPassed: totalPassed,
      testsFailed: totalFailed,
      testsHealed: healedCount,
      filesChanged: testableFiles.map((f) => f.filename),
      duration: Date.now() - startTime,
      tests: allResults,
      committedFiles: [],
    };

    // 7. Auto-commit passing tests
    if (config.autoCommit && totalPassed > 0) {
      const passingFiles = allResults
        .filter((r) => r.passed)
        .map((r) => r.filename);
      report.committedFiles = commitPassingTests(passingFiles, workDir);
    }

    // 8. Post PR comment
    if (isPullRequest()) {
      await postPRComment(report);
    }

    // 9. Set output variables
    tl.setVariable('testsGenerated', String(report.testsGenerated));
    tl.setVariable('testsPassed', String(report.testsPassed));
    tl.setVariable('testsFailed', String(report.testsFailed));

    if (report.testsFailed > 0) {
      tl.warning(`${report.testsFailed} test(s) failed after self-healing attempts`);
    }

    console.log(`🌱 GreenCI complete: ${report.testsPassed}/${report.testsGenerated} tests passing`);
  } catch (error) {
    tl.setResult(tl.TaskResult.Failed, error instanceof Error ? error.message : String(error));
  }
}

run();
