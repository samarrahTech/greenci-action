import * as core from '@actions/core';
import { ActionConfig, LLMProvider, OperationMode } from './types';

/**
 * Boolean action input, any YAML casing. Both failure modes take the caller's
 * safe value instead of a default that does more: an unreadable value (a
 * typo), and an empty one. Empty is not "unset" here: action.yml gives these
 * inputs a default, so the runner only hands over '' when the workflow passed
 * it, typically a `vars.X` expression with X not defined.
 */
function booleanInput(name: string, safe: boolean, whenSafe: string): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  core.warning(
    raw === ''
      ? `${name} was passed an empty value (an undefined variable?) — ${whenSafe}`
      : `${name} must be 'true' or 'false' — ${whenSafe}`,
  );
  return safe;
}

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

  // Register the key with the runner's masker. Workflows that pass it as a
  // literal (or from a var rather than a secret) are otherwise one core.info
  // or one stack trace away from printing it into a public log.
  const apiKey = core.getInput('api-key', { required: apiKeyRequired });
  if (apiKey) core.setSecret(apiKey);

  return {
    apiKey,
    llmProvider: provider as LLMProvider,
    llmModel: core.getInput('llm-model') || '',
    awsRegion: core.getInput('aws-region') || 'us-east-1',
    testDir: core.getInput('test-dir') || 'e2e',
    baseUrl: core.getInput('base-url') || 'http://localhost:3000',
    baseUrlExplicit: core.getInput('base-url') !== '',
    // The heal API caps attempt at 5; clamp so extra retries don't 400
    maxRetries: Math.min(Math.max(parseInt(core.getInput('max-retries') || '2', 10) || 0, 0), 5),
    autoCommit: booleanInput('auto-commit', false, 'not committing tests to the PR branch'),
    sendPageSnapshot: booleanInput('page-snapshot', false, 'not sending page snapshots'),
    greenCIApiUrl: core.getInput('greenci-api-url') || 'https://api.greenci.ai',
    mode,
    cypressDir: core.getInput('cypress-dir') || 'cypress/e2e',
    journeys,
  };
}
