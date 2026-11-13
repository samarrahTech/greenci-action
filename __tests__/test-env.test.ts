import { buildTestEnv, isSensitiveEnvName } from '../src/test-env';

describe('buildTestEnv', () => {
  // The finding: generated test code ran with the action's own credentials in
  // its environment, so model-authored code could read and exfiltrate them.
  const runnerEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    'INPUT_API-KEY': 'gci_live_secret',
    'INPUT_GITHUB-TOKEN': 'ghs_secret',
    INPUT_BASE_URL: 'http://localhost:3000',
    GITHUB_TOKEN: 'ghs_secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OPENAI_API_KEY: 'sk-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    ACTIONS_RUNTIME_TOKEN: 'runtime-secret',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-secret',
    NPM_TOKEN: 'npm-secret',
    TEST_USER_EMAIL: 'user@example.com',
    TEST_USER_PASSWORD: 'hunter2',
  };

  const env = buildTestEnv(runnerEnv, { BASE_URL: 'http://localhost:3000', CI: 'true' });

  it.each([
    'INPUT_API-KEY',
    'INPUT_GITHUB-TOKEN',
    'INPUT_BASE_URL',
    'GITHUB_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'NPM_TOKEN',
  ])('strips %s', (name) => {
    expect(env).not.toHaveProperty(name);
  });

  it('leaves no secret value anywhere in the resulting env', () => {
    const values = Object.values(env).join('\n');
    for (const secret of ['gci_live_secret', 'ghs_secret', 'sk-ant-secret', 'sk-secret', 'aws-secret', 'runtime-secret', 'oidc-secret', 'npm-secret']) {
      expect(values).not.toContain(secret);
    }
  });

  it('keeps the credentials the tests are meant to use', () => {
    expect(env.TEST_USER_EMAIL).toBe('user@example.com');
    expect(env.TEST_USER_PASSWORD).toBe('hunter2');
  });

  it('keeps ordinary runner variables', () => {
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/runner');
  });

  it('applies overrides', () => {
    expect(env.BASE_URL).toBe('http://localhost:3000');
    expect(env.CI).toBe('true');
  });

  it('drops undefined values rather than passing them through', () => {
    const result = buildTestEnv({ A: undefined, B: 'b' });
    expect(result).not.toHaveProperty('A');
    expect(result.B).toBe('b');
  });

  it('matches sensitive names case-insensitively', () => {
    expect(isSensitiveEnvName('github_token')).toBe(true);
    expect(isSensitiveEnvName('INPUT_ANYTHING')).toBe(true);
    expect(isSensitiveEnvName('TEST_USER_PASSWORD')).toBe(false);
  });
});

// GC-133: the Azure DevOps task ran generated tests with the whole pipeline
// environment, job token included.
describe('Azure DevOps credentials', () => {
  it('strips the job token, the CLI PAT and task inputs', () => {
    const env = buildTestEnv({
      SYSTEM_ACCESSTOKEN: 'job-token',
      AZURE_DEVOPS_EXT_PAT: 'pat',
      INPUT_APIKEY: 'gci_key',
      BUILD_SOURCESDIRECTORY: '/work',
      TEST_USER_EMAIL: 'qa@example.com',
      PATH: '/usr/bin',
    });
    expect(env).toEqual({ BUILD_SOURCESDIRECTORY: '/work', TEST_USER_EMAIL: 'qa@example.com', PATH: '/usr/bin' });
  });

  // Rails and Django apps need these to boot under Playwright's webServer.
  it('keeps variables the repo owner named SECRET_*', () => {
    const env = buildTestEnv({ SECRET_KEY_BASE: 'rails', SECRET_KEY: 'django' });
    expect(env).toEqual({ SECRET_KEY_BASE: 'rails', SECRET_KEY: 'django' });
  });
});
