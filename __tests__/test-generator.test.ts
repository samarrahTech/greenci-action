import { ChangeContext, GeneratedTest, ILLMClient, ActionConfig } from '../src/types';

// Mock the test-runner module
jest.mock('../src/test-runner', () => ({
  // Mirror the real contract: writeTests returns the absolute paths it wrote,
  // which correspond to the tests it was given (mockTest is e2e/dashboard.spec.ts
  // under workDir '/tmp' with testDir 'e2e').
  writeTests: jest.fn().mockResolvedValue(['/tmp/e2e/dashboard.spec.ts']),
  runTests: jest.fn().mockResolvedValue([{ filename: 'e2e/test.spec.ts', passed: true, duration: 100 }]),
  ensurePlaywright: jest.fn().mockResolvedValue(false),
  ensurePlaywrightConfig: jest.fn().mockReturnValue(null),
}));

jest.mock('../src/self-healer', () => ({
  healFailedTests: jest.fn().mockResolvedValue({ healed: [], results: [], suspectedBugs: [], authBlocked: [] }),
}));

// Fixtures below use placeholder code ('test code', 'fixed code'); the
// tautology lint would reject every one of them, so it is stubbed to accept
// here. assertion-lint.test.ts covers the lint itself; the rejection paths get
// their own cases in this file by overriding the stub.
jest.mock('../src/assertion-lint', () => ({
  ...jest.requireActual('../src/assertion-lint'),
  lintAssertions: jest.fn(() => ({ ok: true, total: 1, vacuous: [] })),
  rejectTautologies: jest.fn((tests: unknown[]) => ({ kept: tests, rejected: [] })),
}));
import { rejectTautologies } from '../src/assertion-lint';
import { generateAndRunTests } from '../src/test-generator';

// Mock @actions/core
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  setFailed: jest.fn(),
  getInput: jest.fn(),
}));

describe('generateAndRunTests', () => {
  const mockConfig: ActionConfig = {
    apiKey: 'test-key',
    llmProvider: 'greenci',
    llmModel: '',
    awsRegion: 'us-east-1',
    testDir: 'e2e',
    baseUrl: 'http://localhost:3000',
    mode: 'generate',
    cypressDir: 'cypress/e2e',
  journeys: '',
    maxRetries: 2,
    autoCommit: true,
    greenCIApiUrl: 'https://api.greenci.ai',
  };

  const mockContext: ChangeContext = {
    routes: [{ path: '/dashboard', file: 'app/dashboard/page.tsx', isNew: true }],
    components: [],
    apiEndpoints: [],
    modifiedFiles: [
      { filename: 'app/dashboard/page.tsx', status: 'added', additions: 20, deletions: 0 },
    ],
    summary: '1 file(s) changed',
  };

  const mockTest: GeneratedTest = {
    filename: 'e2e/dashboard.spec.ts',
    code: 'test code',
    description: 'Dashboard test',
    confidence: 0.8,
  };

  const mockLLMClient: ILLMClient = {
    generateTests: jest.fn().mockResolvedValue([mockTest]),
    healTest: jest.fn().mockResolvedValue(mockTest),
  };

  it('should generate and run tests successfully', async () => {
    const report = await generateAndRunTests(mockContext, mockConfig, mockLLMClient, '/tmp');

    expect(mockLLMClient.generateTests).toHaveBeenCalledWith(mockContext, mockConfig);
    expect(report.testsGenerated).toBe(1);
    expect(report.testsPassed).toBe(1);
    expect(report.testsFailed).toBe(0);
  });

  it('drops tautological tests before writing and reports them', async () => {
    const hollow: GeneratedTest = { filename: 'e2e/hollow.spec.ts', code: 'expect(true).toBe(true)', description: '', confidence: 1 };
    const real: GeneratedTest = { filename: 'e2e/dashboard.spec.ts', code: 'real', description: '', confidence: 1 };
    (rejectTautologies as jest.Mock).mockReturnValueOnce({
      kept: [real],
      rejected: [{ filename: hollow.filename, reason: 'every assertion is unfalsifiable' }],
    });
    const client: ILLMClient = {
      generateTests: jest.fn().mockResolvedValue([hollow, real]),
      healTest: jest.fn(),
    };

    const report = await generateAndRunTests(mockContext, mockConfig, client, '/tmp');

    expect(rejectTautologies).toHaveBeenCalledWith([hollow, real]);
    expect(report.testsGenerated).toBe(1);
    expect(report.rejectedTests).toEqual([{ filename: 'e2e/hollow.spec.ts', reason: 'every assertion is unfalsifiable' }]);
  });

  it('should return empty report when no tests generated', async () => {
    const emptyClient: ILLMClient = {
      generateTests: jest.fn().mockResolvedValue([]),
      healTest: jest.fn(),
    };

    const report = await generateAndRunTests(mockContext, mockConfig, emptyClient, '/tmp');
    expect(report.testsGenerated).toBe(0);
    expect(report.tests).toHaveLength(0);
  });
});
