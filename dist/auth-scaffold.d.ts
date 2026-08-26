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
/** Write the setup file into the test dir; returns its absolute path. */
export declare function writeAuthScaffold(workDir: string, testDir: string, loginPath: string): string;
/**
 * Deterministic pre-classification of auth-blocked failures — these must
 * never reach the LLM healer: no selector fix can conjure a session, and
 * every attempt costs an LLM call. Two families:
 *  1. no session was ever produced (missing storageState / credentials unset)
 *  2. the setup project itself failed, so dependent specs never ran — the
 *     real-world case (a broken or slow login) that previously burned
 *     maxRetries heals on every dependent spec.
 */
export type AuthFailureKind = 'missing-session' | 'setup-failed';
/** Which auth family (if any) a failure belongs to — null means "not auth". */
export declare function classifyAuthFailure(error: string | undefined): AuthFailureKind | null;
/** Convenience wrapper: is this failure auth-related at all? */
export declare function isAuthSetupFailure(error: string | undefined): boolean;
