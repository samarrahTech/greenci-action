import * as core from '@actions/core';
import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, SelfHealRequest } from './types';

const MIGRATION_PROMPT = `You are an expert at migrating Cypress E2E tests to Playwright.
You will receive:
1. The original Cypress test source code
2. A static (regex-based) conversion attempt

Your job:
- Fix any conversion errors in the static conversion
- Improve selectors to use accessible Playwright locators (getByRole, getByLabel, getByText) where appropriate
- Ensure proper async/await on all Playwright actions
- Replace any remaining cy.* commands with Playwright equivalents
- Handle custom Cypress commands by inlining their likely behavior or adding TODO comments
- Ensure proper Playwright test structure (test.describe, test, fixtures)
- Add proper imports from '@playwright/test'
- Return ONLY the complete converted Playwright test file code, no explanations.`;

export function createLLMClient(config: ActionConfig): ILLMClient {
  switch (config.llmProvider) {
    case 'greenci':
      return new GreenCIClient();
    case 'bedrock':
    case 'openai':
    case 'azure-openai':
    case 'ollama':
      // Do NOT silently fall back to the hosted API: users choosing their own
      // provider often do so for data-privacy reasons, and their code must not
      // leave their environment without an explicit opt-in.
      throw new Error(
        `LLM provider '${config.llmProvider}' is not supported yet. ` +
          `Set llm-provider to 'greenci' (hosted) or watch the roadmap for BYO-LLM support.`,
      );
    default:
      throw new Error(`Unknown LLM provider: ${config.llmProvider}`);
  }
}

/** Read an error body safely for diagnostics without throwing. */
async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}

class GreenCIClient implements ILLMClient {
  async migrateTest(cypressSource: string, staticConversion: string, config: ActionConfig): Promise<string> {
    core.info('Calling GreenCI API for migration refinement');

    try {
      const response = await fetch(`${config.greenCIApiUrl}/v1/migrate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          cypressSource,
          staticConversion,
          model: config.llmModel || undefined,
          prompt: MIGRATION_PROMPT,
        }),
      });

      if (!response.ok) {
        core.warning(`GreenCI migrate API returned ${response.status}, using static conversion`);
        return staticConversion;
      }

      const data = (await response.json()) as { code: string };
      return data.code;
    } catch (error) {
      core.warning(`GreenCI migrate API failed: ${error}. Using static conversion.`);
      return staticConversion;
    }
  }

  async generateTests(context: ChangeContext, config: ActionConfig): Promise<GeneratedTest[]> {
    core.info(`Calling GreenCI API at ${config.greenCIApiUrl}/v1/generate`);

    try {
      // Build diff from patches
      const diff = context.modifiedFiles
        .map((f) => f.patch || '')
        .filter(Boolean)
        .join('\n');

      const response = await fetch(`${config.greenCIApiUrl}/v1/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          context: {
            diff,
            changedFiles: context.modifiedFiles.map((f) => f.filename),
            routes: context.routes.map((r) => r.path),
            components: context.components.map((c) => c.name),
            apis: context.apiEndpoints.map((e) => `${e.method} ${e.path}`),
            existingTests: context.existingTests,
          },
          config: {
            baseUrl: config.baseUrl,
            testDir: config.testDir,
            model: config.llmModel || undefined,
          },
        }),
      });

      if (!response.ok) {
        const body = await readErrorBody(response);
        throw new Error(
          `GreenCI test generation failed (HTTP ${response.status})${body ? `: ${body}` : ''}. ` +
            `Check that your greenci-api-key is valid and your plan has remaining quota. No tests were generated.`,
        );
      }

      const data = (await response.json()) as { tests: GeneratedTest[] };
      return data.tests;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GreenCI test generation failed')) {
        throw error;
      }
      throw new Error(`GreenCI API call failed: ${error instanceof Error ? error.message : error}. No tests were generated.`);
    }
  }

  async healTest(request: SelfHealRequest, config: ActionConfig): Promise<GeneratedTest> {
    core.info(`Calling GreenCI API for self-healing (attempt ${request.attempt})`);

    try {
      const response = await fetch(`${config.greenCIApiUrl}/v1/heal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          test: request.test,
          error: request.error,
          attempt: request.attempt,
          context: {
            changedFiles: request.context.modifiedFiles?.map(f => f.filename) ?? [],
            routes: request.context.routes,
            components: request.context.components,
            apiEndpoints: request.context.apiEndpoints,
            summary: request.context.summary,
          },
        }),
      });

      if (!response.ok) {
        const body = await readErrorBody(response);
        throw new Error(`GreenCI heal API returned ${response.status}${body ? `: ${body}` : ''}`);
      }

      const data = (await response.json()) as { test: GeneratedTest };
      return data.test;
    } catch (error) {
      // Surface the failure to the self-healing loop; retrying the identical
      // failing test would waste retry attempts and hide the API problem.
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
