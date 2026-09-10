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
