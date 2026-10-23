import { ActionConfig, GeneratedTest, TestResult } from './types';
import type { RenamedTest } from './existing-tests';
/**
 * Zero-test repos (the bootstrap audience) usually have neither
 * @playwright/test nor browsers installed. Install what's missing so the
 * first run works out of the box. Returns true if anything was installed.
 */
export declare function ensurePlaywright(workDir: string): Promise<boolean>;
/**
 * Without a Playwright config, relative page.goto('/...') calls fail because
 * there is no baseURL. If the repo has no config, write a minimal one so the
 * generated tests run. Returns true if a config was created (callers should
 * tell the user to add a permanent one).
 */
export declare function ensurePlaywrightConfig(workDir: string, baseUrl: string, testDir: string, withAuthSetup?: boolean): boolean;
/**
 * One Playwright invocation for a single file, with the action's credentials
 * stripped from the child environment (test-env.ts). Both the suite run and the
 * sign-in pass go through here so the env invariant lives in one place.
 */
export declare function runPlaywrightFile(filter: string, workDir: string, config: ActionConfig, env?: NodeJS.ProcessEnv): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
export type AuthSessionStatus = 'ok' | 'skipped' | 'not-wired' | 'failed' | 'no-session-file';
export interface AuthSessionResult {
    status: AuthSessionStatus;
    /** Playwright output, for the failed / not-wired / no-session-file cases. */
    output?: string;
}
/**
 * Sign in once before the suite runs. Specs are executed one file at a time
 * (see runTests), so Playwright project dependencies only produce the session
 * file when the customer's own config routes THAT spec through a project that
 * depends on the setup. A repo that already had a config (TME-web: authed specs
 * listed by name) never wrote playwright/.auth/user.json for a newly generated
 * spec, which then failed with ENOENT and was reported as "add the secrets".
 * Running the setup file explicitly makes the session exist regardless of how
 * the config is wired; the setup's own session reuse keeps a second run cheap.
 */
export declare function ensureAuthSession(workDir: string, config: ActionConfig, env?: NodeJS.ProcessEnv): Promise<AuthSessionResult>;
/**
 * Bootstrap must never rewrite a test the customer already has. The guard
 * lives at write time, against the filesystem, so it holds for every path
 * that reaches writeTests (generation, healing) and for files the prompt's
 * existing-tests list never saw (large files, other extensions). A file this
 * run wrote (`owned`) may be rewritten — that is how healing works.
 */
export interface ProtectExisting {
    /** Absolute paths written by this run; rewriting those is fine. */
    owned: Set<string>;
    /** Collisions with files that were already in the repo, for the PR body. */
    renamed: RenamedTest[];
}
export declare function writeTests(tests: GeneratedTest[], workDir: string, testDir?: string, protect?: ProtectExisting): Promise<string[]>;
export declare function runTests(tests: GeneratedTest[], config: ActionConfig, workDir: string): Promise<TestResult[]>;
export declare function cleanupTests(filePaths: string[]): void;
