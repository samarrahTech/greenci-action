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
      core.warning(`Provider '${config.llmProvider}' not yet implemented, falling back to GreenCI mock`);
      return new GreenCIClient();
    default:
      throw new Error(`Unknown LLM provider: ${config.llmProvider}`);
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
          },
          config: {
            baseUrl: config.baseUrl,
            testDir: config.testDir,
            model: config.llmModel || undefined,
          },
        }),
      });

      if (!response.ok) {
        core.warning(`GreenCI API returned ${response.status}, using mock response`);
        return this.mockGenerateTests(context, config);
      }

      const data = (await response.json()) as { tests: GeneratedTest[] };
      return data.tests;
    } catch (error) {
      core.warning(`GreenCI API call failed: ${error}. Using mock response.`);
      return this.mockGenerateTests(context, config);
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
            routes: request.context.routes,
            components: request.context.components,
            apiEndpoints: request.context.apiEndpoints,
            summary: request.context.summary,
          },
        }),
      });

      if (!response.ok) {
        core.warning(`GreenCI heal API returned ${response.status}, returning original test`);
        return request.test;
      }

      const data = (await response.json()) as { test: GeneratedTest };
      return data.test;
    } catch (error) {
      core.warning(`GreenCI heal API failed: ${error}. Returning original test.`);
      return request.test;
    }
  }

  private mockGenerateTests(context: ChangeContext, config: ActionConfig): GeneratedTest[] {
    const tests: GeneratedTest[] = [];

    // Generate tests for new routes
    for (const route of context.routes) {
      tests.push({
        filename: `${config.testDir}/${route.path.replace(/^\//, '').replace(/\//g, '-') || 'home'}.spec.ts`,
        code: this.mockRouteTest(route.path, config.baseUrl),
        description: `E2E test for route ${route.path}`,
        confidence: 0.8,
      });
    }

    // Generate tests for API endpoints
    for (const endpoint of context.apiEndpoints) {
      tests.push({
        filename: `${config.testDir}/api-${endpoint.path.replace(/^\/api\//, '').replace(/\//g, '-')}.spec.ts`,
        code: this.mockAPITest(endpoint.path, endpoint.method, config.baseUrl),
        description: `API test for ${endpoint.method} ${endpoint.path}`,
        confidence: 0.75,
      });
    }

    // If no specific tests, generate a smoke test for modified components
    if (tests.length === 0 && context.modifiedFiles.length > 0) {
      tests.push({
        filename: `${config.testDir}/smoke.spec.ts`,
        code: this.mockSmokeTest(config.baseUrl),
        description: 'Smoke test for modified components',
        confidence: 0.6,
      });
    }

    return tests;
  }

  private mockRouteTest(route: string, baseUrl: string): string {
    return `import { test, expect } from '@playwright/test';

test.describe('${route}', () => {
  test('should load successfully', async ({ page }) => {
    await page.goto('${baseUrl}${route}');
    await expect(page).toHaveURL('${baseUrl}${route}');
    await expect(page.locator('body')).toBeVisible();
  });

  test('should not have console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('${baseUrl}${route}');
    await page.waitForLoadState('networkidle');
    expect(errors).toHaveLength(0);
  });

  test('should be accessible', async ({ page }) => {
    await page.goto('${baseUrl}${route}');
    const title = await page.title();
    expect(title).toBeTruthy();
  });
});
`;
  }

  private mockAPITest(path: string, method: string, baseUrl: string): string {
    return `import { test, expect } from '@playwright/test';

test.describe('API: ${method} ${path}', () => {
  test('should respond with valid status', async ({ request }) => {
    const response = await request.${method.toLowerCase()}('${baseUrl}${path}');
    expect(response.status()).toBeLessThan(500);
  });

  test('should return valid JSON', async ({ request }) => {
    const response = await request.${method.toLowerCase()}('${baseUrl}${path}');
    if (response.ok()) {
      const body = await response.json();
      expect(body).toBeDefined();
    }
  });
});
`;
  }

  private mockSmokeTest(baseUrl: string): string {
    return `import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('homepage loads successfully', async ({ page }) => {
    await page.goto('${baseUrl}');
    await expect(page).toHaveURL('${baseUrl}');
    await expect(page.locator('body')).toBeVisible();
  });

  test('no JavaScript errors on homepage', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('${baseUrl}');
    await page.waitForLoadState('networkidle');
    expect(errors).toHaveLength(0);
  });
});
`;
  }
}
