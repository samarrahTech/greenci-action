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
export declare function isSensitiveEnvName(name: string): boolean;
/**
 * Build the environment for the Playwright child process: the parent env with
 * the action's credentials removed, plus the supplied overrides.
 */
export declare function buildTestEnv(parentEnv: NodeJS.ProcessEnv, overrides?: Record<string, string>): Record<string, string>;
