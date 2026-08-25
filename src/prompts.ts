import { ChangeContext, GeneratedTest, HealVerdict } from './types';

/**
 * Prompts and response parsing for BYO-LLM providers (anthropic, openai).
 * Kept in sync with greenci-api/src/services/llm/prompts.ts so hosted and
 * BYO modes produce equivalent tests.
 */

export const TEST_GENERATION_SYSTEM = `You are an expert QA engineer specializing in Playwright end-to-end testing. Generate production-quality tests following these practices:

## Locator Rules (CRITICAL — read carefully)
- **Always prefer specific locators:** getByRole > getByLabel > getByTestId > locator('css')
- **NEVER use bare getByText() for elements that may repeat on the page.** Instead:
  - Use getByRole('button', { name: 'Submit' }) over getByText('Submit')
  - Use page.locator('.job-card').first() when targeting one of many similar elements
  - Scope locators: page.locator('.card').filter({ hasText: 'specific' }).getByRole(...)
- **Strict mode:** Playwright fails if a locator matches multiple elements. Always ensure locators resolve to exactly one element, or use .first()/.nth().
- Avoid CSS/XPath selectors unless accessible locators don't work

## Test Quality
- Use web-first assertions (expect(locator).toBeVisible() over waitForSelector)
- Use auto-waiting — no manual waits or page.waitForTimeout()
- Each test should be independent and idempotent
- Use descriptive test names explaining user behavior
- Group related tests in describe blocks

## Test Quantity
- **Generate 3-8 tests per file, not more.** Focus on high-value scenarios.
- One test file per page/feature. Don't split a single page into multiple files.
- Prioritize: (a) user-critical paths, (b) recently changed areas, (c) key error scenarios
- Skip trivial tests ("page loads", "title exists") when meaningful behavior exists
- **Do NOT test behavior that requires a real backend unless the page has client-side validation or static content to verify**

## Assertions
- Only assert things visible in the HTML. Don't assume server responses or dynamic content that isn't in the diff.
- Don't invent success/error messages — only assert messages you can see in the source code

Output format: Return ONLY valid TypeScript/Playwright test code. Each test file should be wrapped in a code block with \`// filename: <name>.spec.ts\` on the first line.`;

export function buildGeneratePrompt(context: ChangeContext, baseUrl: string): string {
  const parts: string[] = [];

  const diff = context.modifiedFiles
    .map((f) => f.patch || '')
    .filter(Boolean)
    .join('\n');

  parts.push('## Code Changes (Diff)\n```diff\n' + diff + '\n```\n');
  parts.push('## Changed Files\n' + context.modifiedFiles.map((f) => `- ${f.filename}`).join('\n') + '\n');

  if (context.routes.length) {
    parts.push('## Routes/Endpoints\n' + context.routes.map((r) => `- ${r.path}`).join('\n') + '\n');
  }
  if (context.components.length) {
    parts.push('## Components\n' + context.components.map((c) => `- ${c.name}`).join('\n') + '\n');
  }
  if (context.apiEndpoints.length) {
    parts.push('## API Endpoints\n' + context.apiEndpoints.map((e) => `- ${e.method} ${e.path}`).join('\n') + '\n');
  }
  if (context.existingTests?.length) {
    parts.push(
      '## Existing Tests\n' +
        'The following tests already exist in the test directory. DO NOT regenerate tests that cover the same behavior. ' +
        'Only generate NEW tests for uncovered functionality or UPDATE existing tests if the code changes affect them. ' +
        'Keep the same filename for updated tests so they overwrite correctly.\n\n' +
        '```\n' +
        context.existingTests.join('\n---\n') +
        '\n```\n',
    );
  }

  parts.push(`## Base URL: ${baseUrl}`);
  parts.push(
    '\nGenerate comprehensive Playwright e2e tests covering the changed functionality. Focus on user-facing behavior. Return each test as a separate code block with `// filename: <name>.spec.ts` on the first line.',
  );

  return parts.join('\n');
}

export const BOOTSTRAP_SYSTEM = `You are an expert QA engineer creating a FOUNDATIONAL Playwright E2E test suite for an existing production web application. You receive plain-English descriptions of the app's critical user journeys, plus the actual rendered HTML of key pages.

## Grounding rules (CRITICAL)
- Base every selector on the PROVIDED page HTML — real labels, roles, names, ids. Never invent elements.
- Prefer accessible locators: getByRole > getByLabel > getByTestId > locator('css'). Ensure strict-mode safety (.first()/.filter() where markup repeats).
- If a journey involves pages whose HTML was not provided, write the navigation steps conservatively (URL assertions, visible landmarks) rather than guessing detailed content.

## Suite structure
- One spec file per journey, named after the journey (e.g. job-posting-checkout.spec.ts).
- 2-6 focused tests per journey: the happy path first, then the highest-value guard rails (validation, empty states).
- Tests must be independent and idempotent. No fixed waits; rely on auto-waiting and web-first assertions.

## Authentication
- If a journey requires a logged-in user, add test.use({ storageState: 'playwright/.auth/user.json' }) at the top of that spec file. Do NOT write TODO comments about creating the auth setup and do NOT include example setup code — the pipeline provides a ready-made auth.setup.ts and config wiring automatically.
- Never hardcode credentials.

## Safety
- NEVER write tests that perform destructive or costly real actions (real payments, sending real emails, deleting records) — stop at the confirmation step and assert the UI state, with a TODO noting where a sandbox/test account is needed.

Output format: Return ONLY valid TypeScript/Playwright code. Each file wrapped in a code block with \`// filename: <name>.spec.ts\` on the first line.`;

