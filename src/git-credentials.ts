import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Git and the job token on Azure Pipelines.
 *
 * `checkout` with `persistCredentials: true` stores the job token in the
 * repository's git config as an `http.<url>.extraheader`
 * ("AUTHORIZATION: bearer ..."). Model-written tests run with that
 * repository as their working directory, so taking the token out of their
 * environment is not enough: `git config --get-regexp extraheader` reads it.
 *
 * removePersistedCredentials takes the header out of the config for the whole
 * time generated tests can run and hands back a function that restores it.
 * The task itself never needs the persisted header: it commits through the
 * REST API (see azure-commit.ts), so no git process is given the token.
 *
 * This narrows what a hostile test can reach; it is not a sandbox. Restoring
 * puts the token back where a process a test left running could read it, and
 * only the root repository's config is cleaned (a warning names any other
 * config under .git that still holds a header). The safe setup is
 * `persistCredentials: false`.
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

/**
 * The auth headers stored in this repository's own config (not global).
 * Throws when git could not answer at all: the caller must not read that as
 * "nothing stored".
 */
export function readPersistedHeaders(workDir: string): PersistedHeader[] {
  let out: string;
  try {
    // -z: key and value separated by a newline, entries by NUL, so a value
    // containing spaces is read whole.
    out = git(workDir, ['config', '--local', '-z', '--get-regexp', EXTRAHEADER]);
  } catch (err) {
    // Exit status 1 is git's "no key matched".
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  return out
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const newline = entry.indexOf('\n');
      return newline === -1
        ? { key: entry, value: '' }
        : { key: entry.slice(0, newline), value: entry.slice(newline + 1) };
    });
}

/**
 * Config files under .git other than the root one (submodules, worktrees,
 * config.worktree) that hold an extraheader. Bounded walk; paths are returned
 * relative to the workspace for the warning.
 */
function otherConfigsWithHeader(workDir: string): string[] {
  const gitDir = path.join(workDir, '.git');
  const found: string[] = [];
  const candidates: string[] = [path.join(gitDir, 'config.worktree')];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || candidates.length > 500) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'objects') walk(full, depth + 1);
      else if (entry.isFile() && (entry.name === 'config' || entry.name === 'config.worktree')) {
        candidates.push(full);
      }
    }
  };
  walk(path.join(gitDir, 'modules'), 0);
  walk(path.join(gitDir, 'worktrees'), 0);
  for (const file of candidates) {
    try {
      if (/extraheader/i.test(fs.readFileSync(file, 'utf-8'))) {
        found.push(path.relative(workDir, file));
      }
    } catch {
      // Not there.
    }
  }
  return found;
}

/**
 * Remove the persisted auth headers from the repository config and return a
 * function that puts them back (safe to call more than once). Call it before
 * the first generated test runs and restore only when no test process can
 * still be alive to read the config, i.e. at the very end of the task.
 *
 * Every case where the token may still be readable is reported through
 * `warn`; the task then runs as it did before this protection existed.
 */
export function removePersistedCredentials(workDir: string, warn: Warn): () => void {
  let headers: PersistedHeader[];
  try {
    headers = readPersistedHeaders(workDir);
  } catch (err) {
    warn(
      `Could not inspect .git/config for a persisted credential (${err instanceof Error ? err.message.split('\n')[0] : String(err)}). ` +
        'If the checkout step uses persistCredentials: true, generated tests can read the job token. Set it to false.'
    );
    return () => {};
  }

  try {
    const remote = git(workDir, ['config', '--local', '--get', 'remote.origin.url']).trim();
    if (/^https?:\/\/[^/@]*:[^/@]*@/.test(remote)) {
      warn(
        'The origin URL in .git/config contains a credential. Generated tests can read it; use a URL without one.'
      );
    }
  } catch {
    // No origin, or not readable: nothing to warn about.
  }

  for (const file of otherConfigsWithHeader(workDir)) {
    warn(
      `${file} also stores a git credential (submodule or worktree config). It is not removed, so generated tests can read the job token. Set persistCredentials: false on the checkout step.`
    );
  }

  if (headers.length === 0) return () => {};

  const removed: string[] = [];
  for (const key of new Set(headers.map((h) => h.key))) {
    try {
      git(workDir, ['config', '--local', '--unset-all', key]);
      removed.push(key);
    } catch (err) {
      warn(
        `Could not remove the persisted git credential ${key} from .git/config (${err instanceof Error ? err.message.split('\n')[0] : String(err)}). ` +
          'Generated tests can read the job token. Set persistCredentials: false on the checkout step.'
      );
    }
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const header of headers) {
      if (!removed.includes(header.key)) continue;
      try {
        git(workDir, ['config', '--local', '--add', header.key, header.value]);
      } catch (err) {
        warn(
          `Could not restore the git credential ${header.key} after the test run (${err instanceof Error ? err.message.split('\n')[0] : String(err)}). ` +
            'Later steps that rely on persistCredentials may fail to authenticate.'
        );
      }
    }
  };
}
