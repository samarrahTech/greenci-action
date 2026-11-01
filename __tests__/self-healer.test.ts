import * as core from '@actions/core';
import { healFailedTests } from '../src/self-healer';
import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, TestResult } from '../src/types';
import * as testRunner from '../src/test-runner';

jest.mock('@actions/core');
jest.mock('../src/test-runner');
// Fixtures below use placeholder code ('test code', 'fixed code'); the
// tautology lint would reject every one of them, so it is stubbed to accept
// here. assertion-lint.test.ts covers the lint itself; the rejection paths get
// their own cases in this file by overriding the stub.
jest.mock('../src/assertion-lint', () => ({
  ...jest.requireActual('../src/assertion-lint'),
  lintAssertions: jest.fn(() => ({ ok: true, total: 1, vacuous: [] })),
  rejectTautologies: jest.fn((tests: unknown[]) => ({ kept: tests, rejected: [] })),
}));
import { lintAssertions } from '../src/assertion-lint';

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

const mockContext: ChangeContext = {
  routes: [],
  components: [],
  apiEndpoints: [],
  modifiedFiles: [],
  summary: '',
};

const failedTest: GeneratedTest = {
  filename: 'e2e/failing.spec.ts',
  code: 'broken code',
  description: 'failing test',
  confidence: 0.5,
};

const failedResult: TestResult = {
  filename: 'e2e/failing.spec.ts',
  passed: false,
  duration: 1000,
  error: 'Element not found',
};

