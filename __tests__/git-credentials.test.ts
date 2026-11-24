import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPersistedHeaders, removePersistedCredentials } from '../src/git-credentials';

// Real git in a scratch repository: the point is what git does and what a
// process in that directory can read, which a mock cannot show.
const KEY = 'http.https://dev.azure.com/org/project/_git/repo.extraheader';
const VALUE = 'AUTHORIZATION: bearer job-token-123';

// Run from a git hook (the pre-commit test run), git exports GIT_DIR,
// GIT_INDEX_FILE and friends for the outer repository; the scratch
// repositories and the code under test must not inherit them.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) delete process.env[name];
}
// The developer's or agent's own global config must not leak into the checks.
// A CI runner has no git identity of its own, and the submodule sources
// need a commit.
const ISOLATED = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: ISOLATED,
  });
}

/** What a generated test would find in the repository's config. */
function inRepoConfig(cwd: string): string {
  return fs.readFileSync(path.join(cwd, '.git', 'config'), 'utf-8');
}

describe('persisted git credentials', () => {
  let repo: string;
  let warnings: string[];
  const warn = (m: string) => warnings.push(m);

  beforeEach(() => {
    warnings = [];
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gc148-'));
    git(repo, 'init', '-q');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('reads the header the Azure checkout stores', () => {
    git(repo, 'config', '--local', KEY, VALUE);
    expect(readPersistedHeaders(repo)).toEqual([{ key: KEY, value: VALUE }]);
  });

  it('also reads an unscoped http.extraheader', () => {
    git(repo, 'config', '--local', 'http.extraheader', VALUE);
    expect(readPersistedHeaders(repo)).toEqual([{ key: 'http.extraheader', value: VALUE }]);
  });

  it('returns nothing for a repository without one', () => {
    expect(readPersistedHeaders(repo)).toEqual([]);
  });

  // GC-148: SYSTEM_ACCESSTOKEN was stripped from the test environment, but the
  // same token sat in .git/config of the directory the tests run in.
  it('takes the token out of .git/config', () => {
    git(repo, 'config', '--local', KEY, VALUE);
    expect(inRepoConfig(repo)).toContain('job-token-123');

    removePersistedCredentials(repo, warn);

    expect(inRepoConfig(repo)).not.toContain('job-token-123');
    expect(readPersistedHeaders(repo)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // GC-188, GC-189: restoring at task end handed the token to any process a
  // test left running, and a killed task could not restore it. It now stays
  // removed; the caller logs the files it was removed from.
  it('returns the files it removed the token from', () => {
    git(repo, 'config', '--local', KEY, VALUE);
    expect(removePersistedCredentials(repo, warn)).toEqual([path.join('.git', 'config')]);
    expect(readPersistedHeaders(repo)).toEqual([]);
  });

  // A directory inside a repository is not the checkout: with several
  // checkout steps the task runs in s/, and the repository around it (if
  // any) belongs to someone else. Say so instead of editing it.
  it('leaves a repository alone when workDir is only inside it', () => {
    git(repo, 'config', '--local', KEY, VALUE);
    const sub = path.join(repo, 'sd');
    fs.mkdirSync(sub);
    expect(removePersistedCredentials(sub, warn)).toEqual([]);
    expect(inRepoConfig(repo)).toContain('job-token-123');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('is not the top of a git repository');
  });

  it('removes several headers, including two values on one key', () => {
    git(repo, 'config', '--local', KEY, VALUE);
    git(repo, 'config', '--local', '--add', KEY, 'X-Second: two');
    git(
      repo,
      'config',
      '--local',
      'http.https://example.com/.extraheader',
      'AUTHORIZATION: basic abc'
    );
    expect(readPersistedHeaders(repo)).toHaveLength(3);

    removePersistedCredentials(repo, warn);
    expect(readPersistedHeaders(repo)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('says nothing on a second run once the token is gone', () => {
    git(repo, 'config', '--local', KEY, VALUE);
    removePersistedCredentials(repo, warn);
    warnings = [];
    removePersistedCredentials(repo, warn);
    expect(warnings).toEqual([]);
  });

  it('leaves other config alone', () => {
    git(repo, 'config', '--local', 'user.name', 'someone');
    git(repo, 'config', '--local', KEY, VALUE);
    removePersistedCredentials(repo, warn);
    expect(git(repo, 'config', '--local', 'user.name').trim()).toBe('someone');
  });

  // Failing open without a word is the worst outcome: say so.
  it('warns when the directory is not a repository git can inspect', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gc148-plain-'));
    try {
      removePersistedCredentials(plain, warn);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Could not inspect .git/config');
  });

  it('warns when the origin URL carries a credential', () => {
    git(repo, 'remote', 'add', 'origin', 'https://user:pat123@dev.azure.com/org/project/_git/repo');
    removePersistedCredentials(repo, warn);
    expect(warnings.join(' ')).toContain('origin URL in the git config of . contains a credential');
    expect(warnings.join(' ')).not.toContain('pat123');
  });

  it('does not warn for an ordinary origin URL', () => {
    git(repo, 'remote', 'add', 'origin', 'https://dev.azure.com/org/project/_git/repo');
    removePersistedCredentials(repo, warn);
    expect(warnings).toEqual([]);
  });

  /** A real submodule at `name`, as `checkout: submodules: true` leaves it. */
  function addSubmodule(parent: string, name: string): string {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'gc191-src-'));
    sources.push(source);
    git(source, 'init', '-q');
    git(source, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, name);
    return path.join(parent, name);
  }
  let sources: string[] = [];
  afterEach(() => {
    for (const dir of sources) fs.rmSync(dir, { recursive: true, force: true });
    sources = [];
  });

  /** What a generated test running git inside the submodule would find. */
  const headersIn = (dir: string) =>
    git(dir, 'config', '--local', '--get-regexp', 'extraheader').trim();
  const hasHeaders = (dir: string) => {
    try {
      return headersIn(dir) !== '';
    } catch {
      return false;
    }
  };

  // GC-191: checkout with submodules: true writes the header into each
  // submodule's config too, where a test in the workspace can read it.
  // Submodule paths can use any name, including ones git uses inside .git.
  it.each(['lib', 'lfs', 'hooks', 'refs'])('removes a header from a submodule named %s', (name) => {
    const sub = addSubmodule(repo, name);
    git(sub, 'config', '--local', KEY, VALUE);
    expect(hasHeaders(sub)).toBe(true);
    const removed = removePersistedCredentials(repo, warn);
    expect(hasHeaders(sub)).toBe(false);
    expect(removed).toEqual([path.join('.git', 'modules', name, 'config')]);
    expect(warnings).toEqual([]);
  });

  it('removes headers from nested submodules', () => {
    const vendor = addSubmodule(repo, 'vendor');
    const inner = addSubmodule(repo, 'vendor-x');
    const nested = addSubmodule(vendor, 'deep');
    for (const dir of [vendor, inner, nested]) git(dir, 'config', '--local', KEY, VALUE);
    removePersistedCredentials(repo, warn);
    for (const dir of [vendor, inner, nested]) expect(hasHeaders(dir)).toBe(false);
    expect(warnings).toEqual([]);
  });

  // git reads an includeIf file only while its condition holds.
  it('warns about an includeIf section in the repository config', () => {
    fs.writeFileSync(path.join(repo, '.git', 'auth.cfg'), `[http]\n\textraheader = ${VALUE}\n`);
    git(repo, 'config', '--local', 'includeIf.onbranch:release.path', 'auth.cfg');
    removePersistedCredentials(repo, warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('includeIf');
    expect(warnings[0]).not.toContain('job-token-123');
  });

  it('warns about an includeIf inside an included file', () => {
    fs.writeFileSync(
      path.join(repo, '.git', 'auth.cfg'),
      '[includeIf "onbranch:release"]\n\tpath = token.cfg\n'
    );
    fs.writeFileSync(path.join(repo, '.git', 'token.cfg'), `[http]\n\textraheader = ${VALUE}\n`);
    git(repo, 'config', '--local', 'include.path', 'auth.cfg');
    removePersistedCredentials(repo, warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('includeIf');
  });

  it('warns about a credential in a submodule origin URL', () => {
    const sub = addSubmodule(repo, 'lib');
    git(sub, 'remote', 'set-url', 'origin', 'https://user:pat123@dev.azure.com/org/p/_git/lib');
    removePersistedCredentials(repo, warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('origin URL in the git config of lib');
    expect(warnings[0]).not.toContain('pat123');
  });

  it('removes a header from config.worktree', () => {
    const worktreeConfig = path.join(repo, '.git', 'config.worktree');
    fs.writeFileSync(worktreeConfig, `[http]\n\textraheader = ${VALUE}\n`);
    removePersistedCredentials(repo, warn);
    expect(fs.readFileSync(worktreeConfig, 'utf-8')).not.toContain('job-token-123');
    expect(warnings).toEqual([]);
  });

  it('removes a header from a file under .git that the config includes', () => {
    const included = path.join(repo, '.git', 'auth.cfg');
    fs.writeFileSync(included, `[http]\n\textraheader = ${VALUE}\n`);
    git(repo, 'config', '--local', 'include.path', 'auth.cfg');
    removePersistedCredentials(repo, warn);
    expect(fs.readFileSync(included, 'utf-8')).not.toContain('job-token-123');
    expect(readPersistedHeaders(repo)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // A file outside .git may be shared with other repositories: name it, do
  // not edit it.
  it('warns about, and leaves alone, an included file outside .git', () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'gc191-shared-'));
    const included = path.join(shared, 'auth.cfg');
    try {
      fs.writeFileSync(included, `[http]\n\textraheader = ${VALUE}\n`);
      git(repo, 'config', '--local', 'include.path', included);
      removePersistedCredentials(repo, warn);
      expect(fs.readFileSync(included, 'utf-8')).toContain('job-token-123');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('outside .git');
      expect(warnings[0]).toContain('auth.cfg');
      expect(warnings[0]).not.toContain('job-token-123');
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
    }
  });
});
