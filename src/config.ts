import * as core from '@actions/core';
import { ActionConfig, LLMProvider, OperationMode } from './types';

export function getConfig(): ActionConfig {
  const provider = core.getInput('llm-provider') || 'greenci';
  const validProviders: LLMProvider[] = ['greenci', 'bedrock', 'azure-openai', 'openai', 'ollama'];

  if (!validProviders.includes(provider as LLMProvider)) {
    throw new Error(`Invalid LLM provider: ${provider}. Must be one of: ${validProviders.join(', ')}`);
  }

  const mode = (core.getInput('mode') || 'generate') as OperationMode;
  if (mode !== 'generate' && mode !== 'generate-only' && mode !== 'migrate') {
    throw new Error(`Invalid mode: ${mode}. Must be 'generate', 'generate-only', or 'migrate'.`);
  }

  return {
    apiKey: core.getInput('api-key', { required: true }),
    llmProvider: provider as LLMProvider,
    llmModel: core.getInput('llm-model') || '',
    awsRegion: core.getInput('aws-region') || 'us-east-1',
    testDir: core.getInput('test-dir') || 'e2e',
    baseUrl: core.getInput('base-url') || 'http://localhost:3000',
    maxRetries: parseInt(core.getInput('max-retries') || '2', 10),
    autoCommit: (core.getInput('auto-commit') || 'true') === 'true',
    greenCIApiUrl: core.getInput('greenci-api-url') || 'https://api.greenci.ai',
    mode,
    cypressDir: core.getInput('cypress-dir') || 'cypress/e2e',
  };
}