describe('healFailedTests', () => {
  let mockLLMClient: ILLMClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLLMClient = {
      generateTests: jest.fn(),
      healTest: jest.fn(),
    };
    (testRunner.writeTests as jest.Mock).mockResolvedValue([]);
  });

  it('should heal a test on first attempt', async () => {
    const healedTest = { ...failedTest, code: 'fixed code' };
    (mockLLMClient.healTest as jest.Mock).mockResolvedValue(healedTest);
    (testRunner.runTests as jest.Mock).mockResolvedValue([{ ...failedResult, passed: true }]);

    const { healed, results } = await healFailedTests(
      [{ test: failedTest, result: failedResult }],
      mockContext,
      mockConfig,
      mockLLMClient,
      '/work'
    );

    expect(healed).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(mockLLMClient.healTest).toHaveBeenCalledTimes(1);
  });

  it('rejects a heal that strips every falsifiable assertion and tells the next attempt why', async () => {
    const hollow = { ...failedTest, code: 'expect(page).toHaveURL(/.*/)' };
    const real = { ...failedTest, code: 'await expect(page.getByText("Saved")).toBeVisible()' };
    (lintAssertions as jest.Mock)
      .mockReturnValueOnce({ ok: false, total: 1, vacuous: [], reason: 'every assertion is unfalsifiable' })
      .mockReturnValueOnce({ ok: true, total: 1, vacuous: [] });
    (mockLLMClient.healTest as jest.Mock).mockResolvedValueOnce(hollow).mockResolvedValueOnce(real);
    (testRunner.runTests as jest.Mock).mockResolvedValue([{ ...failedResult, passed: true }]);

    const { healed, results } = await healFailedTests(
      [{ test: failedTest, result: failedResult }],
      mockContext,
      { ...mockConfig, maxRetries: 2 },
      mockLLMClient,
      '/work'
    );

    // The hollow heal never reached disk or the runner.
    expect(testRunner.writeTests).toHaveBeenCalledTimes(1);
    expect(testRunner.writeTests).toHaveBeenCalledWith([real], '/work', mockConfig.testDir, undefined);
    expect(testRunner.runTests).toHaveBeenCalledTimes(1);
    // The second heal request carried the rejection reason.
    const secondRequest = (mockLLMClient.healTest as jest.Mock).mock.calls[1][0];
    expect(secondRequest.attempt).toBe(2);
    expect(secondRequest.test).toBe(failedTest);
    expect(secondRequest.error).toMatch(/GreenCI rejected the previous fix because every assertion is unfalsifiable/);
    expect(healed).toEqual([real]);
    expect(results[0].passed).toBe(true);
  });

  it('sends the healer the page each failing run reached, apart from the error (GC-092)', async () => {
    const firstPage = '- textbox "Vendor" [ref=e5]';
    const secondPage = '- spinbutton "Amount" [ref=e7]';
    (mockLLMClient.healTest as jest.Mock).mockResolvedValue({ ...failedTest, code: 'still broken' });
    (testRunner.runTests as jest.Mock).mockResolvedValue([
      { ...failedResult, error: 'Timeout waiting for getByLabel(\'Amount\')', pageSnapshot: secondPage },
    ]);

    await healFailedTests(
      [{ test: failedTest, result: { ...failedResult, pageSnapshot: firstPage } }],
      mockContext,
      { ...mockConfig, maxRetries: 2 },
      mockLLMClient,
      '/work'
    );

    const [first, second] = (mockLLMClient.healTest as jest.Mock).mock.calls.map((c) => c[0]);
    expect(first.error).toBe('Element not found');
    expect(first.pageSnapshot).toBe(firstPage);
    expect(second.error).toBe('Timeout waiting for getByLabel(\'Amount\')');
    expect(second.pageSnapshot).toBe(secondPage);
  });

  it('keeps the last page when a rerun broke before any page loaded', async () => {
    (mockLLMClient.healTest as jest.Mock).mockResolvedValue({ ...failedTest, code: 'still broken' });
    (testRunner.runTests as jest.Mock).mockResolvedValue([{ ...failedResult, error: 'SyntaxError' }]);

    await healFailedTests(
      [{ test: failedTest, result: { ...failedResult, pageSnapshot: '- textbox "Vendor"' } }],
      mockContext,
      { ...mockConfig, maxRetries: 2 },
      mockLLMClient,
      '/work'
    );

    const second = (mockLLMClient.healTest as jest.Mock).mock.calls[1][0];
    expect(second.error).toBe('SyntaxError');
    expect(second.pageSnapshot).toBe('- textbox "Vendor"');
  });

  it('should retry up to maxRetries', async () => {
    const healedTest = { ...failedTest, code: 'still broken' };
    (mockLLMClient.healTest as jest.Mock).mockResolvedValue(healedTest);
    (testRunner.runTests as jest.Mock).mockResolvedValue([{ ...failedResult, passed: false }]);

    const { healed } = await healFailedTests(
      [{ test: failedTest, result: failedResult }],
      mockContext,
      mockConfig,
      mockLLMClient,
      '/work'
    );

    expect(healed).toHaveLength(0);
    expect(mockLLMClient.healTest).toHaveBeenCalledTimes(2); // maxRetries = 2
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('could not be healed'));
  });

  it('should heal on second attempt', async () => {
    const healedTest = { ...failedTest, code: 'fixed on 2nd' };
    (mockLLMClient.healTest as jest.Mock).mockResolvedValue(healedTest);
    (testRunner.runTests as jest.Mock)
      .mockResolvedValueOnce([{ ...failedResult, passed: false }])
      .mockResolvedValueOnce([{ ...failedResult, passed: true }]);

    const { healed } = await healFailedTests(
      [{ test: failedTest, result: failedResult }],
      mockContext,
      mockConfig,
      mockLLMClient,
      '/work'
    );

    expect(healed).toHaveLength(1);
    expect(mockLLMClient.healTest).toHaveBeenCalledTimes(2);
  });

  it('should handle healTest throwing an error', async () => {
    (mockLLMClient.healTest as jest.Mock).mockRejectedValue(new Error('LLM error'));

    const { healed } = await healFailedTests(
      [{ test: failedTest, result: failedResult }],
      mockContext,
      mockConfig,
      mockLLMClient,
      '/work'
    );

    expect(healed).toHaveLength(0);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Self-healing attempt'));
  });

  it('should not heal and should flag a suspected app bug instead', async () => {
    const suspectedTest: GeneratedTest = {
      ...failedTest,
      code: failedTest.code,
      verdict: { classification: 'app-bug-suspected', confidence: 0.9, reasoning: 'page returns 500' },
    };
    (mockLLMClient.healTest as jest.Mock).mockResolvedValue(suspectedTest);

    const { healed, results, suspectedBugs } = await healFailedTests(
      [{ test: failedTest, result: failedResult }],
      mockContext,
      mockConfig,
      mockLLMClient,
      '/work'
    );

    expect(healed).toHaveLength(0);
    expect(suspectedBugs).toEqual([
      { filename: 'e2e/failing.spec.ts', reasoning: 'page returns 500', error: 'Element not found' },
    ]);
    // The failing result is kept, no further heal attempts, nothing written/run
    expect(results[0].passed).toBe(false);
    expect(mockLLMClient.healTest).toHaveBeenCalledTimes(1);
    expect(testRunner.writeTests).not.toHaveBeenCalled();
    expect(testRunner.runTests).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('possible app regression'));
  });

  it('should heal normally when verdict is test-issue', async () => {
    const healedTest: GeneratedTest = {
      ...failedTest,
      code: 'fixed code',
      verdict: { classification: 'test-issue', confidence: 0.9, reasoning: 'strict mode violation' },
    };
    (mockLLMClient.healTest as jest.Mock).mockResolvedValue(healedTest);
    (testRunner.runTests as jest.Mock).mockResolvedValue([{ ...failedResult, passed: true }]);

    const { healed, suspectedBugs } = await healFailedTests(
      [{ test: failedTest, result: failedResult }],
      mockContext,
      mockConfig,
      mockLLMClient,
      '/work'
    );

    expect(healed).toHaveLength(1);
    expect(healed[0].verdict?.reasoning).toBe('strict mode violation');
    expect(suspectedBugs).toHaveLength(0);
  });

  it('should handle multiple failed tests', async () => {
    const test2: GeneratedTest = { ...failedTest, filename: 'e2e/other.spec.ts' };
    const result2: TestResult = { ...failedResult, filename: 'e2e/other.spec.ts' };

    (mockLLMClient.healTest as jest.Mock).mockResolvedValue({ ...failedTest, code: 'fixed' });
    (testRunner.runTests as jest.Mock).mockResolvedValue([{ passed: true, filename: 'x', duration: 100 }]);

    const { healed } = await healFailedTests(
      [
        { test: failedTest, result: failedResult },
        { test: test2, result: result2 },
      ],
      mockContext,
      mockConfig,
      mockLLMClient,
      '/work'
    );

    expect(healed).toHaveLength(2);
  });
});

