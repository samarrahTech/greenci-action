import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, SelfHealRequest } from '../types';
/**
 * BYO-LLM provider: calls the Anthropic API directly from the runner with the
 * user's own ANTHROPIC_API_KEY. Code never touches the GreenCI API.
 */
export declare class AnthropicClient implements ILLMClient {
    private client;
    constructor(apiKey?: string);
    private complete;
    generateTests(context: ChangeContext, config: ActionConfig): Promise<GeneratedTest[]>;
    healTest(request: SelfHealRequest, config: ActionConfig): Promise<GeneratedTest>;
    migrateTest(cypressSource: string, staticConversion: string, config: ActionConfig): Promise<string>;
}
//# sourceMappingURL=anthropic.d.ts.map