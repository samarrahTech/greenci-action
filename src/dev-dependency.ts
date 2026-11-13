import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const PACKAGE = '@playwright/test';

/** A file this module changed, with what it held before, so a caller can prove the change is the only difference. */
export interface ChangedFile {
  /** Absolute path. */
  path: string;
  /** Content before the change. */
  before: Buffer;
}

export type DependencyOutcome =
  /** package.json (and the lockfile, when the repo has one) now declare the dependency. */
  | { status: 'saved'; files: ChangedFile[] }
  /** The repo already declares it: nothing to do, and nothing to tell the customer to add. */
  | { status: 'declared'; files: [] }
  /** Left alone on purpose or after a failed attempt: the PR keeps the manual instructions. */
  | { status: 'manual'; files: [] };

const MANUAL: DependencyOutcome = { status: 'manual', files: [] };

interface Plan {
  tool: string;
  args: string[];
  /** The lockfile that must change along with package.json, if the repo has one. */
  lockfile: string | null;
}

const has = (workDir: string, file: string) => fs.existsSync(path.join(workDir, file));

function readPackageJson(workDir: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function declared(workDir: string): string | undefined {
  const pkg = readPackageJson(workDir);
  return pkg?.devDependencies?.[PACKAGE] ?? pkg?.dependencies?.[PACKAGE];
}

function installedVersion(workDir: string): string | null {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(workDir, 'node_modules', '@playwright', 'test', 'package.json'), 'utf-8')).version;
    return typeof version === 'string' && /^\d+\.\d+\.\d+[\w.-]*$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * How to add the dependency in this repo, or the reason not to try. Every
 * supported route changes package.json and the lockfile only, installs
 * nothing, and runs no package scripts: it executes in the customer's
 * checkout with the action's environment.
 */
function plan(workDir: string, version: string): Plan | string {
  const spec = `${PACKAGE}@${version}`;
  const yarnBerry = has(workDir, '.yarnrc.yml') || /^yarn@(?!1\.)/.test(String(readPackageJson(workDir)?.packageManager ?? ''));

  if (has(workDir, 'pnpm-lock.yaml')) {
    // pnpm refuses to add to a workspace root without -w.
    return { tool: 'pnpm', lockfile: 'pnpm-lock.yaml', args: ['add', '-D', spec, '--lockfile-only', '--ignore-scripts', ...(has(workDir, 'pnpm-workspace.yaml') ? ['-w'] : [])] };
  }
  if (has(workDir, 'yarn.lock')) {
    // Yarn 1 has no lockfile-only mode: `yarn add` installs the whole project.
    if (!yarnBerry) return 'Yarn 1 cannot update its lockfile without a full install';
    // Plug'n'Play and zero-install repos also commit .pnp.cjs and .yarn/cache, which a lockfile-only add leaves behind.
    if (has(workDir, '.pnp.cjs') || has(workDir, '.pnp.loader.mjs') || has(workDir, path.join('.yarn', 'cache'))) {
      return 'this Yarn repo commits Plug\'n\'Play or cache files that must change together with the lockfile';
    }
    return { tool: 'yarn', lockfile: 'yarn.lock', args: ['add', '-D', spec, '--mode=update-lockfile'] };
  }
  // The bootstrap commit goes through the Git API as text; Bun's old binary lockfile cannot travel that way.
  if (has(workDir, 'bun.lockb')) return "Bun's binary lockfile (bun.lockb) cannot be committed by GreenCI";
  if (has(workDir, 'bun.lock')) {
    return { tool: 'bun', lockfile: 'bun.lock', args: ['add', '-d', spec, '--lockfile-only', '--ignore-scripts'] };
  }
  for (const lockfile of ['package-lock.json', 'npm-shrinkwrap.json']) {
    if (has(workDir, lockfile)) {
      return { tool: 'npm', lockfile, args: ['install', '-D', spec, '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'] };
    }
  }
  // No lockfile here. If this is not the repository root, the lockfile may
  // live further up (a monorepo package), and package.json alone would break
  // the install there.
  if (!has(workDir, '.git')) return 'no lockfile was found next to package.json and this is not the repository root';
  // No lockfile in the repo: declare the dependency and do not invent one.
  return { tool: 'npm', lockfile: null, args: ['pkg', 'set', `devDependencies.${PACKAGE}=^${version}`] };
}

/**
 * The line of a lockfile that names its format. A package manager newer than
 * the one the repo uses can succeed and rewrite the whole file in a new
 * format, which breaks the customer's own `npm ci` / `--frozen-lockfile`.
 */
function lockfileFormat(name: string, content: Buffer | undefined): string {
  if (!content) return '';
  const text = content.toString('utf-8');
  const marker =
    name === 'yarn.lock'
      ? /^# yarn lockfile v\d+|^__metadata:\s*\n\s*version: \S+/m
      : name === 'pnpm-lock.yaml'
        ? /^lockfileVersion: \S+/m
        : /"lockfileVersion":\s*\d+/;
  return marker.exec(text)?.[0] ?? '';
}

