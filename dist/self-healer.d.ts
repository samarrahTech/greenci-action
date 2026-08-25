import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, SuspectedBug, TestResult } from './types';
export interface HealingOutcome {
    healed: GeneratedTest[];
    results: TestResult[];
    suspectedBugs: SuspectedBug[];
    /** Failures caused by missing auth setup/credentials — deterministically
     *  classified, never sent to the LLM healer. */
    authBlocked: {
        filename: string;
        error?: string;
    }[];
}
export declare function healFailedTests(failedTests: {
    test: GeneratedTest;
    result: TestResult;
}[], context: ChangeContext, config: ActionConfig, llmClient: ILLMClient, workDir: string): Promise<HealingOutcome>;
