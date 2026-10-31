import { parseTestsFromResponse, parseNoTestsReason, parseGenerateResponse, parseHealVerdict, extractCode, buildGeneratePrompt, buildHealPrompt } from '../src/prompts';
import { ChangeContext } from '../src/types';

const context: ChangeContext = {
  routes: [{ path: '/dashboard', file: 'src/pages/Dashboard.tsx', isNew: true }],
  components: [{ name: 'Button', file: 'src/Button.tsx', isNew: false }],
  apiEndpoints: [{ path: '/api/users', method: 'GET', file: 'src/api.ts', isNew: true }],
  modifiedFiles: [{ filename: 'src/app.ts', status: 'modified', additions: 5, deletions: 2, patch: '+added line' }],
  summary: 'test',
  existingTests: ['// existing test'],
};

describe('buildGeneratePrompt', () => {
  it('includes diff, files, routes, components, apis, existing tests, and base url', () => {
    const prompt = buildGeneratePrompt(context, 'http://localhost:4000');
    expect(prompt).toContain('+added line');
    expect(prompt).toContain('src/app.ts');
    expect(prompt).toContain('/dashboard');
    expect(prompt).toContain('Button');
    expect(prompt).toContain('GET /api/users');
    expect(prompt).toContain('existing test');
    expect(prompt).toContain('http://localhost:4000');
  });
});

describe('buildHealPrompt', () => {
  it('includes test code, error, and attempt', () => {
    const prompt = buildHealPrompt('broken code', 'Timeout error', 2, context);
    expect(prompt).toContain('broken code');
    expect(prompt).toContain('Timeout error');
    expect(prompt).toContain('Attempt: 2');
    expect(prompt).toContain('fundamentally different approach');
  });
});

describe('parseTestsFromResponse', () => {
  it('parses filename-annotated code blocks', () => {
    const content =
      'Here are the tests:\n```typescript\n// filename: auth.spec.ts\nimport { test } from "@playwright/test";\ntest.describe("Auth", () => {});\n```\n' +
      '```ts\n// filename: nav.spec.ts\ntest("nav works", () => {});\n```';
    const tests = parseTestsFromResponse(content);
    expect(tests).toHaveLength(2);
    expect(tests[0].filename).toBe('auth.spec.ts');
    expect(tests[0].description).toBe('Auth');
    expect(tests[1].filename).toBe('nav.spec.ts');
    expect(tests[1].description).toBe('nav works');
  });

  it('falls back to a default filename when annotation is missing', () => {
    const tests = parseTestsFromResponse('```typescript\ntest("x", () => {});\n```');
    expect(tests).toHaveLength(1);
    expect(tests[0].filename).toBe('test-1.spec.ts');
  });

  it('never writes a NO_TESTS answer out as a spec', () => {
    expect(parseTestsFromResponse('NO_TESTS: only a CI workflow changed')).toEqual([]);
  });

  it('falls back to a generated name when the filename hint has no spec suffix', () => {
    const tests = parseTestsFromResponse('```ts\n// filename: login flow\ntest("a", async () => {});\n```');
    expect(tests[0].filename).toBe('test-1.spec.ts');
  });

  it('never writes prose out as a spec when no code blocks exist', () => {
    expect(parseTestsFromResponse('No tests are needed for this change.')).toEqual([]);
  });

  it('accepts other fence tags and CRLF, and skips fenced blocks that are not tests', () => {
    const content = '```tsx\r\n// filename: a.spec.ts\r\ntest("a", async () => {});\r\n```\n```json\n{"version": "2"}\n```';
    const tests = parseTestsFromResponse(content);
    expect(tests).toHaveLength(1);
    expect(tests[0].filename).toBe('a.spec.ts');
  });
});

describe('parseHealVerdict', () => {
  it('parses a verdict line and strips it', () => {
    const { verdict, rest } = parseHealVerdict(
      'VERDICT: {"classification":"app-bug-suspected","confidence":0.8,"reasoning":"500 from API"}\n```ts\ncode\n```',
    );
    expect(verdict.classification).toBe('app-bug-suspected');
    expect(verdict.reasoning).toBe('500 from API');
    expect(rest).not.toContain('VERDICT');
  });

  it('falls back to test-issue when verdict is missing', () => {
    const { verdict } = parseHealVerdict('```ts\ncode\n```');
    expect(verdict.classification).toBe('test-issue');
    expect(verdict.confidence).toBe(0.5);
  });

  it('clamps confidence and coerces unknown classifications', () => {
    const { verdict } = parseHealVerdict('VERDICT: {"classification":"weird","confidence":9}\ncode');
    expect(verdict.classification).toBe('test-issue');
    expect(verdict.confidence).toBe(1);
  });
});

describe('extractCode', () => {
  it('extracts the first code block', () => {
    expect(extractCode('prose\n```typescript\nconst a = 1;\n```\nmore')).toBe('const a = 1;');
  });

  it('returns trimmed content when no code block', () => {
    expect(extractCode('  raw code  ')).toBe('raw code');
  });
});

describe('parseNoTestsReason', () => {
  it('returns the reason from a NO_TESTS line, tolerating preamble and CRLF', () => {
    expect(parseNoTestsReason('Reviewed the diff.\r\n  NO_TESTS:  dependency bump only \r\n')).toBe('dependency bump only');
  });

  it('returns null without the marker or with an empty reason', () => {
    expect(parseNoTestsReason('No tests needed.')).toBeNull();
    expect(parseNoTestsReason('NO_TESTS:  ')).toBeNull();
  });

  it('caps the reason length', () => {
    expect(parseNoTestsReason('NO_TESTS: ' + 'x'.repeat(1000))).toHaveLength(300);
  });
});

describe('parseGenerateResponse', () => {
  it('prefers code over a NO_TESTS line', () => {
    const r = parseGenerateResponse('NO_TESTS: maybe\n```ts\ntest("a", async () => {});\n```');
    expect(r.tests).toHaveLength(1);
    expect(r.skippedReason).toBeUndefined();
  });

  it('honours NO_TESTS when the only fenced block is not a test', () => {
    const r = parseGenerateResponse('NO_TESTS: dependency bump\n```json\n{"version":"2"}\n```');
    expect(r).toEqual({ tests: [], skippedReason: 'dependency bump' });
  });

  it('flags a generation error for prose without the marker', () => {
    expect(parseGenerateResponse('Here are my thoughts.').generationError).toBeDefined();
  });
});
