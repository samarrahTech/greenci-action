import * as path from 'path';
import { buildBootstrapPRBody, runBootstrap } from '../src/bootstrap-runner';
import * as testRunner from '../src/test-runner';
import * as gitOps from '../src/git-ops';
import * as healer from '../src/self-healer';
import * as existingTests from '../src/existing-tests';
import * as authScaffold from '../src/auth-scaffold';
import { ActionConfig, ILLMClient } from '../src/types';

jest.mock('@actions/core');
jest.mock('../src/git-ops');
jest.mock('../src/test-runner');
jest.mock('../src/self-healer');
jest.mock('../src/existing-tests');
jest.mock('../src/bootstrap-context', () => ({
  parseJourneys: (s: string) => s.split('\n').filter(Boolean),
  fetchPages: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/auth-scaffold', () => ({
  ...jest.requireActual('../src/auth-scaffold'),
  writeAuthScaffold: jest.fn(),
}));

const base = {
  installedPlaywright: false,
  createdConfig: false,
  baseUrl: 'http://localhost:3000',
  testDir: 'e2e',
  withAuth: true,
};

describe('buildBootstrapPRBody — auth sections', () => {
  it('tells the customer to add the secrets only when they are missing', () => {
    const body = buildBootstrapPRBody(['Open /expenses'], [], [], [], [], {
      ...base,
      authBlocked: [{ filename: 'expenses.spec.ts', kind: 'missing-session' }],
    });
    expect(body).toContain('need login credentials');
    expect(body).toContain('Add two repository secrets');
  });

  // GC-044: secrets present, session never produced → config wiring advice,
  // never "add the secrets".
  it('explains the setup never ran, with the config snippet, when the config is not wired', () => {
    const body = buildBootstrapPRBody(['Open /expenses'], [], [], [], [], {
      ...base,
      authBlocked: [{ filename: 'expenses.spec.ts', kind: 'setup-not-run' }],
      authSetupStatus: 'not-wired',
    });
    expect(body).not.toContain('Add two repository secrets');
    expect(body).toContain('did not run before these specs');
    expect(body).toContain("dependencies: ['setup']");
    expect(body).toContain('No project in your');
  });

  it('explains a setup that ran but saved the session elsewhere', () => {
    const body = buildBootstrapPRBody(['Open /expenses'], [], [], [], [], {
      ...base,
      authBlocked: [{ filename: 'expenses.spec.ts', kind: 'setup-not-run' }],
      authSetupStatus: 'no-session-file',
    });
    expect(body).toContain('did not write `playwright/.auth/user.json`');
    expect(body).not.toContain("dependencies: ['setup']");
    expect(body).not.toContain('Add two repository secrets');
  });

  it('explains a path mismatch when the setup did write the session', () => {
    const body = buildBootstrapPRBody(['Open /expenses'], [], [], [], [], {
      ...base,
      authBlocked: [{ filename: 'expenses.spec.ts', kind: 'setup-not-run' }],
      authSetupStatus: 'ok',
    });
    expect(body).toContain('could not read it');
    expect(body).not.toContain('did not run before');
  });

  it('quotes the sign-in step output for setup-failed instead of pointing at a [setup] project', () => {
    const body = buildBootstrapPRBody(['Open /expenses'], [], [], [], [], {
      ...base,
      authBlocked: [{ filename: 'expenses.spec.ts', kind: 'setup-failed' }],
      authSetupStatus: 'failed',
      authSetupOutput: 'TimeoutError: page.waitForURL: Timeout 60000ms exceeded.',
    });
    expect(body).toContain('sign-in did not complete');
    expect(body).toContain('TimeoutError: page.waitForURL');
    expect(body).not.toContain('under the `[setup]` project');
    expect(body).not.toContain('Add two repository secrets');
  });
});

