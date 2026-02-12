# 🌱 GreenCI — AI-Powered E2E Test Agent

GreenCI automatically generates, runs, and self-heals E2E tests for your pull requests using AI.

## How it Works

1. **Analyzes your PR** — Parses the diff to understand what changed (routes, components, APIs)
2. **Generates tests** — Sends context to an LLM to generate Playwright E2E tests
3. **Runs tests** — Executes the generated tests against your app
4. **Self-heals** — If tests fail, sends error context back to the LLM and retries
5. **Commits & reports** — Commits passing tests to your PR branch and posts a summary comment

## Quick Start

```yaml
# .github/workflows/greenci.yml
name: GreenCI E2E Tests

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm ci

      - name: Start app
        run: npm run dev &
        env:
          PORT: 3000

      - name: Wait for app
        run: npx wait-on http://localhost:3000

      - uses: greenci/greenci-action@v1
        with:
          api-key: ${{ secrets.GREENCI_API_KEY }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `api-key` | GreenCI API key | ✅ | — |
| `llm-provider` | LLM provider (`greenci`, `bedrock`, `azure-openai`, `openai`, `ollama`) | ❌ | `greenci` |
| `llm-model` | LLM model name | ❌ | `''` |
| `aws-region` | AWS region for Bedrock | ❌ | `us-east-1` |
| `test-dir` | Directory to save generated tests | ❌ | `e2e` |
| `base-url` | App base URL for E2E tests | ❌ | `http://localhost:3000` |
| `max-retries` | Max self-healing retries | ❌ | `2` |
| `auto-commit` | Auto-commit passing tests to PR | ❌ | `true` |
| `greenci-api-url` | GreenCI API endpoint | ❌ | `https://api.greenci.ai` |
| `mode` | Operation mode (`generate` or `migrate`) | ❌ | `generate` |
| `cypress-dir` | Cypress tests directory (for migrate mode) | ❌ | `cypress/e2e` |

## Outputs

| Output | Description |
|--------|-------------|
| `tests-generated` | Number of tests generated |
| `tests-passed` | Number of tests passed |
| `tests-failed` | Number of tests failed |
| `report-url` | URL to the PR comment with full report |

## Examples

### With AWS Bedrock

```yaml
- uses: greenci/greenci-action@v1
  with:
    api-key: ${{ secrets.GREENCI_API_KEY }}
    llm-provider: bedrock
    llm-model: anthropic.claude-3-sonnet-20240229-v1:0
    aws-region: us-west-2
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

### Custom Test Directory and Base URL

```yaml
- uses: greenci/greenci-action@v1
  with:
    api-key: ${{ secrets.GREENCI_API_KEY }}
    test-dir: tests/e2e
    base-url: http://localhost:8080
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Without Auto-Commit

```yaml
- uses: greenci/greenci-action@v1
  with:
    api-key: ${{ secrets.GREENCI_API_KEY }}
    auto-commit: 'false'
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Using Outputs

```yaml
- uses: greenci/greenci-action@v1
  id: greenci
  with:
    api-key: ${{ secrets.GREENCI_API_KEY }}
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

- name: Check results
  if: steps.greenci.outputs.tests-failed != '0'
  run: echo "Some tests failed!"
```

## Cypress → Playwright Migration

GreenCI can automatically migrate your Cypress E2E tests to Playwright:

```yaml
- uses: greenci/greenci-action@v1
  with:
    api-key: ${{ secrets.GREENCI_API_KEY }}
    mode: migrate
    cypress-dir: cypress/e2e
    test-dir: e2e
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### How Migration Works

1. **Scans** your Cypress test directory for `.cy.ts`, `.cy.js`, `.spec.ts`, `.spec.js` files
2. **Parses** each file to understand Cypress commands, test structure, fixtures, and custom commands
3. **Converts** using static rules for common patterns (`cy.get` → `page.locator`, `cy.visit` → `page.goto`, etc.)
4. **Refines** with LLM to handle complex patterns, improve selectors, and ensure proper async/await
5. **Writes** converted Playwright tests to your target directory
6. **Reports** a detailed migration summary as a PR comment

### Migration Report

The PR comment includes:
- ✅ Successfully converted files
- ⚠️ Files needing manual review (with specific notes)
- ❌ Failed conversions
- 📋 Next steps for completing the migration

### Supported Conversions

| Cypress | Playwright |
|---------|-----------|
| `cy.visit(url)` | `await page.goto(url)` |
| `cy.get(sel).click()` | `await page.locator(sel).click()` |
| `cy.get(sel).type(text)` | `await page.locator(sel).fill(text)` |
| `cy.contains(text)` | `page.getByText(text)` |
| `cy.get(sel).should('be.visible')` | `await expect(page.locator(sel)).toBeVisible()` |
| `cy.intercept(...)` | `await page.route(...)` |
| `cy.url().should('include', path)` | `await expect(page).toHaveURL(...)` |
| `describe/it` | `test.describe/test` |
| `before/beforeEach` | `test.beforeAll/test.beforeEach` |
| `Cypress.env('KEY')` | `process.env['KEY']` |

## Self-Healing

When a generated test fails, GreenCI sends the error context back to the LLM for correction:

1. First run fails → sends error message + test code + app context
2. LLM generates a corrected test
3. Corrected test runs again
4. Repeats up to `max-retries` times (default: 2)

## PR Comment

GreenCI posts a detailed summary comment on your PR:

- ✅/❌ Test results with pass/fail counts
- 🔧 Self-healed test count
- 📝 List of committed test files
- 📂 Files analyzed
- ⏱️ Total duration

## License

MIT
