import { GeneratedTest } from './types';
/**
 * Option B of the auth architecture (see greenci-internal/auth-testing-options.md):
 * when generated specs reference storageState, commit a ready-to-run
 * auth.setup.ts alongside them. The customer adds TEST_USER_EMAIL and
 * TEST_USER_PASSWORD as GitHub secrets and re-runs — credentials only ever
 * exist in their own CI environment.
 */
export declare const STORAGE_STATE_PATH = "playwright/.auth/user.json";
export declare const AUTH_SETUP_FILENAME = "auth.setup.ts";
/** Do any generated specs opt into an authenticated session? */
export declare function needsAuthScaffold(tests: GeneratedTest[]): boolean;
/** Best-guess login path: first journey path containing login/signin, else /login. */
export declare function loginPathFromJourneys(journeys: string[]): string;
/**
 * Deterministic, resilient login setup. No LLM involved: the locator chain
 * covers the common form patterns, it is committed plain Playwright the
 * customer can adjust, and a failed run self-reports clearly.
 */
export declare function authSetupSource(loginPath: string): string;
export interface AuthScaffoldResult {
    /** Absolute path of the setup file (ours or the customer's). */
    path: string;
    /** True when this run wrote the file; false when the repo already had one. */
    created: boolean;
}
/**
 * Write the setup file into the test dir — unless the repo already has one.
 * The committed file is the customer's ("this file is yours"): a re-run must
 * never overwrite their edits (a hardened credentials guard, custom locators).
 */
export declare function writeAuthScaffold(workDir: string, testDir: string, loginPath: string): AuthScaffoldResult;
/** Are the customer's test-user credentials present in this environment? */
export declare function hasTestCredentials(env?: NodeJS.ProcessEnv): boolean;
/**
 * Deterministic pre-classification of auth-blocked failures — these must
 * never reach the LLM healer: no selector fix can conjure a session, and
 * every attempt costs an LLM call. Three families:
 *  1. missing-session: no session file and no credentials — the customer has
 *     not added the secrets yet.
 *  2. setup-not-run: no session file although the credentials ARE set — the
 *     login setup never executed for this spec (the repo's own config does not
 *     route it through a setup-dependent project). Telling the customer to
 *     "add the secrets" here is wrong; they need the config wiring.
 *  3. setup-failed: the setup project ran and could not sign in, so dependent
 *     specs never ran — the real-world case (a broken or slow login) that
 *     previously burned maxRetries heals on every dependent spec.
 */
export type AuthFailureKind = 'missing-session' | 'setup-not-run' | 'setup-failed';
/** Which auth family (if any) a failure belongs to — null means "not auth". */
export declare function classifyAuthFailure(error: string | undefined, opts?: {
    hasCredentials?: boolean;
}): AuthFailureKind | null;
/** Convenience wrapper: is this failure auth-related at all? */
export declare function isAuthSetupFailure(error: string | undefined): boolean;
