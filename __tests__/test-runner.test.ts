import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { writeTests, runTests, cleanupTests, ensureAuthSession, detectDevServer, playwrightConfigSource, ensurePlaywright } from '../src/test-runner';
import { ActionConfig, GeneratedTest } from '../src/types';

jest.mock('@actions/core');
jest.mock('@actions/exec');

const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockUnlinkSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockRenameSync = jest.fn();
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    renameSync: (...args: unknown[]) => mockRenameSync(...args),
  };
});

const mockConfig: ActionConfig = {
  apiKey: 'mock-key',
  llmProvider: 'greenci',
  llmModel: '',
  awsRegion: 'us-east-1',
  testDir: 'e2e',
  baseUrl: 'http://localhost:3000',
  maxRetries: 2,
  autoCommit: true,
  greenCIApiUrl: 'https://api.greenci.ai',
  mode: 'generate',
  cypressDir: 'cypress/e2e',
  journeys: '',
};

const testFile: GeneratedTest = {
  filename: 'login.spec.ts',
  code: 'test("login", () => {});',
  description: 'Login test',
  confidence: 0.9,
};

describe('writeTests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('should write test files and return paths', async () => {
    const result = await writeTests([testFile], '/work', 'e2e');
    expect(result).toEqual(['/work/e2e/login.spec.ts']);
    expect(mockWriteFileSync).toHaveBeenCalledWith('/work/e2e/login.spec.ts', testFile.code, 'utf-8');
  });

  it('should create directories if missing', async () => {
    mockExistsSync.mockReturnValue(false);
    await writeTests([testFile], '/work', 'e2e');
    expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it('should handle multiple files', async () => {
    const tests = [testFile, { ...testFile, filename: 'e2e/other.spec.ts' }];
    const result = await writeTests(tests, '/work', 'e2e');
    expect(result).toHaveLength(2);
  });

  // Regression: a PR author prompt-injects a traversal filename through the
  // diff and the action writes (then commits) outside the test directory.
  describe('untrusted filenames', () => {
    it.each([
      ['../../package.json'],
      ['e2e/../../package.json'],
      ['/etc/cron.d/evil.spec.ts'],
      ['../../.github/scripts/release.sh'],
    ])('writes nothing for %s', async (filename) => {
      const result = await writeTests([{ ...testFile, filename }], '/work', 'e2e');
      expect(result).toEqual([]);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it('skips the poisoned test but still writes the legitimate ones', async () => {
      const tests = [
        { ...testFile, filename: '../../package.json' },
        { ...testFile, filename: 'good.spec.ts' },
      ];
      const result = await writeTests(tests, '/work', 'e2e');
      expect(result).toEqual(['/work/e2e/good.spec.ts']);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      expect(mockWriteFileSync).toHaveBeenCalledWith('/work/e2e/good.spec.ts', testFile.code, 'utf-8');
    });

    it('normalises filename in place so downstream consumers use the safe value', async () => {
      const test = { ...testFile, filename: 'e2e/nested/a.spec.ts' };
      await writeTests([test], '/work', 'e2e');
      expect(test.filename).toBe('nested/a.spec.ts');
    });
  });
});

describe('runTests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return passed result when exit code is 0', async () => {
    (exec.exec as jest.Mock).mockResolvedValue(0);
    const results = await runTests([testFile], mockConfig, '/work');
    expect(results[0].passed).toBe(true);
    expect(results[0].filename).toBe('login.spec.ts');
  });

  it('should return failed result when exit code is non-zero', async () => {
    (exec.exec as jest.Mock).mockResolvedValue(1);
    const results = await runTests([testFile], mockConfig, '/work');
    expect(results[0].passed).toBe(false);
  });

  it('should handle exec throwing an error', async () => {
    (exec.exec as jest.Mock).mockRejectedValue(new Error('Command not found'));
    const results = await runTests([testFile], mockConfig, '/work');
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toContain('Command not found');
  });

  it('should call playwright with correct args', async () => {
    (exec.exec as jest.Mock).mockResolvedValue(0);
    await runTests([testFile], mockConfig, '/work');
    expect(exec.exec).toHaveBeenCalledWith(
      'npx',
      ['playwright', 'test', 'login.spec.ts', '--reporter=line'],
      expect.objectContaining({ cwd: '/work', ignoreReturnCode: true })
    );
  });

  it('refuses to run a test whose filename escapes the test dir', async () => {
    (exec.exec as jest.Mock).mockResolvedValue(0);
    const results = await runTests([{ ...testFile, filename: '../../package.json' }], mockConfig, '/work');
    expect(exec.exec).not.toHaveBeenCalled();
    expect(results[0].passed).toBe(false);
  });

  // Regression: the child process inherited the action's own credentials.
  it('does not leak action credentials into the playwright environment', async () => {
    (exec.exec as jest.Mock).mockResolvedValue(0);
    const restore = { ...process.env };
    process.env['INPUT_API-KEY'] = 'gci_live_secret';
    process.env.GITHUB_TOKEN = 'ghs_secret';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    try {
      await runTests([testFile], mockConfig, '/work');
      const opts = (exec.exec as jest.Mock).mock.calls[0][2];
      expect(opts.env).not.toHaveProperty('INPUT_API-KEY');
      expect(opts.env).not.toHaveProperty('GITHUB_TOKEN');
      expect(opts.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(Object.values(opts.env).join('\n')).not.toContain('secret');
      // still passes through what the tests need
      expect(opts.env.BASE_URL).toBe('http://localhost:3000');
      expect(opts.env.CI).toBe('true');
    } finally {
      process.env = restore;
    }
  });
});

// GC-042: specs are run one file at a time, so a repo whose own
// playwright.config does not route the NEW spec through a setup-dependent
// project never gets playwright/.auth/user.json written. Sign in once up
// front so the session exists regardless of how the customer's config is wired.
describe('ensureAuthSession', () => {
  const withCreds = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const restore = { ...process.env };
    process.env.TEST_USER_EMAIL = 'qa@example.com';
    process.env.TEST_USER_PASSWORD = 'pw';
    process.env.GITHUB_TOKEN = 'ghs_secret';
    try {
      return await fn();
    } finally {
      process.env = restore;
    }
  };
  const execWithOutput = (exitCode: number, output: string) =>
    (exec.exec as jest.Mock).mockImplementation(async (_c: string, _a: string[], opts: { listeners?: { stdout?: (d: Buffer) => void } }) => {
      opts.listeners?.stdout?.(Buffer.from(output));
      return exitCode;
    });

  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(true); // session file present unless a test says otherwise
  });

  it('is skipped (and runs nothing) when the test credentials are not set', async () => {
    const restore = { ...process.env };
    delete process.env.TEST_USER_EMAIL;
    delete process.env.TEST_USER_PASSWORD;
    try {
      const r = await ensureAuthSession('/work', mockConfig);
      expect(r.status).toBe('skipped');
      expect(exec.exec).not.toHaveBeenCalled();
    } finally {
      process.env = restore;
    }
  });

  it('runs the auth setup file once and reports ok on exit 0', async () => {
    await withCreds(async () => {
      execWithOutput(0, '1 passed');
      const r = await ensureAuthSession('/work', mockConfig);
      expect(r.status).toBe('ok');
      expect(exec.exec).toHaveBeenCalledWith(
        'npx',
        ['playwright', 'test', 'auth.setup.ts', '--reporter=line'],
        expect.objectContaining({ cwd: '/work', ignoreReturnCode: true }),
      );
      const opts = (exec.exec as jest.Mock).mock.calls[0][2];
      expect(opts.env.TEST_USER_EMAIL).toBe('qa@example.com');
      expect(opts.env).not.toHaveProperty('GITHUB_TOKEN');
    });
  });

  it('reports not-wired when no Playwright project matches the setup file', async () => {
    await withCreds(async () => {
      execWithOutput(1, 'Error: No tests found.\nMake sure that arguments are regular expressions matching test files.');
      const r = await ensureAuthSession('/work', mockConfig);
      expect(r.status).toBe('not-wired');
    });
  });

  it('does not mistake a setup that merely prints "no tests found" for a wiring problem', async () => {
    await withCreds(async () => {
      execWithOutput(0, 'app log: no tests found in fixtures, continuing\n1 passed');
      expect((await ensureAuthSession('/work', mockConfig)).status).toBe('ok');
      execWithOutput(1, 'app log: no tests found in fixtures\n  1) [setup] › e2e/auth.setup.ts › authenticate\n TimeoutError');
      expect((await ensureAuthSession('/work', mockConfig)).status).toBe('failed');
    });
  });

  // Review finding: exit 0 is not a session. A kept customer setup that saves
  // elsewhere (or skips) must not be reported as signed in.
  it('reports no-session-file when the setup exits 0 without writing the session file', async () => {
    await withCreds(async () => {
      execWithOutput(0, '1 passed');
      mockExistsSync.mockReturnValue(false);
      const r = await ensureAuthSession('/work', mockConfig);
      expect(r.status).toBe('no-session-file');
      expect(mockExistsSync).toHaveBeenCalledWith('/work/playwright/.auth/user.json');
    });
  });

  it('reports failed when the setup ran but could not sign in', async () => {
    await withCreds(async () => {
      execWithOutput(1, '  1) [setup] › e2e/auth.setup.ts:16:6 › authenticate\n    TimeoutError: page.waitForURL');
      const r = await ensureAuthSession('/work', mockConfig);
      expect(r.status).toBe('failed');
      expect(r.output).toContain('TimeoutError');
    });
  });
});

