import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, SelfHealRequest } from '../types';
/**
 * BYO-LLM provider: calls the OpenAI API directly from the runner with the
 * user's own OPENAI_API_KEY. Code never touches the GreenCI API.
 */
export declare class OpenAIClient implements ILLMClient {
    private apiKey;
    constructor(apiKey?: string);
    private complete;
    generateTests(context: ChangeContext, config: ActionConfig): Promise<GeneratedTest[]>;
    bootstrapTests(journeys: string[], pages: {
        url: string;
        html: string;
    }[], config: ActionConfig, existingTests?: string[]): Promise<GeneratedTest[]>;
    healTest(request: SelfHealRequest, config: ActionConfig): Promise<GeneratedTest>;
    migrateTest(cypressSource: string, staticConversion: string, config: ActionConfig): Promise<string>;
}
//# sourceMappingURL=openai.d.ts.map