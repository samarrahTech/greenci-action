import * as core from '@actions/core';
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

const DEFAULT_MODEL = 'gpt-4o';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * BYO-LLM provider: calls the OpenAI API directly from the runner with the
 * user's own OPENAI_API_KEY. Code never touches the GreenCI API.
 */
export class OpenAIClient implements ILLMClient {
  private apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        "llm-provider 'openai' requires the OPENAI_API_KEY environment variable. " +
          'Add it to your workflow step: env: { OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }} }',
      );
    }
    this.apiKey = key;
  }

  private async complete(systemPrompt: string, prompt: string, model: string): Promise<string> {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new Error(`OpenAI API returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI API returned an empty response');
    }
    return content;
  }

  async generateTests(context: ChangeContext, config: ActionConfig): Promise<GeneratedTest[]> {
    const model = config.llmModel || DEFAULT_MODEL;
    core.info(`Generating tests via OpenAI API (${model}) — code stays between your runner and OpenAI`);
    const content = await this.complete(TEST_GENERATION_SYSTEM, buildGeneratePrompt(context, config.baseUrl), model);
    return parseTestsFromResponse(content);
  }

  async healTest(request: SelfHealRequest, config: ActionConfig): Promise<GeneratedTest> {
    const model = config.llmModel || DEFAULT_MODEL;
    core.info(`Self-healing via OpenAI API (${model}), attempt ${request.attempt}`);
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
    core.info(`Refining Cypress migration via OpenAI API (${model})`);
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