describe('cleanupTests', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should delete existing files', () => {
    mockExistsSync.mockReturnValue(true);
    cleanupTests(['/work/e2e/test.spec.ts']);
    expect(mockUnlinkSync).toHaveBeenCalledWith('/work/e2e/test.spec.ts');
  });

  it('should skip non-existing files', () => {
    mockExistsSync.mockReturnValue(false);
    cleanupTests(['/work/e2e/missing.spec.ts']);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });
});

describe('ensurePlaywrightConfig', () => {
  const { ensurePlaywrightConfig } = jest.requireActual('../src/test-runner');

  beforeEach(() => jest.clearAllMocks());

  beforeEach(() => mockReadFileSync.mockReset());

  it('writes a minimal config when none exists and returns its source', () => {
    mockExistsSync.mockReturnValue(false);
    const created = ensurePlaywrightConfig('/work', 'http://localhost:4000', 'e2e', false, null);
    expect(created).toContain("baseURL: 'http://localhost:4000'");
    expect(mockWriteFileSync).toHaveBeenCalledWith(expect.stringContaining('playwright.config.ts'), created, 'utf-8');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('playwright.config.ts'),
      expect.stringContaining("baseURL: 'http://localhost:4000'"),
      'utf-8'
    );
  });

  // GC-029: local runs need the app started; CI already has it running.
  it('adds a webServer block that starts the app when a dev script was detected', () => {
    mockExistsSync.mockReturnValue(false);
    ensurePlaywrightConfig('/work', 'http://localhost:4000', 'e2e', false, { command: 'npm run dev' });
    const config: string = mockWriteFileSync.mock.calls[0][1];
    expect(config).toContain("command: 'npm run dev'");
    expect(config).toContain("url: 'http://localhost:4000'");
    expect(config).toContain('reuseExistingServer: true');
    // Never in CI: Playwright would spawn a second server whenever `/` is not 2xx.
    expect(config).toContain('webServer: process.env.CI\n    ? undefined');
    expect(config).not.toContain('No start script was found');
  });

  it('explains what to add instead of guessing when no start script exists', () => {
    mockExistsSync.mockReturnValue(false);
    ensurePlaywrightConfig('/work', 'http://localhost:4000', 'e2e', false, null);
    const config: string = mockWriteFileSync.mock.calls[0][1];
    expect(config).not.toContain('\n  webServer: {');
    expect(config).toContain('No start script was found in package.json');
    expect(config).toContain("webServer: { command: '<your start command>', url: 'http://localhost:4000'");
  });

  it('writes a plain run-only config, with no detection and no advice, when devServer is not given', () => {
    mockExistsSync.mockReturnValue(false);
    ensurePlaywrightConfig('/work', 'http://localhost:4000', 'e2e');
    const config: string = mockWriteFileSync.mock.calls[0][1];
    expect(mockReadFileSync).not.toHaveBeenCalled();
    expect(config).not.toContain('webServer');
  });

  it('escapes quotes and newlines in interpolated values', () => {
    mockExistsSync.mockReturnValue(false);
    const ts = jest.requireActual('typescript');
    ensurePlaywrightConfig('/work', "http://localhost:3000/it's\n", "e2e'x", true, { command: "echo 'hi'" });
    const config: string = mockWriteFileSync.mock.calls[0][1];
    const { diagnostics } = ts.transpileModule(config, { reportDiagnostics: true });
    expect(diagnostics ?? []).toEqual([]);
    expect(config).toContain("baseURL: 'http://localhost:3000/it\\'s\\n'");
  });

  it('does nothing when a config already exists', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('playwright.config.js'));
    const created = ensurePlaywrightConfig('/work', 'http://localhost:4000', 'e2e');
    expect(created).toBeNull();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe('ensurePlaywright', () => {
  const { ensurePlaywright } = jest.requireActual('../src/test-runner');

  beforeEach(() => jest.clearAllMocks());

  it('installs @playwright/test when missing, then installs chromium', async () => {
    mockExistsSync.mockReturnValue(false);
    const installed = await ensurePlaywright('/work');
    expect(installed).toBe(true);
    expect(exec.exec).toHaveBeenCalledWith(
      'npm',
      expect.arrayContaining(['install', '--no-save', '@playwright/test']),
      expect.objectContaining({ cwd: '/work' })
    );
    expect(exec.exec).toHaveBeenCalledWith(
      'npx',
      ['playwright', 'install', '--with-deps', 'chromium'],
      expect.objectContaining({ cwd: '/work' })
    );
  });

  it('skips the package install when @playwright/test is present', async () => {
    mockExistsSync.mockReturnValue(true);
    const installed = await ensurePlaywright('/work');
    expect(installed).toBe(false);
    const npmCalls = (exec.exec as jest.Mock).mock.calls.filter((c) => c[0] === 'npm');
    expect(npmCalls).toHaveLength(0);
  });
});

describe('detectDevServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  const pkg = (scripts: Record<string, string>) => mockReadFileSync.mockReturnValue(JSON.stringify({ scripts }));

  it('prefers dev, then start, then serve, then preview', () => {
    pkg({ preview: 'x', serve: 'x', start: 'x', dev: 'x' });
    expect(detectDevServer('/work')).toEqual({ command: 'npm run dev' });
    pkg({ preview: 'x', serve: 'x', start: 'x' });
    expect(detectDevServer('/work')).toEqual({ command: 'npm start' });
    pkg({ preview: 'x', serve: 'x' });
    expect(detectDevServer('/work')).toEqual({ command: 'npm run serve' });
    pkg({ preview: 'x' });
    expect(detectDevServer('/work')).toEqual({ command: 'npm run preview' });
  });

  it('uses the package manager the lockfile points at', () => {
    pkg({ dev: 'x' });
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('pnpm-lock.yaml'));
    expect(detectDevServer('/work')).toEqual({ command: 'pnpm dev' });
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('yarn.lock'));
    expect(detectDevServer('/work')).toEqual({ command: 'yarn dev' });
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('bun.lock'));
    expect(detectDevServer('/work')).toEqual({ command: 'bun dev' });
  });

  it('returns null with no scripts, no package.json, or unparseable JSON', () => {
    pkg({ build: 'x', test: 'x' });
    expect(detectDevServer('/work')).toBeNull();
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(detectDevServer('/work')).toBeNull();
    mockReadFileSync.mockReturnValue('{not json');
    expect(detectDevServer('/work')).toBeNull();
  });
});

