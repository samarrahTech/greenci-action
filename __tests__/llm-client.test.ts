import { createLLMClient } from '../src/llm-client';
import { ActionConfig, ChangeContext } from '../src/types';

jest.mock('@actions/core');

const mockConfig: ActionConfig = {
  apiKey: 'mock-key-12345',
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
  routes: [{ path: '/dashboard', file: 'src/pages/Dashboard.tsx', isNew: true }],
  components: [{ name: 'Button', file: 'src/Button.tsx', isNew: false }],
  apiEndpoints: [{ path: '/api/users', method: 'GET', file: 'src/api.ts', isNew: true }],
  modifiedFiles: [{ filename: 'src/app.ts', status: 'modified', additions: 5, deletions: 2, patch: '+line' }],
  summary: 'test',
};

describe('createLLMClient', () => {
  it('should create a client for greenci provider', () => {
    const client = createLLMClient(mockConfig);
    expect(client).toBeDefined();
    expect(client.generateTests).toBeDefined();
    expect(client.healTest).toBeDefined();
  });

  it('should throw for unimplemented providers instead of silently using the hosted API', () => {
    for (const p of ['bedrock', 'azure-openai', 'ollama'] as const) {
      expect(() => createLLMClient({ ...mockConfig, llmProvider: p })).toThrow('not supported yet');
    }
  });

  it('should create BYO clients when env keys are present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(createLLMClient({ ...mockConfig, llmProvider: 'anthropic' })).toBeDefined();
    expect(createLLMClient({ ...mockConfig, llmProvider: 'openai' })).toBeDefined();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('should throw a clear error when a BYO env key is missing', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(() => createLLMClient({ ...mockConfig, llmProvider: 'anthropic' })).toThrow('ANTHROPIC_API_KEY');
    expect(() => createLLMClient({ ...mockConfig, llmProvider: 'openai' })).toThrow('OPENAI_API_KEY');
  });

  it('should throw for unknown provider', () => {
    expect(() => createLLMClient({ ...mockConfig, llmProvider: 'unknown' as unknown as ActionConfig['llmProvider'] })).toThrow('Unknown LLM provider');
  });
});

describe('GreenCIClient', () => {
  let client: ReturnType<typeof createLLMClient>;

  beforeEach(() => {
    client = createLLMClient(mockConfig);
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('generateTests', () => {
    it('should call API and return tests on success', async () => {
      const mockTests = [{ filename: 'e2e/test.spec.ts', code: 'test code', description: 'desc', confidence: 0.9 }];
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ tests: mockTests }),
      });

      const result = await client.generateTests(mockContext, mockConfig);
      expect(result).toEqual(mockTests);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.greenci.ai/v1/generate',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should throw on API error instead of committing mock tests', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
      await expect(client.generateTests(mockContext, mockConfig)).rejects.toThrow(
        'GreenCI test generation failed (HTTP 500)'
      );
    });

    it('should throw on fetch failure', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
      await expect(client.generateTests(mockContext, mockConfig)).rejects.toThrow('Network error');
    });
  });

  describe('healTest', () => {
    it('should return healed test on success', async () => {
      const healedTest = { filename: 'e2e/healed.spec.ts', code: 'healed', description: 'healed', confidence: 0.9 };
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ test: healedTest }),
      });

      const request = {
        test: { filename: 'e2e/test.spec.ts', code: 'broken', description: 'test', confidence: 0.5 },
        error: 'timeout',
        attempt: 1,
        context: mockContext,
      };
      const result = await client.healTest(request, mockConfig);
      expect(result).toEqual(healedTest);
    });

    it('should throw on API failure so the heal attempt is not silently wasted', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, text: async () => '' });
      const originalTest = { filename: 'e2e/test.spec.ts', code: 'original', description: 'test', confidence: 0.5 };
      await expect(
        client.healTest({ test: originalTest, error: 'err', attempt: 1, context: mockContext }, mockConfig)
      ).rejects.toThrow('GreenCI heal API returned 500');
    });

    it('should throw on network error', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('fail'));
      const originalTest = { filename: 'e2e/test.spec.ts', code: 'original', description: 'test', confidence: 0.5 };
      await expect(
        client.healTest({ test: originalTest, error: 'err', attempt: 1, context: mockContext }, mockConfig)
      ).rejects.toThrow('fail');
    });
  });

  describe('migrateTest', () => {
    it('should return refined code on success', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ code: 'refined code' }),
      });
      const result = await client.migrateTest!('cy source', 'static code', mockConfig);
      expect(result).toBe('refined code');
    });

    it('should return static conversion on API error', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 400 });
      const result = await client.migrateTest!('cy source', 'static code', mockConfig);
      expect(result).toBe('static code');
    });

    it('should return static conversion on fetch error', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('fail'));
      const result = await client.migrateTest!('cy source', 'static code', mockConfig);
      expect(result).toBe('static code');
    });
  });
});
