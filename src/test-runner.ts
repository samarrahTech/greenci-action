import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';
import { ActionConfig, GeneratedTest, TestResult } from './types';
import { resolveTestPath, assertSafeToWrite, isInsideRoot, ALLOWED_SUFFIX } from './safe-paths';
import type { RenamedTest } from './existing-tests';
import { buildTestEnv } from './test-env';
import { AUTH_SETUP_FILENAME, STORAGE_STATE_PATH, hasTestCredentials } from './auth-scaffold';

/**
 * Zero-test repos (the bootstrap audience) usually have neither
 * @playwright/test nor browsers installed. Install what's missing so the
 * first run works out of the box. Returns true if anything was installed.
 */
export async function ensurePlaywright(workDir: string): Promise<boolean> {
  let installed = false;

  const hasPackage = fs.existsSync(path.join(workDir, 'node_modules', '@playwright', 'test'));
  if (!hasPackage) {
    core.info('📦 @playwright/test not found in this repo — installing (not saved to package.json)...');
    await exec.exec('npm', ['install', '--no-save', '--no-audit', '--no-fund', '@playwright/test'], {
      cwd: workDir,
      silent: true,
    });
    installed = true;
  }

  // `--with-deps` runs apt every time, even when the browser is already
  // cached, and has ranged from ~1 to ~10 minutes on GitHub-hosted runners.
  // If Chromium already launches, the system libraries are there: skip apt,
  // but still run the plain install, which returns in seconds when the
  // browser is cached and fetches anything else Playwright needs (ffmpeg).
  if (await chromiumLaunches(workDir)) {
    core.info('🌐 Chromium already launches — skipping system dependency install');
    await exec.exec('npx', ['playwright', 'install', 'chromium'], { cwd: workDir, silent: true });
    return installed;
  }

  // Pure runner time: log it so a slow run is attributable at a glance.
  const started = Date.now();
  core.info('🌐 Ensuring Chromium is installed for Playwright...');
  await exec.exec('npx', ['playwright', 'install', '--with-deps', 'chromium'], {
    cwd: workDir,
    silent: true,
  });
  core.info(`🌐 Chromium ready (${Math.round((Date.now() - started) / 1000)}s)`);

  return installed;
}

/**
 * Can @playwright/test launch Chromium right now? A ~1s probe that decides
 * whether the multi-minute install step is needed. Any failure (missing
 * browser, missing system library, timeout) means "install".
 */
const CHROMIUM_PROBE =
  "require('@playwright/test').chromium.launch({ timeout: 15000 })" +
  '.then((b) => b.close())' +
  // Print the launch error: without it the log can only say "no output".
  '.then(() => process.exit(0), (e) => { console.error(String(e).split("\\n")[0]); process.exit(1); })';

export async function chromiumLaunches(workDir: string): Promise<boolean> {
  let stderr = '';
  try {
    const code = await exec.exec('node', ['-e', CHROMIUM_PROBE], {
      cwd: workDir,
      silent: true,
      ignoreReturnCode: true,
      listeners: { stderr: (data: Buffer) => (stderr += data.toString()) },
    });
    if (code === 0) return true;
  } catch (err) {
    stderr = err instanceof Error ? err.message : String(err);
  }
  // Say why, or a cache that never takes effect looks like GreenCI ignoring it.
  const reason = stderr.split('\n').find((l) => l.trim()) ?? 'no output';
  core.info(`🌐 Chromium launch check failed (${reason.trim().slice(0, 200)}) — installing`);
  return false;
}

/** How the generated config can start the app for a local run. */
export interface DevServerHint {
  /** e.g. `npm run dev` */
  command: string;
}

/**
 * Best-effort guess at the command that starts the app, from package.json
 * scripts and the lockfile. Null when there is nothing to guess from — the
 * generated config then explains what to add instead of guessing wrong.
 */
export function detectDevServer(workDir: string): DevServerHint | null {
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf-8'));
    if (pkg && typeof pkg.scripts === 'object' && pkg.scripts) scripts = pkg.scripts;
  } catch {
    return null;
  }
  const script = ['dev', 'start', 'serve', 'preview'].find((s) => typeof scripts[s] === 'string');
  if (!script) return null;

  const has = (f: string) => fs.existsSync(path.join(workDir, f));
  const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
  // `npm start` is special-cased by npm; everything else needs `run`.
  const command = runner === 'npm' && script !== 'start' ? `npm run ${script}` : `${runner} ${script}`;
  return { command };
}

