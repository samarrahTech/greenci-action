import { ActionConfig, GeneratedTest, ILLMClient, SuspectedBug, TestResult } from './types';
import { type AuthFailureKind } from './auth-scaffold';
import { type RenamedTest } from './existing-tests';
import { type AuthSessionStatus } from './test-runner';
import { type RejectedTest } from './assertion-lint';
export interface BootstrapOutcome {
    testsGenerated: number;
    testsPassed: number;
    testsFailed: number;
    testsHealed: number;
    prUrl: string | null;
    /** Generated specs dropped by the tautology lint (see assertion-lint.ts). */
    rejected: RejectedTest[];
}
/**
 * Bootstrap mode: build a foundational suite for an app with no tests.
 * Journeys (plain English) + rendered page HTML → generate → run → heal →
 * open a PR with the passing suite.
 */
export declare function runBootstrap(config: ActionConfig, llmClient: ILLMClient, workDir: string, token: string, repo: {
    owner: string;
    repo: string;
}): Promise<BootstrapOutcome>;
export declare function buildBootstrapPRBody(journeys: string[], passed: TestResult[], failed: TestResult[], healed: GeneratedTest[], suspectedBugs: SuspectedBug[], setup: {
    installedPlaywright: boolean;
    createdConfig: boolean;
    baseUrl: string;
    testDir: string;
    authBlocked: {
        filename: string;
        error?: string;
        kind: AuthFailureKind;
    }[];
    withAuth: boolean;
    authSetupStatus?: AuthSessionStatus;
    authSetupOutput?: string;
    renamed?: RenamedTest[];
    rejected?: RejectedTest[];
}): string;
