import * as core from '@actions/core';
import { uploadResults } from '../src/results-uploader';
import { PRContext, RunReport } from '../src/types';

jest.mock('@actions/core');

const prContext: PRContext = {
  owner: 'acme',
  repo: 'web-app',
  prNumber: 7,
  baseSha: 'base',
  headSha: 'abc123def456',
  branch: 'feature/login',
};

const report: RunReport = {
  testsGenerated: 4,
  testsPassed: 3,
  testsFailed: 1,
  testsHealed: 1,
  filesChanged: ['src/app.ts'],
  duration: 12000,
  tests: [],
  committedFiles: [],
  healedTests: [
    {
      filename: 'auth.spec.ts',
      code: 'fixed',
      description: 'healed',
      confidence: 0.9,
      verdict: { classification: 'test-issue', confidence: 0.9, reasoning: 'selector drift' },
    },
  ],
  suspectedBugs: [{ filename: 'checkout.spec.ts', reasoning: 'API returns 500', error: 'HTTP 500' }],
};

describe('uploadResults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('posts the run summary with verdicts to /v1/results', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

    await uploadResults('https://api.greenci.ai', 'gci_key', prContext, report);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.greenci.ai/v1/results');
    expect(init.headers.Authorization).toBe('Bearer gci_key');
    const body = JSON.parse(init.body);
    expect(body.repository).toBe('acme/web-app');
    expect(body.commit).toBe('abc123def456');
    expect(body.pr_number).toBe(7);
    expect(body.total_tests).toBe(4);
    expect(body.passed_tests).toBe(3);
    expect(body.failed_tests).toBe(1);
    expect(body.self_healing_events).toBe(1);
    expect(body.suspected_app_bugs).toBe(1);
    // Suspected app bugs first: they are what is kept when the list is capped.
    expect(body.verdicts).toEqual([
      { filename: 'checkout.spec.ts', classification: 'app-bug-suspected', reasoning: 'API returns 500' },
      { filename: 'auth.spec.ts', classification: 'test-issue', reasoning: 'selector drift' },
    ]);
  });

  it('warns but does not throw on API failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, statusText: 'boom' });
    await expect(uploadResults('https://api.greenci.ai', 'k', prContext, report)).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Results upload failed'));
  });

  it('warns but does not throw on network error', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
    await expect(uploadResults('https://api.greenci.ai', 'k', prContext, report)).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Results upload error'));
  });
});

// GC-107: verdicts went up whole. A run with many long ones passed the API's
// 2 MB request limit and was dropped with a 413.
describe('verdict limits', () => {
  const { buildVerdicts } = jest.requireActual('../src/results-uploader');
  const healed = (n: number, reasoning: unknown) =>
    Array.from({ length: n }, (_, i) => ({
      filename: `healed-${i}.spec.ts`,
      code: 'x',
      description: 'd',
      confidence: 1,
      verdict: { classification: 'test-issue', confidence: 1, reasoning },
    }));

  it('keeps a worst-case run far below the 2 MB request limit', async () => {
    (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({ ok: true });
    const big: RunReport = {
      ...report,
      healedTests: healed(400, 'r'.repeat(20000)) as RunReport['healedTests'],
      suspectedBugs: Array.from({ length: 10 }, (_, i) => ({ filename: `bug-${i}.spec.ts`, reasoning: 'b'.repeat(20000), error: 'e' })),
    };

    await uploadResults('https://api.greenci.ai', 'k', prContext, big);

    const body = (global.fetch as jest.Mock).mock.calls[0][1].body as string;
    expect(body.length).toBeLessThan(300_000);
    const { verdicts } = JSON.parse(body);
    expect(verdicts).toHaveLength(50);
    expect(verdicts.slice(0, 10).every((v: { classification: string }) => v.classification === 'app-bug-suspected')).toBe(true);
    expect(verdicts.every((v: { reasoning: string }) => v.reasoning.length <= 4096)).toBe(true);
    // The count still reports every suspected bug, capped list or not.
    expect(JSON.parse(body).suspected_app_bugs).toBe(10);
  });

  it('keeps the end of a long filename and the start of long reasoning', () => {
    const [v] = buildVerdicts({
      ...report,
      healedTests: [],
      suspectedBugs: [{ filename: `${'d/'.repeat(400)}checkout.spec.ts`, reasoning: `START${'x'.repeat(5000)}END`, error: 'e' }],
    });
    expect(v.filename).toHaveLength(512);
    expect(v.filename.startsWith('…')).toBe(true);
    expect(v.filename.endsWith('checkout.spec.ts')).toBe(true);
    expect(v.reasoning.startsWith('START')).toBe(true);
    expect(v.reasoning).toHaveLength(4096);
    expect(v.reasoning.endsWith('…')).toBe(true);
  });

  it('never cuts a character pair in half', () => {
    const { clipEnd, clipStart } = jest.requireActual('../src/results-uploader');
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    for (const pad of ['', 'a']) {
      const s = pad + '😀'.repeat(40);
      expect(lone.test(clipEnd(s, 20))).toBe(false);
      expect(lone.test(clipStart(s, 20))).toBe(false);
      expect(clipEnd(s, 20).length).toBeLessThanOrEqual(20);
      expect(clipStart(s, 20).length).toBeLessThanOrEqual(20);
    }
  });

  it('keeps a malformed classification from getting the whole report rejected', () => {
    const verdicts = buildVerdicts({
      ...report,
      suspectedBugs: [],
      healedTests: [
        ...healed(1, 'r').map((t) => ({ ...t, verdict: { ...t.verdict, classification: 'x'.repeat(200) } })),
        ...healed(1, 'r').map((t) => ({ ...t, verdict: { ...t.verdict, classification: undefined } })),
      ] as RunReport['healedTests'],
    });
    expect(verdicts[0].classification).toHaveLength(64);
    expect(verdicts[1].classification).toBe('unknown');
  });

  it('keeps reasoning that came back as something other than a string', () => {
    const verdicts = buildVerdicts({
      ...report,
      suspectedBugs: [],
      healedTests: [...healed(1, ['selector drift', 'label renamed']), ...healed(1, 42)] as RunReport['healedTests'],
    });
    expect(verdicts.map((v: { reasoning: string }) => v.reasoning)).toEqual(['selector drift label renamed', '42']);
  });

  it('says so in the log when verdicts are left out', () => {
    buildVerdicts({ ...report, suspectedBugs: [], healedTests: healed(60, 'r') as RunReport['healedTests'] });
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('60 verdicts this run; the dashboard keeps 50'));
  });

  it('sends an empty reasoning when the heal verdict came back without one', () => {
    const [v] = buildVerdicts({ ...report, suspectedBugs: [], healedTests: healed(1, undefined) as RunReport['healedTests'] });
    expect(v).toEqual({ filename: 'healed-0.spec.ts', classification: 'test-issue', reasoning: '' });
  });
});
