import * as exec from '@actions/exec';
import { writeTests, runTests, cleanupTests } from '../src/test-runner';
import { ActionConfig, GeneratedTest } from '../src/types';

jest.mock('@actions/core');
jest.mock('@actions/exec');

const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockUnlinkSync = jest.fn();
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
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

  it('writes a minimal config when none exists', () => {
    mockExistsSync.mockReturnValue(false);
    const created = ensurePlaywrightConfig('/work', 'http://localhost:4000', 'e2e');
    expect(created).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('playwright.config.ts'),
      expect.stringContaining("baseURL: 'http://localhost:4000'"),
      'utf-8'
    );
  });

  it('does nothing when a config already exists', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('playwright.config.js'));
    const created = ensurePlaywrightConfig('/work', 'http://localhost:4000', 'e2e');
    expect(created).toBe(false);
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