/**
 * A bootstrap PR on a repo that never had Playwright used to commit specs
 * that import `@playwright/test` and leave the dependency out. Once merged,
 * `tsc` and lint over the test folder broke until someone ran the install
 * line from the PR body. Add the dependency properly instead: package.json
 * and the lockfile together (package.json alone breaks `npm ci`), with the
 * repo's own package manager, at the version the tests just passed on.
 *
 * Careful by design, because it edits files the customer owns: anything
 * unexpected (a failed command, a lockfile rewritten in another format, a
 * workspace catalog entry, any other tracked file touched) puts every file
 * back and returns `manual`, and the PR keeps the install instructions. A
 * bootstrap must never fail, or commit a surprise, over this.
 */
export async function savePlaywrightDevDependency(workDir: string): Promise<DependencyOutcome> {
  if (!has(workDir, 'package.json')) return MANUAL;
  if (declared(workDir)) return { status: 'declared', files: [] };
  const version = installedVersion(workDir);
  if (!version) return MANUAL;

  const route = plan(workDir, version);
  if (typeof route === 'string') {
    core.info(`📦 ${PACKAGE} not added to devDependencies: ${route}. The PR explains how to add it by hand`);
    return MANUAL;
  }

  // Everything the command may write. Files beyond package.json and the
  // lockfile are watched only to detect a change we do not know how to commit.
  const committable = ['package.json', ...(route.lockfile ? [route.lockfile] : [])];
  const watched = [...committable, 'pnpm-workspace.yaml', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock'].filter((f, i, all) => all.indexOf(f) === i);
  const before = new Map(watched.map((f) => [f, has(workDir, f) ? fs.readFileSync(path.join(workDir, f)) : null]));
  const restore = () => {
    for (const [file, content] of before) {
      try {
        if (content === null) fs.rmSync(path.join(workDir, file), { force: true });
        else fs.writeFileSync(path.join(workDir, file), content);
      } catch {
        // Best effort: the run goes on with whatever is on disk.
      }
    }
  };
  const giveUp = (why: string): DependencyOutcome => {
    restore();
    core.warning(`Could not add ${PACKAGE} to devDependencies with ${route.tool}: ${why}. The PR explains how to add it by hand`);
    return MANUAL;
  };

  let output = '';
  let code: number;
  try {
    code = await exec.exec(route.tool, route.args, {
      cwd: workDir,
      silent: true,
      ignoreReturnCode: true,
      listeners: { stdout: (d: Buffer) => (output += d.toString()), stderr: (d: Buffer) => (output += d.toString()) },
    });
  } catch (err) {
    return giveUp(err instanceof Error ? err.message : String(err));
  }
  if (code !== 0) {
    const reason = output.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 400);
    return giveUp(`exit ${code}${reason ? ` (${reason})` : ''}`);
  }

  const range = declared(workDir);
  if (!range) return giveUp('the command succeeded but package.json does not declare it');
  // A pnpm catalog reference points at pnpm-workspace.yaml, which this PR would not carry.
  if (!/^[\^~]?\d/.test(range)) return giveUp(`it was written as "${range}", which depends on other files`);

  const now = (f: string) => (has(workDir, f) ? fs.readFileSync(path.join(workDir, f)) : null);
  const differs = (f: string) => {
    const was = before.get(f) ?? null;
    const is = now(f);
    return was === null || is === null ? was !== is : !was.equals(is);
  };
  const stray = watched.filter((f) => !committable.includes(f) && differs(f));
  if (stray.length > 0) return giveUp(`it also changed ${stray.join(', ')}`);
  if (route.lockfile) {
    if (!differs(route.lockfile)) return giveUp(`${route.lockfile} did not change`);
    const was = lockfileFormat(route.lockfile, before.get(route.lockfile) ?? undefined);
    const is = lockfileFormat(route.lockfile, now(route.lockfile) ?? undefined);
    if (was !== is) return giveUp(`it rewrote ${route.lockfile} in a different format (${was || 'unknown'} → ${is || 'unknown'}); the runner's ${route.tool} is not the version this repo uses`);
  }

  const files = committable.filter(differs).map((f) => ({ path: path.join(workDir, f), before: before.get(f) as Buffer }));
  core.info(`📦 Added ${PACKAGE}@${version} to devDependencies with ${route.tool} (${committable.join(', ')})`);
  return { status: 'saved', files };
}

/** The id Git gives this content as a blob: what the GitHub API reports as a file's `sha`. */
export function gitBlobSha(content: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/** Put files back as they were: for a caller that decides, after the fact, not to commit the change. */
export function restoreFiles(files: ChangedFile[]): void {
  for (const file of files) {
    try {
      fs.writeFileSync(file.path, file.before);
    } catch {
      // Best effort: nothing else depends on it.
    }
  }
}
