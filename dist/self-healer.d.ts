import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, TestResult } from './types';
export declare function healFailedTests(failedTests: {
    test: GeneratedTest;
    result: TestResult;
}[], context: ChangeContext, config: ActionConfig, llmClient: ILLMClient, workDir: string): Promise<{
    healed: GeneratedTest[];
    results: TestResult[];
}>;
