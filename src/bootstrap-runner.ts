import * as core from '@actions/core';
import * as path from 'path';
import { ActionConfig, GeneratedTest, ILLMClient, SuspectedBug, TestResult } from './types';
import { parseJourneys, fetchPages } from './bootstrap-context';
import { needsAuthScaffold, writeAuthScaffold, loginPathFromJourneys, AUTH_SETUP_FILENAME } from './auth-scaffold';
import { readExistingTests, formatExistingTestsForAPI } from './existing-tests';
import { ensurePlaywright, ensurePlaywrightConfig, runTests, writeTests } from './test-runner';
import { healFailedTests } from './self-healer';
import { createBootstrapPR } from './git-ops';

export interface BootstrapOutcome {
  testsGenerated: number;
  testsPassed: number;
  testsFailed: number;
  testsHealed: number;
  prUrl: string | null;
}

/**
 * Bootstrap mode: build a foundational suite for an app with no tests.
 * Journeys (plain English) + rendered page HTML → generate → run → heal →
 * open a PR with the passing suite.
 */
export async function runBootstrap(
  config: ActionConfig,
  llmClient: ILLMClient,
  workDir: string,
  token: string,
  repo: { owner: string; repo: string },
): Promise<BootstrapOutcome> {
  if (!llmClient.bootstrapTests) {
    throw new Error(`The '${config.llmProvider}' provider does not support bootstrap mode.`);
  }

  const journeys = parseJourneys(config.journeys);
  core.info(`🧭 Bootstrapping suite for ${journeys.length} journey(s)`);

  core.info('📄 Capturing rendered pages for selector grounding...');
  const pages = await fetchPages(config.baseUrl, journeys);
  if (pages.length === 0) {
    core.warning(
      `Could not fetch any pages from ${config.baseUrl} — is your app running in CI? ` +
        'Generation will proceed but selectors will be less grounded.',
    );
  }

  const existing = readExistingTests(workDir, config.testDir);
  const existingTests = existing.length > 0 ? formatExistingTestsForAPI(existing) : undefined;

  const generatedTests = await llmClient.bootstrapTests(journeys, pages, config, existingTests);
  core.info(`Generated ${generatedTests.length} test file(s)`);
  if (generatedTests.length === 0) {
    return { testsGenerated: 0, testsPassed: 0, testsFailed: 0, testsHealed: 0, prUrl: null };
  }

  await writeTests(generatedTests, workDir, config.testDir);

  // Authenticated journeys: commit a ready-to-run login setup so the customer
  // only has to add two secrets (auth architecture option B).
  const withAuth = needsAuthScaffold(generatedTests);
  let authSetupPath: string | null = null;
  if (withAuth) {
    const loginPath = loginPathFromJourneys(journeys);
    authSetupPath = writeAuthScaffold(workDir, config.testDir, loginPath);
    core.info(`🔐 Authenticated journeys detected — wrote ${config.testDir}/${AUTH_SETUP_FILENAME} (login page: ${loginPath})`);
  }

  // Zero-test repos won't have Playwright or a config yet — set them up
  const installedPlaywright = await ensurePlaywright(workDir);
  const createdConfig = ensurePlaywrightConfig(workDir, config.baseUrl, config.testDir, withAuth);

  core.info('🏃 Running the bootstrap suite...');
  const initialResults = await runTests(generatedTests, config, workDir);

  const failedTests = initialResults
    .map((result, i) => ({ test: generatedTests[i], result }))
    .filter(({ result }) => !result.passed);

  let healed: GeneratedTest[] = [];
  let healedResults: TestResult[] = [];
  let suspectedBugs: SuspectedBug[] = [];
  let authBlocked: { filename: string; error?: string; kind: 'missing-session' | 'setup-failed' }[] = [];
  if (failedTests.length > 0 && config.maxRetries > 0) {
    core.info(`🔧 Healing ${failedTests.length} failing bootstrap test(s)...`);
    const healing = await healFailedTests(failedTests, emptyChangeContext(), config, llmClient, workDir);
    healed = healing.healed;
    healedResults = healing.results;
    suspectedBugs = healing.suspectedBugs;
    authBlocked = healing.authBlocked;
  }

  const allResults = [...initialResults.filter((r) => r.passed), ...healedResults];
  const passed = allResults.filter((r) => r.passed);
  const failed = allResults.filter((r) => !r.passed);

  // Commit the verified-passing suite, plus the auth scaffold + config when
  // authenticated journeys exist (so "add 2 secrets and re-run" works).
  const passingFiles = passed.map((r) => path.join(workDir, config.testDir, r.filename));
  const commitFiles = [...passingFiles];
  if (withAuth && authSetupPath && passingFiles.length > 0) {
    commitFiles.push(authSetupPath);
    if (createdConfig) commitFiles.push(path.join(workDir, 'playwright.config.ts'));
  }

  let prUrl: string | null = null;
  if (config.autoCommit && token && passingFiles.length > 0) {
    const body = buildBootstrapPRBody(journeys, passed, failed, healed, suspectedBugs, {
      installedPlaywright,
      createdConfig,
      baseUrl: config.baseUrl,
      testDir: config.testDir,
      authBlocked,
      withAuth,
    });
    const result = await createBootstrapPR(token, repo.owner, repo.repo, commitFiles, workDir, body);
    prUrl = result.prUrl;
  } else if (passingFiles.length === 0) {
    core.warning('No bootstrap tests passed — nothing committed. See the run log for failures.');
  }

  return {
    testsGenerated: generatedTests.length,
    testsPassed: passed.length,
    testsFailed: failed.length,
    testsHealed: healed.length,
    prUrl,
  };
}