describe('playwrightConfigSource', () => {
  it('is valid TypeScript with and without the webServer block and the setup project', () => {
    const ts = jest.requireActual('typescript');
    for (const devServer of [{ command: 'npm run dev' }, null, undefined]) {
      for (const withAuthSetup of [true, false]) {
        const src = playwrightConfigSource({ baseUrl: 'http://localhost:3000', testDir: 'e2e', withAuthSetup, devServer });
        const { diagnostics } = ts.transpileModule(src, { reportDiagnostics: true });
        expect(diagnostics ?? []).toEqual([]);
        expect(src.includes("name: 'setup'")).toBe(withAuthSetup);
        expect(src.includes('\n  webServer: process.env.CI')).toBe(Boolean(devServer));
        expect(src.includes('No start script was found')).toBe(devServer === null);
      }
    }
  });
});

describe('ensurePlaywright', () => {
  const mockExec = exec.exec as jest.Mock;
  beforeEach(() => {
    mockExec.mockReset();
    mockExistsSync.mockReset();
  });

  const installCalls = () =>
    mockExec.mock.calls.filter(([cmd, args]) => cmd === 'npx' && (args as string[]).includes('install'));

  it('skips the system dependency install when Chromium already launches', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExec.mockResolvedValue(0);
    const installed = await ensurePlaywright('/work');
    expect(installed).toBe(false);
    expect(mockExec).toHaveBeenCalledWith('node', ['-e', expect.stringContaining('chromium.launch')], expect.objectContaining({ cwd: '/work', ignoreReturnCode: true }));
    expect(installCalls()).toHaveLength(1);
    expect(installCalls()[0][1]).toEqual(['playwright', 'install', 'chromium']);
  });

  it('installs with system deps when the launch probe fails', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExec.mockImplementation(async (cmd: string) => (cmd === 'node' ? 1 : 0));
    await ensurePlaywright('/work');
    expect(installCalls()).toHaveLength(1);
    expect(installCalls()[0][1]).toEqual(['playwright', 'install', '--with-deps', 'chromium']);
  });

  it('logs why the launch check failed', async () => {
    const core = jest.requireMock('@actions/core');
    mockExistsSync.mockReturnValue(true);
    mockExec.mockImplementation(async (cmd: string, _args: string[], opts: any) => {
      if (cmd === 'node') {
        opts.listeners.stderr(Buffer.from('\nbrowserType.launch: Executable doesn\'t exist at /x\nmore'));
        return 1;
      }
      return 0;
    });
    await ensurePlaywright('/work');
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("Executable doesn't exist at /x"));
  });

  it('installs when the probe itself throws', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExec.mockImplementation(async (cmd: string) => {
      if (cmd === 'node') throw new Error('node missing');
      return 0;
    });
    await ensurePlaywright('/work');
    expect(installCalls()).toHaveLength(1);
  });

  it('installs @playwright/test first when the package is missing, then probes', async () => {
    mockExistsSync.mockReturnValue(false);
    mockExec.mockResolvedValue(0);
    const installed = await ensurePlaywright('/work');
    expect(installed).toBe(true);
    expect(mockExec.mock.calls[0][0]).toBe('npm');
    expect(mockExec.mock.calls[1][0]).toBe('node');
  });
});