/** Single-quoted TS string literal: inputs come from action inputs and package.json. */
function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
}

/**
 * Source of the minimal config GreenCI writes (and shows in the PR body).
 * The webServer block is what makes `npx playwright test` work on a laptop:
 * without it, a local run fails with ECONNREFUSED unless the app happens to
 * be up. It is gated on `!process.env.CI`: in CI the app is already running
 * (the action sets CI=true for every Playwright run), and Playwright only
 * treats a 2xx/3xx/400-403 root response as "already up" — an app whose `/`
 * is a 404 would otherwise make every spec file spawn a second server.
 *
 * `devServer` null: nothing to start was found, say so in a comment.
 * `devServer` undefined: nobody looked (PR-body fallback) — no comment.
 */
export function playwrightConfigSource(opts: {
  baseUrl: string;
  testDir: string;
  withAuthSetup?: boolean;
  devServer?: DevServerHint | null;
}): string {
  const projects = opts.withAuthSetup
    ? `
  projects: [
    { name: 'setup', testMatch: /auth\\.setup\\.ts/ },
    { name: 'chromium', dependencies: ['setup'] },
  ],`
    : '';

  let webServer = '';
  if (opts.devServer) {
    webServer = `
  // Local runs: start the app if nothing is listening on baseURL yet. Skipped
  // in CI, where the app is started by the workflow before the tests run.
  // Adjust the command if your app starts differently.
  webServer: process.env.CI
    ? undefined
    : {
        command: ${q(opts.devServer.command)},
        url: ${q(opts.baseUrl)},
        reuseExistingServer: true,
        timeout: 120_000,
      },`;
  } else if (opts.devServer === null) {
    webServer = `
  // No start script was found in package.json, so local runs expect the app
  // to already be listening on baseURL. To let Playwright start it, add:
  //   webServer: { command: '<your start command>', url: ${q(opts.baseUrl)}, reuseExistingServer: true },`;
  }

  return `import { defineConfig } from '@playwright/test';

// Generated by GreenCI for this run. Add your own playwright.config.ts to customize.
export default defineConfig({
  testDir: ${q(opts.testDir)},${projects}
  use: {
    baseURL: ${q(opts.baseUrl)},
    trace: 'retain-on-failure',
  },${webServer}
});
`;
}

/**
 * Without a Playwright config, relative page.goto('/...') calls fail because
 * there is no baseURL. If the repo has no config, write a minimal one so the
 * generated tests run. Returns the source it wrote (callers show it to the
 * customer or commit it), or null when the repo already had a config.
 *
 * `devServer`: pass `detectDevServer(workDir)` when the file is for the
 * customer (bootstrap); `undefined` for a run-only config nobody will see.
 */
export function ensurePlaywrightConfig(
  workDir: string,
  baseUrl: string,
  testDir: string,
  withAuthSetup = false,
  devServer?: DevServerHint | null,
): string | null {
  const exists = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'].some((f) =>
    fs.existsSync(path.join(workDir, f)),
  );
  if (exists) return null;

  const config = playwrightConfigSource({ baseUrl, testDir, withAuthSetup, devServer });
  fs.writeFileSync(path.join(workDir, 'playwright.config.ts'), config, 'utf-8');
  core.info(
    `⚙️ No Playwright config found — wrote a minimal playwright.config.ts (baseURL: ${baseUrl}` +
      (devServer ? `, local webServer: ${devServer.command})` : devServer === null ? ', no start script in package.json for a local webServer)' : ')'),
  );
  return config;
}

/**
 * One Playwright invocation for a single file, with the action's credentials
 * stripped from the child environment (test-env.ts). Both the suite run and the
 * sign-in pass go through here so the env invariant lives in one place.
 */
export async function runPlaywrightFile(
  filter: string,
  workDir: string,
  config: ActionConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const exitCode = await exec.exec('npx', ['playwright', 'test', filter, '--reporter=line'], {
    cwd: workDir,
    // Model-authored code runs here — see test-env.ts. Never spread
    // process.env directly into this call.
    env: buildTestEnv(env, {
      BASE_URL: config.baseUrl,
      CI: 'true',
    }),
    silent: true,
    listeners: {
      stdout: (data) => {
        stdout += data.toString();
      },
      stderr: (data) => {
        stderr += data.toString();
      },
    },
    ignoreReturnCode: true,
  });
  return { exitCode, stdout, stderr };
}