export function buildBootstrapPrompt(
  journeys: string[],
  pages: { url: string; html: string }[],
  baseUrl: string,
  existingTests?: string[],
): string {
  const parts: string[] = [];

  parts.push('## Critical User Journeys\n' + journeys.map((j, i) => `${i + 1}. ${j}`).join('\n') + '\n');

  if (pages.length > 0) {
    parts.push('## Rendered Page HTML (ground truth — derive selectors from this)');
    for (const page of pages) {
      parts.push('### ' + page.url + '\n```html\n' + page.html + '\n```\n');
    }
  }

  if (existingTests && existingTests.length > 0) {
    parts.push(
      '## Existing Tests\nDo not duplicate coverage; match these conventions:\n```\n' +
        existingTests.join('\n---\n') +
        '\n```\n',
    );
  }

  parts.push(`## Base URL: ${baseUrl}`);
  parts.push(
    '\nGenerate the foundational Playwright suite covering every journey above. One code block per file, each starting with `// filename: <name>.spec.ts`.',
  );

  return parts.join('\n');
}

export const SELF_HEALING_SYSTEM = `You are an expert at debugging and fixing Playwright end-to-end tests. When given a failing test and its error:

1. Analyze the error message and stack trace carefully
2. Identify the root cause and fix while maintaining original test intent
3. Follow Playwright best practices (accessible locators, auto-waiting, web-first assertions)

**Before fixing, classify the failure.** The FIRST line of your response — before any code block — must be a verdict:
VERDICT: {"classification":"test-issue","confidence":0.9,"reasoning":"<one sentence citing concrete evidence from the error output or diff>"}

- "test-issue" — the test itself is at fault: selector drift, strict-mode violation, timing/waiting problems, or assertions about content that never existed. Fix the test.
- "app-bug-suspected" — the application appears genuinely broken: server errors (5xx), uncaught exceptions from application code, blank/crashed pages, or the test correctly asserts behavior the code change appears to have broken unintentionally. Do NOT rewrite the test to pass around a real defect — return the ORIGINAL test code unchanged and put the evidence in reasoning.

A healed test that hides a real regression is worse than a failing test. When in doubt between the two, prefer "app-bug-suspected".

Return the verdict line, then the complete fixed test code in a single code block.`;

export function buildHealPrompt(testCode: string, error: string, attempt: number, context?: ChangeContext): string {
  const parts: string[] = [];
  parts.push('## Failing Test\n```typescript\n' + testCode + '\n```\n');
  parts.push('## Error\n```\n' + error + '\n```\n');
  parts.push(`## Attempt: ${attempt}\n`);

  if (context) {
    const diff = context.modifiedFiles
      .map((f) => f.patch || '')
      .filter(Boolean)
      .join('\n');
    if (diff) parts.push('## Current Code Context (Diff)\n```diff\n' + diff + '\n```\n');
  }

  if (attempt > 1) {
    parts.push('**Note:** Previous fix attempts failed. Try a fundamentally different approach.\n');
  }

  parts.push('Classify the failure, then fix this test. Return the verdict line and the complete corrected test code.');
  return parts.join('\n');
}

export const MIGRATION_SYSTEM = `You are an expert at migrating Cypress E2E tests to Playwright.
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

/** Parse `// filename: x.spec.ts`-annotated code blocks into GeneratedTest objects. */
export function parseTestsFromResponse(content: string): GeneratedTest[] {
  const tests: GeneratedTest[] = [];
  const codeBlockRegex = /```(?:typescript|ts)?\n(\/\/ filename: (.+?)\n)?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const filename = match[2]?.trim() || `test-${tests.length + 1}.spec.ts`;
    const code = (match[1] && !match[2] ? match[1] : '') + (match[3] || '');
    tests.push({
      filename,
      code: code.trim(),
      description: extractDescription(code),
      confidence: 0.8,
    });
  }

  if (tests.length === 0 && content.trim()) {
    tests.push({
      filename: 'generated.spec.ts',
      code: content.trim(),
      description: 'Generated test',
      confidence: 0.5,
    });
  }

  return tests;
}

function extractDescription(code: string): string {
  const describeMatch = code.match(/describe\(['"`](.+?)['"`]/);
  if (describeMatch) return describeMatch[1];
  const testMatch = code.match(/test\(['"`](.+?)['"`]/);
  if (testMatch) return testMatch[1];
  return 'Generated test';
}

/**
 * Parse the "VERDICT: {...}" line the self-healing prompt asks for.
 * Falls back to a low-confidence test-issue verdict when absent/malformed.
 */
export function parseHealVerdict(content: string): { verdict: HealVerdict; rest: string } {
  const match = content.match(/^\s*VERDICT:\s*(\{.*\})\s*$/m);
  const fallback: HealVerdict = {
    classification: 'test-issue',
    confidence: 0.5,
    reasoning: 'Model did not return a verdict',
  };
  if (!match) return { verdict: fallback, rest: content };

  const rest = content.replace(match[0], '').trim();
  try {
    const raw = JSON.parse(match[1]) as Partial<HealVerdict>;
    const classification = raw.classification === 'app-bug-suspected' ? 'app-bug-suspected' : 'test-issue';
    const confidence = typeof raw.confidence === 'number' ? Math.min(Math.max(raw.confidence, 0), 1) : 0.5;
    return { verdict: { classification, confidence, reasoning: String(raw.reasoning ?? '') }, rest };
  } catch {
    return { verdict: fallback, rest };
  }
}

/** Extract the first code block (or whole content) as a single test's code. */
export function extractCode(content: string): string {
  const codeMatch = content.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
  return codeMatch ? codeMatch[1].trim() : content.trim();
}
