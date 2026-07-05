import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, SuspectedBug, TestResult } from './types';
export interface HealingOutcome {
    healed: GeneratedTest[];
    results: TestResult[];
    suspectedBugs: SuspectedBug[];
}
export declare function healFailedTests(failedTests: {
    test: GeneratedTest;
    result: TestResult;
}[], context: ChangeContext, config: ActionConfig, llmClient: ILLMClient, workDir: string): Promise<HealingOutcome>;
