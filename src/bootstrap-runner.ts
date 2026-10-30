import * as core from '@actions/core';
import * as path from 'path';
import { ActionConfig, GeneratedTest, ILLMClient, SuspectedBug, TestResult } from './types';
import { parseJourneys, fetchPages } from './bootstrap-context';
import { needsAuthScaffold, writeAuthScaffold, loginPathFromJourneys, AUTH_SETUP_FILENAME, type AuthFailureKind } from './auth-scaffold';
import { readExistingTests, formatExistingTestsForAPI, type RenamedTest } from './existing-tests';
import { ensurePlaywright, ensurePlaywrightConfig, ensureAuthSession, runTests, writeTests, type AuthSessionResult, type AuthSessionStatus, type ProtectExisting } from './test-runner';
import { healFailedTests } from './self-healer';
import { createBootstrapPR } from './git-ops';
import { resolveTestPath } from './safe-paths';
import { rejectTautologies, renderRejectedSection, type RejectedTest } from './assertion-lint';

export interface BootstrapOutcome {
  testsGenerated: number;
  testsPassed: number;
  testsFailed: number;
  testsHealed: number;
  prUrl: string | null;
  /** Generated specs dropped by the tautology lint (see assertion-lint.ts). */
  rejected: RejectedTest[];
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

  const proposed = (await llmClient.bootstrapTests(journeys, pages, config, existingTests)).filter((t) => {
    // The login setup is ours (or the customer's), never model output: a
    // generated file under that name would otherwise be run as the sign-in
    // step and win over the template.
    if (path.basename(t.filename) === AUTH_SETUP_FILENAME) {
      core.warning(`Dropping generated ${t.filename}: ${AUTH_SETUP_FILENAME} is provided by the pipeline`);
      return false;
    }
    return true;
  });
  // A spec that cannot fail would be committed as "passing" and read by the
  // customer as proof the suite is hollow. Drop it before it touches disk.
  const { kept: generatedTests, rejected } = rejectTautologies(proposed);
  for (const r of rejected) {
    core.warning(`🚫 Rejected ${r.filename}: ${r.reason}`);
  }
  core.info(`Generated ${generatedTests.length} test file(s)`);
  if (generatedTests.length === 0) {
    if (rejected.length > 0) {
      // Nothing to open a PR with, so the log is the only place this can go.
      core.warning(
        `All ${rejected.length} generated spec(s) were discarded because none contained an assertion that could fail. ` +
          'Nothing was written. Re-run the bootstrap, or make the journeys more concrete (name the thing the user should see).',
      );
    }
    return { testsGenerated: 0, testsPassed: 0, testsFailed: 0, testsHealed: 0, prUrl: null, rejected };
  }

  // Never rewrite a spec the customer already has (see ProtectExisting).
  const protect: ProtectExisting = { owned: new Set(), renamed: [] };
  await writeTests(generatedTests, workDir, config.testDir, protect);

  // Authenticated journeys: commit a ready-to-run login setup so the customer
  // only has to add two secrets (auth architecture option B).
  const withAuth = needsAuthScaffold(generatedTests);
  let authSetupPath: string | null = null;
  let authSetupCreated = false;
  if (withAuth) {
    const loginPath = loginPathFromJourneys(journeys);
    const scaffold = writeAuthScaffold(workDir, config.testDir, loginPath);
    authSetupPath = scaffold.path;
    authSetupCreated = scaffold.created;
    core.info(
      scaffold.created
        ? `🔐 Authenticated journeys detected — wrote ${config.testDir}/${AUTH_SETUP_FILENAME} (login page: ${loginPath})`
        : `🔐 Authenticated journeys detected — keeping your existing ${config.testDir}/${AUTH_SETUP_FILENAME} (not overwritten)`,
    );
  }

  // Zero-test repos won't have Playwright or a config yet — set them up
  const installedPlaywright = await ensurePlaywright(workDir);
  const createdConfig = ensurePlaywrightConfig(workDir, config.baseUrl, config.testDir, withAuth);

  // Specs run one file at a time, so produce the session up front instead of
  // relying on the customer's config to route each new spec through setup.
  const authSession: AuthSessionResult | null = withAuth ? await ensureAuthSession(workDir, config) : null;

  core.info('🏃 Running the bootstrap suite...');
  const initialResults = await runTests(generatedTests, config, workDir);

  const failedTests = initialResults
    .map((result, i) => ({ test: generatedTests[i], result }))
    .filter(({ result }) => !result.passed);

  let healed: GeneratedTest[] = [];
  let healedResults: TestResult[] = [];
  let suspectedBugs: SuspectedBug[] = [];
  let authBlocked: { filename: string; error?: string; kind: AuthFailureKind }[] = [];
  // Even with healing disabled (maxRetries 0) the auth classification is
  // deterministic and free — it decides what the PR tells the customer.
  if (failedTests.length > 0) {
    if (config.maxRetries > 0) core.info(`🔧 Healing ${failedTests.length} failing bootstrap test(s)...`);
    const healing = await healFailedTests(failedTests, emptyChangeContext(), config, llmClient, workDir, protect);
    healed = healing.healed;
    healedResults = healing.results;
    suspectedBugs = healing.suspectedBugs;
    authBlocked = healing.authBlocked;
  }

  // The sign-in pass knows WHY no session exists; the per-spec classifier only
  // sees the ENOENT. A setup that ran and failed is a sign-in problem, not a
  // wiring problem — report it as such, with the setup's own output.
  if (authSession?.status === 'failed') {
    authBlocked = authBlocked.map((a) =>
      a.kind === 'setup-not-run' ? { ...a, kind: 'setup-failed' as const, error: authSession.output } : a,
    );
  }

