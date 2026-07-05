import * as core from '@actions/core';
import Anthropic from '@anthropic-ai/sdk';
import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, SelfHealRequest } from '../types';
import {
  TEST_GENERATION_SYSTEM,
  SELF_HEALING_SYSTEM,
  MIGRATION_SYSTEM,
  buildGeneratePrompt,
  buildHealPrompt,
  parseTestsFromResponse,
  parseHealVerdict,
  extractCode,
} from '../prompts';

const DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * BYO-LLM provider: calls the Anthropic API directly from the runner with the
 * user's own ANTHROPIC_API_KEY. Code never touches the GreenCI API.
 */
export class AnthropicClient implements ILLMClient {
  private client: Anthropic;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "llm-provider 'anthropic' requires the ANTHROPIC_API_KEY environment variable. " +
          'Add it to your workflow step: env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }',
      );
    }
    this.client = new Anthropic({ apiKey: key });
  }

  private async complete(systemPrompt: string, prompt: string, model: string): Promise<string> {
    // Stream so long multi-file generations don't hit HTTP timeouts
    const stream = this.client.messages.stream({
      model,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      throw new Error('Anthropic API declined the request (stop_reason: refusal).');
    }

    return message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }

  async generateTests(context: ChangeContext, config: ActionConfig): Promise<GeneratedTest[]> {
    const model = config.llmModel || DEFAULT_MODEL;
    core.info(`Generating tests via Anthropic API (${model}) — code stays between your runner and Anthropic`);
    const content = await this.complete(TEST_GENERATION_SYSTEM, buildGeneratePrompt(context, config.baseUrl), model);
    return parseTestsFromResponse(content);
  }

  async healTest(request: SelfHealRequest, config: ActionConfig): Promise<GeneratedTest> {
    const model = config.llmModel || DEFAULT_MODEL;
    core.info(`Self-healing via Anthropic API (${model}), attempt ${request.attempt}`);
    const content = await this.complete(
      SELF_HEALING_SYSTEM,
      buildHealPrompt(request.test.code, request.error, request.attempt, request.context),
      model,
    );

    const { verdict, rest } = parseHealVerdict(content);
    const code = verdict.classification === 'app-bug-suspected' ? request.test.code : extractCode(rest);

    return {
      filename: request.test.filename,
      code,
      description: `Healed (attempt ${request.attempt})`,
      confidence: verdict.confidence,
      verdict,
    };
  }

  async migrateTest(cypressSource: string, staticConversion: string, config: ActionConfig): Promise<string> {
    const model = config.llmModel || DEFAULT_MODEL;
    core.info(`Refining Cypress migration via Anthropic API (${model})`);
    const prompt =
      '## Original Cypress Test\n```javascript\n' +
      cypressSource +
      '\n```\n\n## Static Conversion\n```typescript\n' +
      staticConversion +
      '\n```\n\nReturn the complete corrected Playwright test file.';
    const content = await this.complete(MIGRATION_SYSTEM, prompt, model);
    return extractCode(content);
  }
}
