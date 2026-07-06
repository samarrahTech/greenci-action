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
    expect(body.verdicts).toEqual([
      { filename: 'auth.spec.ts', classification: 'test-issue', reasoning: 'selector drift' },
      { filename: 'checkout.spec.ts', classification: 'app-bug-suspected', reasoning: 'API returns 500' },
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
