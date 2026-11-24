import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isInsideRoot, realPathOrSelf } from './safe-paths';

/**
 * Git and the job token on Azure Pipelines.
 *
 * `checkout` with `persistCredentials: true` stores the job token in the
 * repository's git config as an `http.<url>.extraheader`
 * ("AUTHORIZATION: bearer ..."). Model-written tests run with that
 * repository as their working directory, so taking the token out of their
 * environment is not enough: `git config --get-regexp extraheader` reads it.
 *
 * removePersistedCredentials deletes the header before the first generated
 * test runs and does not put it back. Restoring it at the end of the task
 * would hand it to any process a test left running, and a task the agent
 * kills could not restore it anyway. The task itself never needs the header:
 * it commits through the REST API (see azure-commit.ts). A later step that
 * needs git authentication must pass $(System.AccessToken) itself.
 *
 * It cleans the config of the repository checked out at the task's working
 * directory and of each checked-out submodule (as `git submodule foreach`
 * lists them): the shared config, files it includes, and config.worktree. A
 * header in an included file outside .git is named in a warning, not edited:
 * that file may be shared with other repositories. A file included only under
 * an includeIf condition is not read; a warning names the config that has one.
 * In a linked worktree the shared config is the one every worktree of that
 * repository reads, so the header goes for all of them; other worktrees'
 * config.worktree files are not touched. Submodules that are not checked out
 * are not listed by git and are not checked.
 *
 * This narrows what a hostile test can reach; it is not a sandbox. The safe
 * setup is `persistCredentials: false`.
 *
 * No dependency on the Azure task library: unit-tested with real git.
 */

const EXTRAHEADER = '^http\\.(.*\\.)?extraheader$';

export interface PersistedHeader {
  key: string;
  value: string;
}

type Warn = (message: string) => void;

