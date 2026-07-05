import { OpenAIClient } from '../src/providers/openai';
import { ActionConfig, ChangeContext } from '../src/types';

jest.mock('@actions/core');

const mockConfig: ActionConfig = {
  apiKey: '',
  llmProvider: 'openai',
  llmModel: '',
  awsRegion: 'us-east-1',
  testDir: 'e2e',
  baseUrl: 'http://localhost:3000',
  maxRetries: 2,
  autoCommit: true,
  greenCIApiUrl: 'https://api.greenci.ai',
  mode: 'generate',
  cypressDir: 'cypress/e2e',
};

const mockContext: ChangeContext = {
  routes: [],
  components: [],
  apiEndpoints: [],
  modifiedFiles: [{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, patch: '+x' }],
  summary: '',
};

function openaiResponse(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

describe('OpenAIClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('throws without an API key', () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => new OpenAIClient()).toThrow('OPENAI_API_KEY');
  });

  it('generates tests from parsed code blocks and calls OpenAI directly', async () => {
    const client = new OpenAIClient('sk-test');
    (global.fetch as jest.Mock).mockResolvedValue(
      openaiResponse('```typescript\n// filename: app.spec.ts\ntest.describe("App", () => {});\n```'),
    );

    const tests = await client.generateTests(mockContext, mockConfig);
    expect(tests).toHaveLength(1);
    expect(tests[0].filename).toBe('app.spec.ts');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o');
    expect(body.messages[0].role).toBe('system');
  });

  it('respects the llm-model override', async () => {
    const client = new OpenAIClient('sk-test');
    (global.fetch as jest.Mock).mockResolvedValue(openaiResponse('```ts\ntest("x", () => {});\n```'));
    await client.generateTests(mockContext, { ...mockConfig, llmModel: 'gpt-4.1' });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.model).toBe('gpt-4.1');
  });

  it('returns a healed test with a parsed verdict', async () => {
    const client = new OpenAIClient('sk-test');
    (global.fetch as jest.Mock).mockResolvedValue(
      openaiResponse(
        'VERDICT: {"classification":"test-issue","confidence":0.9,"reasoning":"strict mode"}\n```ts\nfixed code\n```',
      ),
    );

    const healed = await client.healTest(
      {
        test: { filename: 'a.spec.ts', code: 'broken', description: 'd', confidence: 0.5 },
        error: 'strict mode violation',
        attempt: 1,
        context: mockContext,
      },
      mockConfig,
    );
    expect(healed.code).toBe('fixed code');
    expect(healed.verdict?.classification).toBe('test-issue');
  });

  it('keeps the original code when an app bug is suspected', async () => {
    const client = new OpenAIClient('sk-test');
    (global.fetch as jest.Mock).mockResolvedValue(
      openaiResponse(
        'VERDICT: {"classification":"app-bug-suspected","confidence":0.8,"reasoning":"API 500"}\n```ts\nrewritten\n```',
      ),
    );

    const healed = await client.healTest(
      {
        test: { filename: 'a.spec.ts', code: 'original code', description: 'd', confidence: 0.5 },
        error: 'HTTP 500',
        attempt: 1,
        context: mockContext,
      },
      mockConfig,
    );
    expect(healed.code).toBe('original code');
    expect(healed.verdict?.classification).toBe('app-bug-suspected');
  });

  it('throws on API errors with status and detail', async () => {
    const client = new OpenAIClient('sk-test');
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });
    await expect(client.generateTests(mockContext, mockConfig)).rejects.toThrow('OpenAI API returned 429');
  });
});
