import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPersistedHeaders, removePersistedCredentials } from '../src/git-credentials';

// Real git in a scratch repository: the point is what git does and what a
// process in that directory can read, which a mock cannot show.
const KEY = 'http.https://dev.azure.com/org/project/_git/repo.extraheader';
const VALUE = 'AUTHORIZATION: bearer job-token-123';

// The developer's or agent's own global config must not leak into the checks.
const ISOLATED = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

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
  it('takes the token out of .git/config until restore is called', () => {
    git(repo, 'config', '--local', KEY, VALUE);
    expect(inRepoConfig(repo)).toContain('job-token-123');

    const restore = removePersistedCredentials(repo, warn);

    expect(inRepoConfig(repo)).not.toContain('job-token-123');
    expect(readPersistedHeaders(repo)).toEqual([]);

    restore();
    expect(readPersistedHeaders(repo)).toEqual([{ key: KEY, value: VALUE }]);
    expect(warnings).toEqual([]);
  });

  it('restores once, however often restore is called', () => {
    git(repo, 'config', '--local', KEY, VALUE);
    const restore = removePersistedCredentials(repo, warn);
    restore();
    restore();
    expect(readPersistedHeaders(repo)).toEqual([{ key: KEY, value: VALUE }]);
  });

  it('handles several headers, including two values on one key', () => {
    git(repo, 'config', '--local', KEY, VALUE);
    git(repo, 'config', '--local', '--add', KEY, 'X-Second: two');
    git(
      repo,
      'config',
      '--local',
      'http.https://example.com/.extraheader',
      'AUTHORIZATION: basic abc'
    );
    const before = readPersistedHeaders(repo);
    expect(before).toHaveLength(3);

    const restore = removePersistedCredentials(repo, warn);
    expect(readPersistedHeaders(repo)).toEqual([]);
    restore();
    expect(readPersistedHeaders(repo)).toEqual(before);
  });

  it('leaves other config alone when there is no header', () => {
    git(repo, 'config', '--local', 'user.name', 'someone');
    removePersistedCredentials(repo, warn)();
    expect(git(repo, 'config', '--local', 'user.name').trim()).toBe('someone');
    expect(warnings).toEqual([]);
  });

  // Failing open without a word is the worst outcome: say so.
  it('warns when the directory is not a repository git can inspect', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gc148-plain-'));
    try {
      removePersistedCredentials(plain, warn)();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Could not inspect .git/config');
  });

  it('warns when the origin URL carries a credential', () => {
    git(repo, 'remote', 'add', 'origin', 'https://user:pat123@dev.azure.com/org/project/_git/repo');
    removePersistedCredentials(repo, warn)();
    expect(warnings.join(' ')).toContain('origin URL in .git/config contains a credential');
    expect(warnings.join(' ')).not.toContain('pat123');
  });

  // Only the root config is cleaned. A header elsewhere under .git must at
  // least be named, or the protection fails without a word.
  it('warns about a header in a submodule config', () => {
    const moduleDir = path.join(repo, '.git', 'modules', 'lib');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, 'config'),
      `[http "https://dev.azure.com/"]\n\textraheader = ${VALUE}\n`
    );
    removePersistedCredentials(repo, warn)();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path.join('.git', 'modules', 'lib', 'config'));
    expect(warnings[0]).not.toContain('job-token-123');
  });

  it('does not warn for an ordinary origin URL', () => {
    git(repo, 'remote', 'add', 'origin', 'https://dev.azure.com/org/project/_git/repo');
    removePersistedCredentials(repo, warn)();
    expect(warnings).toEqual([]);
  });
});
