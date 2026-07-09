import { ActionConfig, ILLMClient } from './types';
export interface BootstrapOutcome {
    testsGenerated: number;
    testsPassed: number;
    testsFailed: number;
    testsHealed: number;
    prUrl: string | null;
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