export type AuthSessionStatus = 'ok' | 'skipped' | 'not-wired' | 'failed' | 'no-session-file';
export interface AuthSessionResult {
  status: AuthSessionStatus;
  /** Playwright output, for the failed / not-wired / no-session-file cases. */
  output?: string;
}

/**
 * Sign in before the suite runs. Specs are executed one file at a time
 * (see runTests), so Playwright project dependencies only produce the session
 * file when the customer's own config routes THAT spec through a project that
 * depends on the setup. A repo that already had a config (TME-web: authed specs
 * listed by name) never wrote playwright/.auth/user.json for a newly generated
 * spec, which then failed with ENOENT and was reported as "add the secrets".
 * Running the setup file explicitly makes the session exist regardless of how
 * the config is wired; the setup's own session reuse keeps a second run cheap.
 */
export async function ensureAuthSession(
  workDir: string,
  config: ActionConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthSessionResult> {
  if (!hasTestCredentials(env)) {
    core.info('🔐 TEST_USER_EMAIL / TEST_USER_PASSWORD not set — authenticated specs will be reported as needing credentials');
    return { status: 'skipped' };
  }

  core.info(`🔐 Signing in via ${AUTH_SETUP_FILENAME} so authenticated specs have a session...`);
  const { exitCode, stdout, stderr } = await runPlaywrightFile(AUTH_SETUP_FILENAME, workDir, config, env);
  const output = [stdout, stderr].filter(Boolean).join('\n');

  if (exitCode !== 0) {
    // Playwright's own "nothing matched the filter" error, at line start, so a
    // setup (or the app it drives) merely printing those words is not mistaken
    // for a wiring problem.
    if (/^\s*Error: No tests found/im.test(output)) {
      core.warning(
        `⚠️ No Playwright project in this repo's config runs ${AUTH_SETUP_FILENAME} — authenticated specs cannot get a session (see PR instructions)`,
      );
      return { status: 'not-wired', output };
    }
    core.warning(`❌ The login setup (${AUTH_SETUP_FILENAME}) could not sign in — authenticated specs will be reported as blocked`);
    core.info(`   Setup output:\n${output.substring(0, 800)}`);
    return { status: 'failed', output };
  }
  // Exit 0 is not proof of a session: a kept customer setup may save
  // elsewhere, or skip on a condition of its own. The file is the contract.
  if (!fs.existsSync(path.join(workDir, STORAGE_STATE_PATH))) {
    core.warning(
      `⚠️ ${AUTH_SETUP_FILENAME} finished without writing ${STORAGE_STATE_PATH} — authenticated specs cannot get a session (see PR instructions)`,
    );
    return { status: 'no-session-file', output };
  }
  core.info('✅ Signed in — session saved for the authenticated specs');
  return { status: 'ok' };
}

/**
 * Apps that rotate refresh tokens treat a rotated token presented again as
 * stolen and revoke the whole session. Every spec loads the same saved
 * session, so after one spec has rotated the token the next one replays a
 * dead token and is logged out, heal reruns included. Most apps do not rotate,
 * and signing in before every spec would cost them logins (and login rate
 * limits) for nothing, so runTests finds out by experiment: an authenticated
 * spec that fails looking signed out is re-run once with a fresh sign-in, and
 * if that passes the app rotates and every later authenticated spec signs in
 * first. A renewal
 * that fails puts the earlier session back and stops renewing for the run, so
 * a login endpoint that is rate-limiting the run is not hit again.
 */
export interface SessionRenewal {
  /** A fresh sign-in turned a failure into a pass: sign in before every authenticated spec. */
  rotates: boolean;
  /** A renewal failed; reuse the earlier session from here on. */
  stopped: boolean;
}

/** The spec loads a saved session file (an inline storageState object, such as an empty one for a logged-out spec, does not count). */
function loadsSavedSession(code: string): boolean {
  return /storageState\s*:\s*['"`]/.test(code);
}

/** The failure looks like the session was gone: sent to the sign-in page, or a 401. */
export function looksSignedOut(error: string | undefined): boolean {
  return !!error && (/\/(log-?in|sign-?in)\b/i.test(error) || /\b401\b/.test(error));
}

async function renewSession(workDir: string, config: ActionConfig, session: SessionRenewal): Promise<boolean> {
  const sessionFile = path.join(workDir, STORAGE_STATE_PATH);
  const previous = `${sessionFile}.prev`;
  let movedAside = false;
  let output = '';
  try {
    // Move the session aside so the setup's own session reuse cannot apply.
    if (fs.existsSync(sessionFile)) {
      fs.renameSync(sessionFile, previous);
      movedAside = true;
    }
    const run = await runPlaywrightFile(AUTH_SETUP_FILENAME, workDir, config);
    output = [run.stdout, run.stderr].filter(Boolean).join('\n');
    if (run.exitCode === 0 && fs.existsSync(sessionFile)) {
      try {
        fs.rmSync(previous, { force: true });
      } catch {
        // The new session is in place; a leftover .prev file is harmless.
      }
      return true;
    }
  } catch (err) {
    output = err instanceof Error ? err.message : String(err);
  }
  session.stopped = true;
  core.warning(`⚠️ Signing in again via ${AUTH_SETUP_FILENAME} failed — the rest of this run reuses the earlier session`);
  core.info(`   Setup output:\n${output.substring(0, 800)}`);
  try {
    if (movedAside) fs.renameSync(previous, sessionFile);
  } catch (err) {
    core.warning(`Could not restore the earlier session: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}

/**
 * Bootstrap must never rewrite a test the customer already has. The guard
 * lives at write time, against the filesystem, so it holds for every path
 * that reaches writeTests (generation, healing) and for files the prompt's
 * existing-tests list never saw (large files, other extensions). A file this
 * run wrote (`owned`) may be rewritten — that is how healing works.
 */
export interface ProtectExisting {
  /** Absolute paths written by this run; rewriting those is fine. */
  owned: Set<string>;
  /** Collisions with files that were already in the repo, for the PR body. */
  renamed: RenamedTest[];
}

function bootstrapName(relative: string, taken: (candidate: string) => boolean): string {
  const m = relative.match(ALLOWED_SUFFIX);
  const ext = m ? m[0] : '';
  const stem = relative.slice(0, relative.length - ext.length);
  let candidate = `${stem}-bootstrap${ext}`;
  for (let n = 2; taken(candidate); n++) candidate = `${stem}-bootstrap-${n}${ext}`;
  return candidate;
}

export async function writeTests(
  tests: GeneratedTest[],
  workDir: string,
  testDir: string = 'e2e',
  protect?: ProtectExisting,
): Promise<string[]> {
  const writtenFiles: string[] = [];

  for (const test of tests) {
    if (protect) {
      let resolved;
      try {
        resolved = resolveTestPath(workDir, testDir, test.filename);
      } catch {
        resolved = undefined; // the loop below reports and skips it
      }
      if (resolved && fs.existsSync(resolved.absolute) && !protect.owned.has(resolved.absolute)) {
        const root = path.resolve(workDir, testDir);
        const to = bootstrapName(resolved.relative, (c) => fs.existsSync(path.join(root, c)));
        core.warning(`✋ ${resolved.relative} already exists in this repo — writing the generated test as ${to} instead of overwriting it`);
        protect.renamed.push({ from: resolved.relative, to });
        test.filename = to;
      }
    }

    // The filename is model output and the model reads the PR diff, so it is
    // attacker-reachable — resolve it under the test dir or drop this test.
    // Skipping rather than throwing keeps one poisoned suggestion from failing
    // a run that has other, legitimate tests in it.
    let resolved;
    try {
      resolved = resolveTestPath(workDir, testDir, test.filename);
    } catch (err) {
      core.warning(err instanceof Error ? err.message : String(err));
      continue;
    }
    // Write the normalised name back so every downstream consumer (runTests,
    // the commit step, PR reporting) works from the value we validated.
    test.filename = resolved.relative;
    const filePath = resolved.absolute;
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Filesystem-level containment, after mkdir so the parent chain is real.
    // See safe-paths.ts: the lexical check alone is symlink-blind.
    try {
      assertSafeToWrite(path.resolve(workDir, testDir), filePath);
    } catch (err) {
      core.warning(err instanceof Error ? err.message : String(err));
      continue;
    }

    const isUpdate = fs.existsSync(filePath);
    fs.writeFileSync(filePath, test.code, 'utf-8');
    protect?.owned.add(filePath);
    writtenFiles.push(filePath);
    core.info(`${isUpdate ? '♻️ Updated' : '✨ Created'} test: ${test.filename}`);
  }

  return writtenFiles;
}

const MAX_PAGE_SNAPSHOT = 8_000;
const MAX_SNAPSHOT_LINE = 300;
const MIN_TREE_BUDGET = 1_000;

/**
 * When a spec fails, Playwright saves the page's accessibility tree to
 * error-context.md and prints "Error Context: <path>". That is the page the
 * spec actually reached: signed in, past client-side redirects, on routes
 * with ids no journey names. Bootstrap's own page capture is an anonymous
 * fetch of the journey paths, so without this the healer guesses the roles
 * and labels of every page behind login.
 *
 * One labelled block per failed test of this spec: retries print one path
 * each, so the last attempt wins, and a file filter that also matched another
 * spec does not get that spec's page in here. The printed paths come from
 * output model-written code can also print to, so only an error-context.md
 * inside the repo is read, and only its snapshot section leaves the runner.
 * The result is at most MAX_PAGE_SNAPSHOT characters.
 */
export function readPageSnapshot(output: string, workDir: string, specFile?: string): string | undefined {
  // Playwright dims this line when FORCE_COLOR is set in the workflow.
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  const byTest = new Map<string, string>();
  for (const [, rel] of plain.matchAll(/^\s*Error Context:\s*(\S*error-context\.md)\s*$/gm)) {
    const file = path.resolve(workDir, rel);
    if (path.basename(file) !== 'error-context.md' || !isInsideRoot(workDir, file)) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const sections = headingSections(text);
    const info = sections.get('Test info');
    const location = info?.match(/^- Location:\s*(\S+?):\d+/m)?.[1];
    if (specFile && location && !sameSpec(workDir, location, specFile)) continue;
    const tree = sections.get('Page snapshot')?.replace(/^```\w*\s*$/gm, '').trim();
    if (!tree) continue;
    const name = info?.match(/^- Name:\s*(.+)$/m)?.[1].trim() ?? path.basename(path.dirname(file)).replace(/-retry\d+$/, '');
    byTest.set(name, tree); // a later retry replaces the earlier attempt's page
  }
  if (byTest.size === 0) return undefined;
  const labelled = byTest.size > 1;
  const headers = [...byTest.keys()].map((name) => (labelled ? `# ${cut(name, 200)}\n` : ''));
  // Headers come out of the budget first, but every tree keeps a usable share.
  const budget = Math.max(
    MIN_TREE_BUDGET,
    Math.floor((MAX_PAGE_SNAPSHOT - headers.join('').length - 2 * (byTest.size - 1)) / byTest.size),
  );
  const blocks = [...byTest.values()].map((tree, i) => headers[i] + fitSnapshot(tree, budget));
  return cut(blocks.join('\n\n'), MAX_PAGE_SNAPSHOT);
}

/**
 * The spec Playwright reports is the one this run is for. Location is
 * relative to the Playwright root, which is usually the repo, so compare
 * whole paths and fall back to the path suffix.
 */
function sameSpec(workDir: string, location: string, specFile: string): boolean {
  const spec = path.resolve(workDir, specFile);
  return path.resolve(workDir, location) === spec || spec.endsWith(path.sep + path.normalize(location));
}

/** Cut to at most max UTF-16 units without leaving half a surrogate pair, which JSON sends as a lone \\ud83d. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
  return text.slice(0, end);
}

/** "# heading" sections of error-context.md, ignoring headings inside code fences (quoted page text). */
function headingSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let fence: string | null = null;
  let current: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (current !== null && !sections.has(current)) sections.set(current, body.join('\n'));
  };
  for (const line of text.split('\n')) {
    const marker = line.match(/^(`{3,})/)?.[1];
    if (marker && (fence === null || marker.length >= fence.length)) fence = fence === null ? marker : null;
    const heading = fence === null && !marker ? line.match(/^# (.+?)\s*$/)?.[1] : undefined;
    if (heading) {
      flush();
      current = heading;
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Fit a tree into budget characters. A failing locator usually points into a
 * dialog (portaled after main) or into main, while header and nav come first
 * in document order, so when the tree is too long: dialogs first, then main,
 * then the rest. Overlong lines (a paragraph of terms, a long URL) are
 * shortened so one line cannot push everything after it out.
 */
function fitSnapshot(tree: string, budget: number): string {
  const lines = tree
    .split('\n')
    .map((l) => (l.length > MAX_SNAPSHOT_LINE ? `${cut(l, MAX_SNAPSHOT_LINE)}…` : l));
  if (lines.join('\n').length <= budget) return lines.join('\n');

  // Priority order: each dialog subtree, then main's, then every other line.
  const priority: number[] = [];
  const seen = new Set<number>();
  const add = (i: number) => {
    if (seen.has(i)) return;
    seen.add(i);
    priority.push(i);
  };
  for (const re of [/^\s*- (?:alert)?dialog\b/, /^\s*- main\b/]) {
    lines.forEach((line, start) => {
      if (!re.test(line)) return;
      const indent = line.search(/\S/);
      add(start);
      for (let i = start + 1; i < lines.length && lines[i].search(/\S/) > indent; i++) add(i);
    });
  }
  lines.forEach((_, i) => add(i));

  const marker = '\n… (truncated)';
  const kept: number[] = [];
  let size = 0;
  for (const i of priority) {
    if (size + lines[i].length + 1 > budget - marker.length) break;
    kept.push(i);
    size += lines[i].length + 1;
  }
  // Back in document order, so nesting still reads as a tree.
  return kept.sort((a, b) => a - b).map((i) => lines[i]).join('\n') + marker;
}

async function runSpec(test: GeneratedTest, filePath: string, config: ActionConfig, workDir: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    // Pass just the filename as a regex filter — Playwright matches against absolute paths
    const basename = path.basename(filePath);
    const { exitCode, stdout, stderr } = await runPlaywrightFile(basename, workDir, config);

    const duration = Date.now() - startTime;
    const passed = exitCode === 0;

    if (passed) {
      core.info(`✅ ${test.filename} passed (${duration}ms)`);
    } else {
      core.warning(`❌ ${test.filename} failed (${duration}ms)`);
      // Log stderr first (usually has the real error), then stdout
      const errorOutput = [stderr, stdout].filter(Boolean).join('\n');
      const errorSnippet = errorOutput.substring(0, 800);
      if (errorSnippet) {
        core.info(`   Error output:\n${errorSnippet}`);
      }
    }
    if (passed) return { filename: test.filename, passed, duration, stdout };
    return {
      filename: test.filename,
      passed,
      duration,
      error: stderr || stdout,
      stdout,
      pageSnapshot: readPageSnapshot(`${stdout}\n${stderr}`, workDir, path.relative(workDir, filePath)),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    core.warning(`❌ ${test.filename} errored: ${error}`);
    return {
      filename: test.filename,
      passed: false,
      duration,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runTests(
  tests: GeneratedTest[],
  config: ActionConfig,
  workDir: string,
  session?: SessionRenewal,
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const test of tests) {
    // Independent of writeTests' check: a test can reach runTests without
    // having been written this run (healed reruns, callers we don't control).
    let filePath: string;
    try {
      filePath = resolveTestPath(workDir, config.testDir, test.filename).absolute;
    } catch (err) {
      core.warning(err instanceof Error ? err.message : String(err));
      results.push({
        filename: test.filename,
        passed: false,
        duration: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const authed = session !== undefined && !session.stopped && loadsSavedSession(test.code);
    if (authed && session.rotates) await renewSession(workDir, config, session);
    let result = await runSpec(test, filePath, config, workDir);
    if (authed && !result.passed && looksSignedOut(`${result.error ?? ''}\n${result.stdout ?? ''}`) && !session.rotates && !session.stopped) {
      core.info(`🔐 ${test.filename}: signing in again and re-running it once, in case the shared session was revoked`);
      if (await renewSession(workDir, config, session)) {
        result = await runSpec(test, filePath, config, workDir);
        if (result.passed) {
          session.rotates = true;
          core.info('🔐 It passed with a fresh session, so this app rotates sessions: each authenticated spec now signs in first');
        }
      }
    }
    results.push(result);
  }

  return results;
}

export function cleanupTests(filePaths: string[]): void {
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