  const allResults = [...initialResults.filter((r) => r.passed), ...healedResults];
  const passed = allResults.filter((r) => r.passed);
  const failed = allResults.filter((r) => !r.passed);

  // Commit the verified-passing suite, plus the auth scaffold + config when
  // authenticated journeys exist (so "add 2 secrets and re-run" works).
  // Last gate before these paths become a commit: re-resolve rather than
  // trusting that the name still matches what writeTests validated.
  const passingFiles = passed.flatMap((r) => {
    try {
      return [resolveTestPath(workDir, config.testDir, r.filename).absolute];
    } catch (err) {
      core.warning(err instanceof Error ? err.message : String(err));
      return [];
    }
  });
  const commitFiles = [...passingFiles];
  if (withAuth && passingFiles.length > 0) {
    // Only a scaffold THIS run wrote is ours to commit; the customer's own
    // auth.setup.ts is already in their tree.
    if (authSetupPath && authSetupCreated) commitFiles.push(authSetupPath);
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
      authSetupStatus: authSession?.status,
      authSetupOutput: authSession?.output,
      renamed: protect.renamed,
      rejected,
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
    rejected,
  };
}

function emptyChangeContext() {
  return { routes: [], components: [], apiEndpoints: [], modifiedFiles: [], summary: 'bootstrap' };
}

export function buildBootstrapPRBody(
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
    authBlocked: { filename: string; error?: string; kind: AuthFailureKind }[];
    withAuth: boolean;
    authSetupStatus?: AuthSessionStatus;
    authSetupOutput?: string;
    renamed?: RenamedTest[];
    rejected?: RejectedTest[];
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

  const renamedCommitted = (setup.renamed ?? []).filter((r) => passed.some((p) => p.filename === r.to));
  if (renamedCommitted.length > 0) {
    body += '### ✋ Kept your existing tests\n';
    body += 'These journeys produced a file with the same name as a test already in your repo. GreenCI never overwrites your tests, so the new one was committed alongside it. Diff the pair and keep the one you prefer:\n\n';
    body += renamedCommitted.map((r) => `- \`${r.from}\` (yours) → \`${r.to}\` (generated)`).join('\n') + '\n\n';
  }

  body += renderRejectedSection(setup.rejected);

  const authNames = new Set(setup.authBlocked.map((a) => a.filename));
  const otherFailed = failed.filter((f) => !authNames.has(f.filename));

  const signInFailed = setup.authBlocked.filter((a) => a.kind === 'setup-failed');
  const needsCreds = setup.authBlocked.filter((a) => a.kind === 'missing-session');
  const notRun = setup.authBlocked.filter((a) => a.kind === 'setup-not-run');

  if (signInFailed.length > 0) {
    body += '### 🔐 ' + signInFailed.length + ' journey(s) blocked: sign-in did not complete\n';
    body += signInFailed.map((a) => `- \`${a.filename}\``).join('\n') + '\n\n';
    body += 'The login setup (`' + setup.testDir + '/auth.setup.ts`) ran but never got past the login page, so these journeys could not run. Likely causes, in order:\n\n';
    body += '- The test credentials are wrong, or the account is locked/unverified\n';
    body += '- Your login endpoint is **rate-limiting** the run (CI signs in repeatedly from one IP)\n';
    body += '- Sign-in is genuinely broken — worth checking by hand\n\n';
    if (setup.authSetupOutput) {
      body += 'The sign-in step (“Signing in once via auth.setup.ts” in the workflow log) failed with:\n\n```\n' + setup.authSetupOutput.trim().substring(0, 1200) + '\n```\n\n';
    } else {
      body += 'The exact error is in the workflow log under the `[setup]` project. ';
    }
    body += 'These tests were **not** rewritten to pass around the problem.\n\n';
  }

  if (notRun.length > 0) {
    body += '### 🔐 ' + notRun.length + ' journey(s) blocked: no signed-in session was available\n';
    body += notRun.map((a) => `- \`${a.filename}\``).join('\n') + '\n\n';
    body += '`TEST_USER_EMAIL` / `TEST_USER_PASSWORD` are set, but no `playwright/.auth/user.json` session existed when these specs ran.\n\n';
    if (setup.authSetupStatus === 'no-session-file') {
      body += 'The login setup (`' + setup.testDir + '/auth.setup.ts`) ran and exited cleanly but did not write `playwright/.auth/user.json` — it saves the session somewhere else, or skips on a condition of its own. ';
      body += 'Make it end with `await page.context().storageState({ path: \'playwright/.auth/user.json\' })`, or point the specs\' `test.use({ storageState })` at the path it does write.\n\n';
    } else if (setup.authSetupStatus === 'ok') {
      body += 'The login setup ran and wrote `playwright/.auth/user.json`, but the specs could not read it. Playwright resolves `storageState` relative to the directory holding `playwright.config.ts`: if your config lives in a subdirectory, save the session relative to that directory (or use an absolute path in both places).\n\n';
    } else {
      body += 'The login setup (`' + setup.testDir + '/auth.setup.ts`) did not run before these specs. ';
      if (setup.authSetupStatus === 'not-wired') {
        body += 'No project in your `playwright.config.ts` matches `auth.setup.ts`. ';
      }
      body += 'Add a `setup` project and make the project that runs these specs depend on it:\n\n';
      body += '```ts\n  projects: [\n    { name: \'setup\', testMatch: /auth\\.setup\\.ts/ },\n    { name: \'chromium\', dependencies: [\'setup\'] },\n  ],\n```\n\n';
    }
    body += 'Then re-run the **GreenCI Bootstrap** workflow — a follow-up PR will include the authenticated journeys.\n\n';
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
