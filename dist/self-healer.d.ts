import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, SuspectedBug, TestResult } from './types';
import { type AuthFailureKind } from './auth-scaffold';
export interface HealingOutcome {
    healed: GeneratedTest[];
    results: TestResult[];
    suspectedBugs: SuspectedBug[];
    /** Failures caused by auth (missing session, or a setup that couldn't sign
     *  in) — deterministically classified, never sent to the LLM healer. */
    authBlocked: {
        filename: string;
        error?: string;
        kind: AuthFailureKind;
    }[];
}
export declare function healFailedTests(failedTests: {
    test: GeneratedTest;
    result: TestResult;
}[], context: ChangeContext, config: ActionConfig, llmClient: ILLMClient, workDir: string): Promise<HealingOutcome>;