function emptyChangeContext() {
  return { routes: [], components: [], apiEndpoints: [], modifiedFiles: [], summary: 'bootstrap' };
}

function buildBootstrapPRBody(
  journeys: string[],
  passed: TestResult[],
  failed: TestResult[],
  healed: GeneratedTest[],
  suspectedBugs: SuspectedBug[],
  setup: {
    installedPlaywright: boolean;
    createdConfig: boolean;
    baseUrl: string;
    testDir: string;
    authBlocked: { filename: string; error?: string; kind: 'missing-session' | 'setup-failed' }[];
    withAuth: boolean;
  },
): string {
  let body = '## 🌱 Foundational E2E suite generated by GreenCI\n\n';
  body += 'This PR contains the **verified-passing** starter suite for your critical journeys. ';
  body += 'Review it like any code: the tests are plain Playwright and fully yours.\n\n';

  body += '### Journeys covered\n';
  body += journeys.map((j) => `- ${j}`).join('\n') + '\n\n';

  body += `### Results\n| | |\n|---|---|\n| Passing (committed) | ✅ ${passed.length} |\n`;
  if (healed.length > 0) body += `| Self-healed before passing | 🔧 ${healed.length} |\n`;
  if (failed.length > 0) body += `| Failing (NOT committed) | ❌ ${failed.length} |\n`;
  body += '\n';

  if (suspectedBugs.length > 0) {
    body += '### 🚨 Possible app bugs found during bootstrap\n';
    for (const bug of suspectedBugs) {
      body += `- \`${bug.filename}\` — ${bug.reasoning}\n`;
    }
    body += '\n';
  }

  const authNames = new Set(setup.authBlocked.map((a) => a.filename));
  const otherFailed = failed.filter((f) => !authNames.has(f.filename));

  const signInFailed = setup.authBlocked.filter((a) => a.kind === 'setup-failed');
  const needsCreds = setup.authBlocked.filter((a) => a.kind === 'missing-session');

  if (signInFailed.length > 0) {
    body += '### 🔐 ' + signInFailed.length + ' journey(s) blocked: sign-in did not complete\n';
    body += signInFailed.map((a) => `- \`${a.filename}\``).join('\n') + '\n\n';
    body += 'The login setup (`' + setup.testDir + '/auth.setup.ts`) ran but never got past the login page, so these journeys could not run. Likely causes, in order:\n\n';
    body += '- The test credentials are wrong, or the account is locked/unverified\n';
    body += '- Your login endpoint is **rate-limiting** the run (CI signs in repeatedly from one IP)\n';
    body += '- Sign-in is genuinely broken — worth checking by hand\n\n';
    body += 'The exact error is in the workflow log under the `[setup]` project. These tests were **not** rewritten to pass around the problem.\n\n';
  }

  if (needsCreds.length > 0) {
    body += '### 🔐 ' + needsCreds.length + ' journey(s) need login credentials\n';
    body += needsCreds.map((a) => `- \`${a.filename}\``).join('\n') + '\n\n';
    body += 'A ready-made login setup (`' + setup.testDir + '/auth.setup.ts`) is included in this PR. To activate these tests:\n\n';
    body += '1. Create a **dedicated test user** in your app (never a real account)\n';
    body += '2. Add two repository secrets (Settings → Secrets and variables → Actions): `TEST_USER_EMAIL` and `TEST_USER_PASSWORD`\n';
    body += '3. Expose them on the GreenCI workflow step:\n\n';
    body += '```yaml\n        env:\n          TEST_USER_EMAIL: ${{ secrets.TEST_USER_EMAIL }}\n          TEST_USER_PASSWORD: ${{ secrets.TEST_USER_PASSWORD }}\n```\n\n';
    body += '4. Re-run the **GreenCI Bootstrap** workflow — a follow-up PR will include the authenticated journeys.\n\n';
    body += 'Your credentials stay in your repo and your CI runner — they never touch GreenCI.\n\n';
  }

  if (otherFailed.length > 0) {
    body += '### Failing tests (see the workflow log)\n';
    body += otherFailed.map((f) => `- \`${f.filename}\``).join('\n') + '\n\n';
    body += 'Common causes: pages that need seeded data, or flows the captured pages did not cover.\n\n';
  }

  if (setup.installedPlaywright || setup.createdConfig) {
    body += '### One-time setup to run these locally\n';
    body += 'This repo didn\'t have Playwright yet (GreenCI installed it just for this run):\n\n';
    body += '```bash\nnpm install -D @playwright/test\nnpx playwright install chromium\n```\n\n';
    if (setup.createdConfig) {
      body += `And add a \`playwright.config.ts\`:\n\n\`\`\`ts\nimport { defineConfig } from '@playwright/test';\n\nexport default defineConfig({\n  testDir: '${setup.testDir}',\n  use: { baseURL: '${setup.baseUrl}' },\n});\n\`\`\`\n\n`;
    }
    body += `Then run the suite with \`npx playwright test\`.\n\n`;
  }

  body += '---\n*Generated by [GreenCI](https://greenci.ai) 🌱 — future PRs will keep this suite up to date automatically.*\n';
  return body;
}