describe('session renewal (GC-089)', () => {
  const authedFile: GeneratedTest = { ...testFile, filename: 'expenses.spec.ts', code: "test.use({ storageState: 'playwright/.auth/user.json' });" };
  const session = '/work/playwright/.auth/user.json';
  const ranFiles = () => (exec.exec as jest.Mock).mock.calls.map((c) => c[1].find((a: string) => /\.(spec|setup)\.ts$/.test(a)));
  const signedOut = 'Expected pattern: /expenses/\nReceived string: "http://localhost:3000/login/?next=%2Fexpenses"';
  // Each call returns the next exit code for that file (the last one repeats);
  // a failing spec prints `failureOutput`.
  const exitCodes = (codes: Record<string, number[]>, failureOutput = signedOut) =>
    (exec.exec as jest.Mock).mockImplementation(async (_c: string, args: string[], opts: { listeners?: { stderr?: (d: Buffer) => void } }) => {
      const file = args.find((a) => /\.(spec|setup)\.ts$/.test(a)) as string;
      const list = codes[file] ?? [0];
      const code = list.length > 1 ? list.shift() : list[0];
      if (code !== 0 && file.endsWith('.spec.ts')) opts.listeners?.stderr?.(Buffer.from(failureOutput));
      return code;
    });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRenameSync.mockReset();
    mockExistsSync.mockReset().mockReturnValue(true);
    (exec.exec as jest.Mock).mockReset().mockResolvedValue(0);
  });

  it('keeps sharing one session while authenticated specs pass', async () => {
    const renewal = { rotates: false, stopped: false };
    await runTests([authedFile, testFile, authedFile], mockConfig, '/work', renewal);
    expect(ranFiles()).toEqual(['expenses.spec.ts', 'login.spec.ts', 'expenses.spec.ts']);
    expect(renewal).toEqual({ rotates: false, stopped: false });
  });

  it('re-runs a failed authenticated spec once with a fresh sign-in, then signs in before every later one', async () => {
    exitCodes({ 'expenses.spec.ts': [1, 0] });
    const renewal = { rotates: false, stopped: false };
    const results = await runTests([authedFile, testFile, authedFile], mockConfig, '/work', renewal);
    expect(ranFiles()).toEqual(['expenses.spec.ts', 'auth.setup.ts', 'expenses.spec.ts', 'login.spec.ts', 'auth.setup.ts', 'expenses.spec.ts']);
    expect(results.map((r) => r.passed)).toEqual([true, true, true]);
    expect(renewal.rotates).toBe(true);
    // The session is moved aside so the setup cannot reuse it.
    expect(mockRenameSync).toHaveBeenCalledWith(session, `${session}.prev`);
  });

  it('reports the re-run failure and stays in shared mode when a fresh session does not help', async () => {
    exitCodes({ 'expenses.spec.ts': [1] });
    const renewal = { rotates: false, stopped: false };
    const results = await runTests([authedFile], mockConfig, '/work', renewal);
    expect(ranFiles()).toEqual(['expenses.spec.ts', 'auth.setup.ts', 'expenses.spec.ts']);
    expect(results[0].passed).toBe(false);
    expect(renewal.rotates).toBe(false);
  });

  it('does not re-run specs that do not load the session, or without a renewal record', async () => {
    exitCodes({ 'login.spec.ts': [1], 'expenses.spec.ts': [1] });
    await runTests([testFile], mockConfig, '/work', { rotates: false, stopped: false });
    await runTests([authedFile], mockConfig, '/work');
    expect(ranFiles()).toEqual(['login.spec.ts', 'expenses.spec.ts']);
  });

  // GC-093: the line reporter prints the redirect on stdout; stderr may hold unrelated noise.
  it('sees a sign-in redirect printed on stdout even when stderr has other output', async () => {
    let specRuns = 0;
    (exec.exec as jest.Mock).mockImplementation(
      async (_c: string, args: string[], opts: { listeners?: { stdout?: (d: Buffer) => void; stderr?: (d: Buffer) => void } }) => {
        if (!args.includes('expenses.spec.ts')) return 0;
        if (++specRuns > 1) return 0;
        opts.listeners?.stderr?.(Buffer.from('(node:1) ExperimentalWarning: something'));
        opts.listeners?.stdout?.(Buffer.from(signedOut));
        return 1;
      },
    );
    const renewal = { rotates: false, stopped: false };
    await runTests([authedFile], mockConfig, '/work', renewal);
    expect(ranFiles()).toEqual(['expenses.spec.ts', 'auth.setup.ts', 'expenses.spec.ts']);
    expect(renewal.rotates).toBe(true);
  });

  it('does not sign in again for a failure that does not look signed out', async () => {
    exitCodes({ 'expenses.spec.ts': [1] }, "locator('text=Vendor 1') not found");
    const renewal = { rotates: false, stopped: false };
    await runTests([authedFile], mockConfig, '/work', renewal);
    expect(ranFiles()).toEqual(['expenses.spec.ts']);
  });

  it('treats a spec with an inline (logged-out) storageState as not authenticated', async () => {
    exitCodes({ 'expenses.spec.ts': [1] });
    const loggedOut = { ...authedFile, code: 'test.use({ storageState: { cookies: [], origins: [] } });' };
    await runTests([loggedOut], mockConfig, '/work', { rotates: false, stopped: false });
    expect(ranFiles()).toEqual(['expenses.spec.ts']);
  });

  it('never restores a session file it did not move aside', async () => {
    mockExistsSync.mockImplementation((p: string) => p !== session);
    exitCodes({ 'auth.setup.ts': [1] });
    await runTests([authedFile], mockConfig, '/work', { rotates: true, stopped: false });
    expect(mockRenameSync).not.toHaveBeenCalled();
  });

  it('restores the earlier session and stops renewing when signing in again fails', async () => {
    exitCodes({ 'auth.setup.ts': [1] });
    const renewal = { rotates: true, stopped: false };
    const results = await runTests([authedFile, authedFile], mockConfig, '/work', renewal);
    expect(ranFiles()).toEqual(['auth.setup.ts', 'expenses.spec.ts', 'expenses.spec.ts']);
    expect(mockRenameSync).toHaveBeenLastCalledWith(`${session}.prev`, session);
    expect(renewal.stopped).toBe(true);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('reuses the earlier session'));
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('treats a setup that exits cleanly without writing the session as a failed renewal', async () => {
    // The session exists until it is moved aside; the setup then writes nothing.
    let moved = false;
    mockRenameSync.mockImplementation((from: string) => {
      moved = from === session ? true : moved;
    });
    mockExistsSync.mockImplementation((p: string) => p !== session || !moved);
    const renewal = { rotates: true, stopped: false };
    await runTests([authedFile], mockConfig, '/work', renewal);
    expect(renewal.stopped).toBe(true);
    expect(mockRenameSync).toHaveBeenLastCalledWith(`${session}.prev`, session);
  });

  it('does not let a renewal exception abort the run', async () => {
    mockRenameSync.mockImplementationOnce(() => {
      throw new Error('EBUSY');
    });
    const renewal = { rotates: true, stopped: false };
    const results = await runTests([authedFile], mockConfig, '/work', renewal);
    expect(renewal.stopped).toBe(true);
    expect(results).toHaveLength(1);
    expect(ranFiles()).toEqual(['expenses.spec.ts']);
  });
});