// GC-044: the classifier must consult the credentials so the PR gives the
// right instructions (TME-web run 40006504031 told the owner to add secrets
// that were already set).
describe('healFailedTests — auth classification uses the credentials', () => {
  const enoentResult: TestResult = {
    filename: 'e2e/expenses-page-authenticated.spec.ts',
    passed: false,
    duration: 1,
    error: "Error reading storage state from playwright/.auth/user.json:\nENOENT: no such file or directory, open 'playwright/.auth/user.json'",
  };
  const authedTest: GeneratedTest = { filename: 'e2e/expenses-page-authenticated.spec.ts', code: "test.use({ storageState: 'playwright/.auth/user.json' })", description: '', confidence: 1 };
  const llm = { healTest: jest.fn() } as unknown as ILLMClient;

  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const restore = { ...process.env };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      process.env = restore;
    }
  };

  beforeEach(() => jest.clearAllMocks());

  it('is missing-session when the secrets are absent', async () => {
    await withEnv({ TEST_USER_EMAIL: undefined, TEST_USER_PASSWORD: undefined }, async () => {
      const out = await healFailedTests([{ test: authedTest, result: enoentResult }], mockContext, mockConfig, llm, '/work');
      expect(out.authBlocked).toEqual([expect.objectContaining({ kind: 'missing-session' })]);
      expect(llm.healTest).not.toHaveBeenCalled();
    });
  });

  it('is setup-not-run when the secrets are present, and still never heals', async () => {
    await withEnv({ TEST_USER_EMAIL: 'qa@example.com', TEST_USER_PASSWORD: 'pw' }, async () => {
      const out = await healFailedTests([{ test: authedTest, result: enoentResult }], mockContext, mockConfig, llm, '/work');
      expect(out.authBlocked).toEqual([expect.objectContaining({ kind: 'setup-not-run' })]);
      expect(llm.healTest).not.toHaveBeenCalled();
      expect(out.healed).toEqual([]);
    });
  });
});
