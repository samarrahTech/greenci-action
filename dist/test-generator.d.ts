import { ActionConfig, ChangeContext, ILLMClient, RunReport } from './types';
export declare function generateAndRunTests(context: ChangeContext, config: ActionConfig, llmClient: ILLMClient, workDir: string): Promise<RunReport>;
