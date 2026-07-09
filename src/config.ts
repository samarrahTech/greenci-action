import * as core from '@actions/core';
import { ActionConfig, LLMProvider, OperationMode } from './types';

export function getConfig(): ActionConfig {
  const provider = core.getInput('llm-provider') || 'greenci';
  const validProviders: LLMProvider[] = ['greenci', 'anthropic', 'openai', 'bedrock', 'azure-openai', 'ollama'];

  if (!validProviders.includes(provider as LLMProvider)) {
    throw new Error(`Invalid LLM provider: ${provider}. Must be one of: ${validProviders.join(', ')}`);
  }

  const mode = (core.getInput('mode') || 'generate') as OperationMode;
  if (mode !== 'generate' && mode !== 'generate-only' && mode !== 'migrate' && mode !== 'bootstrap') {
    throw new Error(`Invalid mode: ${mode}. Must be 'generate', 'generate-only', 'migrate', or 'bootstrap'.`);
  }

  const journeys = core.getInput('journeys') || '';
  if (mode === 'bootstrap' && !journeys.trim()) {
    throw new Error(
      "mode 'bootstrap' requires the `journeys` input — one critical user journey per line, e.g.\n" +
        'journeys: |\n  Sign in with email and password\n  Post a new job listing and reach the payment step',
    );
  }

  // BYO-LLM providers authenticate with their own env keys; the GreenCI API
  // key is only required for the hosted provider (still used for optional
  // trace uploads if provided).
  const apiKeyRequired = provider === 'greenci';

  return {
    apiKey: core.getInput('api-key', { required: apiKeyRequired }),
    llmProvider: provider as LLMProvider,
    llmModel: core.getInput('llm-model') || '',
    awsRegion: core.getInput('aws-region') || 'us-east-1',
    testDir: core.getInput('test-dir') || 'e2e',
    baseUrl: core.getInput('base-url') || 'http://localhost:3000',
    // The heal API caps attempt at 5; clamp so extra retries don't 400
    maxRetries: Math.min(Math.max(parseInt(core.getInput('max-retries') || '2', 10) || 0, 0), 5),
    autoCommit: (core.getInput('auto-commit') || 'true') === 'true',
    greenCIApiUrl: core.getInput('greenci-api-url') || 'https://api.greenci.ai',
    mode,
    cypressDir: core.getInput('cypress-dir') || 'cypress/e2e',
    journeys,
  };
}