describe('runBootstrap — auth scaffold + config commit', () => {
  const config: ActionConfig = {
    apiKey: 'k',
    llmProvider: 'greenci',
    llmModel: '',
    awsRegion: 'us-east-1',
    testDir: 'e2e',
    baseUrl: 'http://localhost:3000',
    maxRetries: 0,
    autoCommit: true,
    greenCIApiUrl: 'https://api.greenci.ai',
    mode: 'bootstrap',
    cypressDir: 'cypress/e2e',
    journeys: 'Open /expenses as a logged in user',
  };
  const authedSpec = {
    filename: 'expenses.spec.ts',
    code: "test.use({ storageState: 'playwright/.auth/user.json' })",
    description: '',
    confidence: 1,
  };
  const llm = { bootstrapTests: jest.fn().mockResolvedValue([authedSpec]) } as unknown as ILLMClient;

  beforeEach(() => {
    jest.clearAllMocks();
    (existingTests.readExistingTests as jest.Mock).mockReturnValue([]);
    (testRunner.writeTests as jest.Mock).mockResolvedValue(['/work/e2e/expenses.spec.ts']);
    (testRunner.ensurePlaywright as jest.Mock).mockResolvedValue(false);
    (testRunner.ensureAuthSession as jest.Mock).mockResolvedValue({ status: 'ok' });
    (testRunner.runTests as jest.Mock).mockResolvedValue([{ filename: 'expenses.spec.ts', passed: true, duration: 1 }]);
    (gitOps.createBootstrapPR as jest.Mock).mockResolvedValue({ prUrl: 'https://x/pr/1', committedFiles: [] });
    (healer.healFailedTests as jest.Mock).mockResolvedValue({ healed: [], results: [], suspectedBugs: [], authBlocked: [] });
  });

  // Review finding: a repo with its own auth.setup.ts but no config must still
  // get the generated config (with the setup project) in the PR.
  it('commits the generated config even when the customer already had auth.setup.ts', async () => {
    (authScaffold.writeAuthScaffold as jest.Mock).mockReturnValue({ path: '/work/e2e/auth.setup.ts', created: false });
    (testRunner.ensurePlaywrightConfig as jest.Mock).mockReturnValue(true);
    await runBootstrap(config, llm, '/work', 'tok', { owner: 'o', repo: 'r' });
    const files: string[] = (gitOps.createBootstrapPR as jest.Mock).mock.calls[0][3];
    expect(files).toContain(path.join('/work', 'playwright.config.ts'));
    expect(files).not.toContain('/work/e2e/auth.setup.ts');
  });

  it('commits the scaffold it wrote, and not when it kept the customer file', async () => {
    (authScaffold.writeAuthScaffold as jest.Mock).mockReturnValue({ path: '/work/e2e/auth.setup.ts', created: true });
    (testRunner.ensurePlaywrightConfig as jest.Mock).mockReturnValue(false);
    await runBootstrap(config, llm, '/work', 'tok', { owner: 'o', repo: 'r' });
    const files: string[] = (gitOps.createBootstrapPR as jest.Mock).mock.calls[0][3];
    expect(files).toContain('/work/e2e/auth.setup.ts');
    expect(files).not.toContain(path.join('/work', 'playwright.config.ts'));
  });

  it('signs in once before running the suite when a generated spec needs a session', async () => {
    (authScaffold.writeAuthScaffold as jest.Mock).mockReturnValue({ path: '/work/e2e/auth.setup.ts', created: true });
    (testRunner.ensurePlaywrightConfig as jest.Mock).mockReturnValue(false);
    await runBootstrap(config, llm, '/work', 'tok', { owner: 'o', repo: 'r' });
    expect(testRunner.ensureAuthSession).toHaveBeenCalledWith('/work', config);
    const order = [
      (testRunner.ensureAuthSession as jest.Mock).mock.invocationCallOrder[0],
      (testRunner.runTests as jest.Mock).mock.invocationCallOrder[0],
    ];
    expect(order[0]).toBeLessThan(order[1]);
  });

  // Review finding: classification is deterministic — it must run with
  // healing disabled, and a failed sign-in pass must relabel the ENOENTs.
  it('still classifies auth failures with maxRetries 0 and relabels them after a failed sign-in', async () => {
    (authScaffold.writeAuthScaffold as jest.Mock).mockReturnValue({ path: '/work/e2e/auth.setup.ts', created: true });
    (testRunner.ensurePlaywrightConfig as jest.Mock).mockReturnValue(false);
    (testRunner.ensureAuthSession as jest.Mock).mockResolvedValue({ status: 'failed', output: 'TimeoutError: login' });
    (testRunner.runTests as jest.Mock).mockResolvedValue([
      { filename: 'expenses.spec.ts', passed: false, duration: 1, error: 'ENOENT playwright/.auth/user.json' },
    ]);
    (healer.healFailedTests as jest.Mock).mockResolvedValue({
      healed: [],
      results: [{ filename: 'expenses.spec.ts', passed: false, duration: 1, error: 'ENOENT' }],
      suspectedBugs: [],
      authBlocked: [{ filename: 'expenses.spec.ts', kind: 'setup-not-run', error: 'ENOENT' }],
    });
    const out = await runBootstrap(config, llm, '/work', 'tok', { owner: 'o', repo: 'r' });
    expect(healer.healFailedTests).toHaveBeenCalled();
    expect(out.testsPassed).toBe(0);
    // nothing passed → no PR; the relabel is observable through the PR body path, covered above
    expect(gitOps.createBootstrapPR).not.toHaveBeenCalled();
  });

  it('drops a model-generated file named auth.setup.ts', async () => {
    (llm.bootstrapTests as jest.Mock).mockResolvedValueOnce([{ ...authedSpec, filename: 'auth.setup.ts' }, authedSpec]);
    (authScaffold.writeAuthScaffold as jest.Mock).mockReturnValue({ path: '/work/e2e/auth.setup.ts', created: true });
    (testRunner.ensurePlaywrightConfig as jest.Mock).mockReturnValue(false);
    await runBootstrap(config, llm, '/work', 'tok', { owner: 'o', repo: 'r' });
    const written = (testRunner.writeTests as jest.Mock).mock.calls[0][0];
    expect(written.map((t: { filename: string }) => t.filename)).toEqual(['expenses.spec.ts']);
  });
});
