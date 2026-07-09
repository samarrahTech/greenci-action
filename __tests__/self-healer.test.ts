import * as core from '@actions/core';
import { healFailedTests } from '../src/self-healer';
import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, TestResult } from '../src/types';
import * as testRunner from '../src/test-runner';

jest.mock('@actions/core');
jest.mock('../src/test-runner');

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
