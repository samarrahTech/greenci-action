/**
 * Playwright runs code the model wrote. Whatever is in that process's
 * environment is readable by it — and a poisoned PR can influence what the
 * model writes. So the child process gets the runner's environment minus every
 * credential the action itself holds.
 *
 * What deliberately stays: TEST_USER_EMAIL / TEST_USER_PASSWORD and anything
 * else the repo owner set for their own tests. Those exist to be used by tests;
 * stripping them would break sign-in flows.
 */

/** Exact env names that are the action's own credentials, never the tests'. */
const SENSITIVE_NAMES = new Set([
  // Provider keys for BYO-LLM modes
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_KEY',
  // Bedrock
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  // Repo write access — this is the one that turns a file write into a commit
  'GITHUB_TOKEN',
  'GH_TOKEN',
  // Runner-issued tokens: cache poisoning and OIDC identity theft
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RESULTS_URL',
  // Registry publish tokens
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
]);

/**
 * True for env vars GitHub creates from this action's `with:` block. Every
 * action input lands here as INPUT_<NAME>, which includes INPUT_API-KEY and
 * INPUT_GITHUB-TOKEN, so the whole prefix goes.
 */
function isActionInput(name: string): boolean {
  return name.startsWith('INPUT_');
}

export function isSensitiveEnvName(name: string): boolean {
  return isActionInput(name) || SENSITIVE_NAMES.has(name.toUpperCase());
}

/**
 * Build the environment for the Playwright child process: the parent env with
 * the action's credentials removed, plus the supplied overrides.
 */
export function buildTestEnv(
  parentEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (isSensitiveEnvName(key)) continue;
    env[key] = value;
  }

  return { ...env, ...overrides };
}