function git(workDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: workDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

interface StoredHeader {
  /** Real path of the config file the header is written in. */
  file: string;
  key: string;
  value: string;
}

/**
 * Headers git reads from one config (scope: ['--local'] or ['--file', path]),
 * following its include.path entries, each with the file it is written in.
 * Run in the repository's top level: git prints origins relative to it.
 * Throws when git could not answer at all: the caller must not read that as
 * "nothing stored".
 */
function readStoredHeaders(topLevel: string, scope: string[]): StoredHeader[] {
  let out: string;
  try {
    // -z: origin, then key and value separated by a newline, fields ended by
    // NUL, so a value containing spaces is read whole.
    out = git(topLevel, [
      'config',
      ...scope,
      '--includes',
      '--show-origin',
      '-z',
      '--get-regexp',
      EXTRAHEADER,
    ]);
  } catch (err) {
    // Exit status 1 is git's "no key matched".
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  const fields = out.split('\0');
  const headers: StoredHeader[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const origin = fields[i];
    const entry = fields[i + 1];
    const newline = entry.indexOf('\n');
    headers.push({
      file: origin.startsWith('file:')
        ? realPathOrSelf(path.resolve(topLevel, origin.slice('file:'.length)))
        : origin,
      key: newline === -1 ? entry : entry.slice(0, newline),
      value: newline === -1 ? '' : entry.slice(newline + 1),
    });
  }
  return headers;
}

/** The auth headers git reads from this repository's own config (not global). */
export function readPersistedHeaders(workDir: string): PersistedHeader[] {
  const topLevel = git(workDir, ['rev-parse', '--show-toplevel']).trim();
  return readStoredHeaders(topLevel, ['--local']).map(({ key, value }) => ({ key, value }));
}

/** git's own reason when there is one, not "Command failed: git ...". */
function reason(err: unknown): string {
  const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
  if (stderr) return stderr.split('\n')[0];
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}

/** A checked-out repository: the workspace's own, or one of its submodules. */
interface Repo {
  topLevel: string;
  /** This checkout's git dir (holds config.worktree). */
  gitDir: string;
  /** Where its shared config lives (the same as gitDir unless a linked worktree). */
  commonDir: string;
}

function repoAt(dir: string): Repo {
  const [topLevel, gitDir, commonDir] = git(dir, [
    'rev-parse',
    '--show-toplevel',
    '--git-dir',
    '--git-common-dir',
  ])
    .trim()
    .split('\n');
  // --git-dir and --git-common-dir may be relative to dir.
  return {
    topLevel: realPathOrSelf(topLevel),
    gitDir: realPathOrSelf(path.resolve(dir, gitDir)),
    commonDir: realPathOrSelf(path.resolve(dir, commonDir)),
  };
}

/**
 * The checked-out submodules, nested ones included, as git lists them. Their
 * git dirs come from git too, not from guessing at the layout of .git.
 */
function submodules(topLevel: string): Repo[] {
  const out = git(topLevel, [
    'submodule',
    'foreach',
    '--quiet',
    '--recursive',
    'printf "%s\\0" "$displaypath"',
  ]);
  const paths = out.split('\0');
  paths.pop(); // after the last NUL
  // git before 2.17 has no $displaypath: say so rather than check nothing.
  if (paths.some((p) => p === ''))
    throw new Error('git did not report the submodule paths (git 2.17 or later is needed)');
  return paths.map((displayPath) => repoAt(path.resolve(topLevel, displayPath)));
}

/**
 * Delete the persisted auth headers from the git config of the repository at
 * workDir and of its checked-out submodules, for the rest of the job. Call it
 * before the first generated test runs. Returns the config files it removed a
 * header from, relative to workDir.
 *
 * Every case where the token may still be readable is reported through
 * `warn`; a case it cannot clean leaves the task running as it did before
 * this protection existed.
 */
export function removePersistedCredentials(workDir: string, warn: Warn): string[] {
  let root: Repo;
  try {
    root = repoAt(workDir);
  } catch (err) {
    warn(
      `Could not inspect .git/config for a persisted credential (${reason(err)}). ` +
        'If the checkout step uses persistCredentials: true, generated tests can read the job token. Set it to false.'
    );
    return [];
  }
  const realWorkDir = realPathOrSelf(workDir);
  const shown = (file: string) => path.relative(realWorkDir, file);

  // Only the repository checked out at workDir. git looks in parent
  // directories too, and a repository that merely contains workDir (with
  // several checkout steps, workDir is not a repository) is not ours to edit.
  if (root.topLevel !== realWorkDir) {
    warn(
      `${workDir} is not the top of a git repository, so no persisted git credential is removed. ` +
        'If a checkout step uses persistCredentials: true, generated tests can read the job token. Set it to false.'
    );
    return [];
  }

  const repos = [root];
  try {
    repos.push(...submodules(workDir));
  } catch (err) {
    warn(
      `Could not list the submodules (${reason(err)}). Their git configs are not checked, so generated tests may be able to read the job token. ` +
        'Set persistCredentials: false on the checkout step.'
    );
  }

  const headers: StoredHeader[] = [];
  for (const repo of repos) {
    const where = shown(repo.topLevel) || '.';
    const worktreeConfig = path.join(repo.gitDir, 'config.worktree');
    const hasWorktreeConfig = fs.existsSync(worktreeConfig);
    try {
      const remote = git(repo.topLevel, ['config', '--local', '--get', 'remote.origin.url']).trim();
      if (/^https?:\/\/[^/@]*:[^/@]*@/.test(remote)) {
        warn(
          `The origin URL in the git config of ${where} contains a credential. Generated tests can read it; use a URL without one.`
        );
      }
    } catch {
      // No origin, or not readable: nothing to warn about.
    }
    // git reads an includeIf file only while its condition holds, so one
    // that does not hold now can still hold a token a test can reach. Asked
    // of git, so an includeIf inside an included file counts too.
    for (const scope of [['--local'], ...(hasWorktreeConfig ? [['--file', worktreeConfig]] : [])]) {
      try {
        git(repo.topLevel, [
          'config',
          ...scope,
          '--includes',
          '--name-only',
          '--get-regexp',
          '^includeif\\.',
        ]);
        warn(
          `The git config of ${where} has an includeIf section, and files included only under a condition are not checked for a git credential. ` +
            'If the checkout step uses persistCredentials: true, set it to false.'
        );
        break;
      } catch {
        // Exit status 1: no includeIf. Other failures surface below.
      }
    }
    try {
      // Read from inside the repository, so git resolves its includes the
      // way a test running git there would.
      headers.push(...readStoredHeaders(repo.topLevel, ['--local']));
      if (hasWorktreeConfig) {
        headers.push(...readStoredHeaders(repo.topLevel, ['--file', worktreeConfig]));
      }
    } catch (err) {
      warn(
        `Could not inspect the git config of ${where} for a persisted credential (${reason(err)}). ` +
          'Generated tests may be able to read the job token. Set persistCredentials: false on the checkout step.'
      );
    }
  }

  const gitDirs = [...new Set(repos.flatMap((r) => [r.gitDir, r.commonDir]))];
  const removedFrom = new Set<string>();
  const done = new Set<string>();
  const warnedOutside = new Set<string>();
  for (const { file, key } of headers) {
    if (done.has(`${file}\0${key}`)) continue;
    done.add(`${file}\0${key}`);
    if (!gitDirs.some((dir) => isInsideRoot(dir, file))) {
      if (warnedOutside.has(file)) continue;
      warnedOutside.add(file);
      warn(
        `${shown(file)} stores a git credential and is included from the repository's git config, but it is outside .git, so it is not edited. ` +
          'Generated tests can read the job token. Set persistCredentials: false on the checkout step.'
      );
      continue;
    }
    try {
      git(workDir, ['config', '--file', file, '--unset-all', key]);
      removedFrom.add(shown(file));
    } catch (err) {
      warn(
        `Could not remove the persisted git credential ${key} from ${shown(file)} (${reason(err)}). ` +
          'Generated tests can read the job token. Set persistCredentials: false on the checkout step.'
      );
    }
  }
  return [...removedFrom];
}
