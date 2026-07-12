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

      - uses: samarrahTech/greenci-action@v1
        with:
          api-key: ${{ secrets.GREENCI_API_KEY }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `api-key` | GreenCI API key (required for the hosted `greenci` provider; optional for BYO-LLM) | ❌ | — |
| `llm-provider` | `greenci` (hosted), `anthropic` or `openai` (BYO-LLM — your key, your bill, code never touches the GreenCI API); `bedrock`, `azure-openai`, `ollama` are on the roadmap and fail fast | ❌ | `greenci` |
| `llm-model` | LLM model override (BYO defaults: `claude-opus-4-8` / `gpt-4o`) | ❌ | `''` |
| `aws-region` | AWS region for Bedrock (reserved for future BYO-LLM support) | ❌ | `us-east-1` |
| `test-dir` | Directory to save generated tests | ❌ | `e2e` |
| `base-url` | App base URL for E2E tests | ❌ | `http://localhost:3000` |
| `max-retries` | Max self-healing retries | ❌ | `2` |
| `auto-commit` | Auto-commit passing tests to PR | ❌ | `true` |
| `greenci-api-url` | GreenCI API endpoint | ❌ | `https://api.greenci.ai` |
| `mode` | Operation mode (`generate`, `bootstrap`, or `migrate`) | ❌ | `generate` |
| `journeys` | Bootstrap mode: critical user journeys in plain English, one per line (mention URL paths like `/login` to ground selectors in that page's real HTML) | ❌ | `''` |
| `project-id` | GreenCI project ID — enables trace uploads to the dashboard (copy it from your project page at app.greenci.ai) | ❌ | `''` |
| `github-token` | Token for PR comments and auto-commit | ❌ | `${{ github.token }}` |
| `cypress-dir` | Cypress tests directory (for migrate mode) | ❌ | `cypress/e2e` |

## Outputs

| Output | Description |
|--------|-------------|
| `tests-generated` | Number of tests generated |
| `tests-passed` | Number of tests passed |
| `tests-failed` | Number of tests failed |
| `report-url` | URL to the PR comment with full report |

## Examples

### Bootstrap: generate a foundational suite for an app with no tests

You don't need to wait for PRs — describe your critical journeys in plain English and run once (e.g. via `workflow_dispatch`). GreenCI captures the rendered HTML of your key pages for real selectors, generates a spec per journey, runs and heals the suite against your app, and **opens a PR** with the verified-passing tests. Journeys behind login get `storageState` scaffolding with TODOs.

```yaml
name: GreenCI Bootstrap
on: workflow_dispatch
permissions:
  contents: write
  pull-requests: write
jobs:
  bootstrap:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          npm ci
          npm run dev &
          npx wait-on http://localhost:3000
      - uses: samarrahTech/greenci-action@v1
        with:
          api-key: ${{ secrets.GREENCI_API_KEY }}
          mode: bootstrap
          base-url: http://localhost:3000
          journeys: |
            Sign in with email and password at /login
            Search for a job from the homepage and open a listing
            Post a new job at /jobs/new and reach the payment step
            Upload a resume from the profile page at /profile
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Mention URL paths in a journey (like `/login`) and GreenCI fetches that page's rendered HTML so selectors are grounded in your real DOM. After the bootstrap PR merges, the default `generate` mode keeps the suite growing with every PR.

### Bring Your Own LLM (Anthropic or OpenAI)

With a BYO-LLM provider, the action calls your LLM provider directly from the runner — your diff and tests are never sent to the GreenCI API. You pay your provider directly; no GreenCI API key or quota is needed.

```yaml
- uses: samarrahTech/greenci-action@v1
  with:
    llm-provider: anthropic          # or: openai
    # llm-model: claude-opus-4-8     # optional override (openai default: gpt-4o)
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}   # or OPENAI_API_KEY
```

### Custom Test Directory and Base URL

```yaml
- uses: samarrahTech/greenci-action@v1
  with:
    api-key: ${{ secrets.GREENCI_API_KEY }}
    test-dir: tests/e2e
    base-url: http://localhost:8080
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Without Auto-Commit

```yaml
- uses: samarrahTech/greenci-action@v1
  with:
    api-key: ${{ secrets.GREENCI_API_KEY }}
    auto-commit: 'false'
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Using Outputs

```yaml
- uses: samarrahTech/greenci-action@v1
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
- uses: samarrahTech/greenci-action@v1
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

## Data Sent to the GreenCI API

**BYO-LLM mode (`llm-provider: anthropic` or `openai`):** nothing is sent to the GreenCI API — the payloads below go directly from your runner to your chosen LLM provider under your own key. (Exception: if you set `project-id` with a GreenCI API key, traces are still uploaded to the GreenCI dashboard.)

**Hosted mode (`llm-provider: greenci`, the default):** to generate and heal tests, the action sends the following to the GreenCI API (`greenci-api-url`, default `https://api.greenci.ai`):

- The PR diff (patch hunks of changed files) and the list of changed file paths
- Detected routes, component names, and API endpoint signatures
- The contents of your existing E2E test files (so generated tests match your conventions)
- On self-heal: the failing test's code and its error output
- On migrate: your Cypress test source
- If `project-id` is set: Playwright trace archives for the dashboard

This data is processed transiently to generate tests and is not used to train models. If your repository cannot share code with an external API, do not use the hosted service.

## License

MIT
