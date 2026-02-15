# GreenCI for Azure DevOps

AI-powered E2E test generation and self-healing for Azure DevOps pipelines.

## Quick Start

### 1. Set up your API key

Add `GREENCI_API_KEY` as a pipeline variable (mark as secret):

**Pipeline Settings → Variables → New Variable**
- Name: `GREENCI_API_KEY`
- Value: `gci_your_key_here`
- Keep this value secret: ✅

### 2. Grant permissions

The pipeline needs `System.AccessToken` to post PR comments and fetch PR diffs. In your pipeline YAML, pass it as an environment variable:

```yaml
env:
  SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

Also ensure the **Build Service** account has:
- **Contribute to pull requests** permission on your repository
- **Read** access to the repository

### 3. Add to your pipeline

```yaml
trigger:
  branches:
    include: [main]

pr:
  branches:
    include: [main]

pool:
  vmImage: 'ubuntu-latest'

steps:
  - checkout: self
    persistCredentials: true
    fetchDepth: 0

  - task: NodeTool@0
    inputs:
      versionSpec: '20'

  - script: npm ci
    displayName: 'Install dependencies'

  - script: npm run build && npm start &
    displayName: 'Build & start app'

  - script: npx playwright install --with-deps chromium
    displayName: 'Install Playwright'

  - task: GreenCI@0
    displayName: 'Run GreenCI'
    inputs:
      apiKey: '$(GREENCI_API_KEY)'
      baseUrl: 'http://localhost:3000'
      testDir: 'e2e'
      mode: 'generate'
      maxRetries: '2'
      autoCommit: true
    env:
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

## Configuration

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `apiKey` | ✅ | — | GreenCI API key (starts with `gci_`) |
| `baseUrl` | | `http://localhost:3000` | App base URL for E2E tests |
| `testDir` | | `e2e` | Directory to save generated tests |
| `mode` | | `generate` | `generate` or `migrate` (Cypress → Playwright) |
| `provider` | | `greenci` | LLM provider (`greenci`, `openai`, `azure-openai`, `bedrock`, `ollama`) |
| `model` | | — | Specific LLM model name |
| `maxRetries` | | `2` | Max self-healing retries for failed tests |
| `autoCommit` | | `true` | Auto-commit passing tests to the PR branch |
| `greenCIApiUrl` | | `https://api.greenci.ai` | GreenCI API endpoint |
| `cypressDir` | | `cypress/e2e` | Cypress directory (for `migrate` mode) |

## Output Variables

After the task runs, these pipeline variables are set:

| Variable | Description |
|----------|-------------|
| `testsGenerated` | Number of tests generated |
| `testsPassed` | Number of tests that passed |
| `testsFailed` | Number of tests that failed |

Use them in subsequent steps:

```yaml
- script: echo "$(testsGenerated) tests generated, $(testsPassed) passed"
  displayName: 'Show results'
```

## PR Comments

When running on a PR build, GreenCI automatically posts a comment with:
- Test results summary (generated / passed / failed / self-healed)
- Per-test pass/fail status with error details
- List of committed test files

**Requirements:**
- `SYSTEM_ACCESSTOKEN` must be passed as an env variable
- Build Service needs "Contribute to pull requests" permission

## How It Works

1. **Detects changes** — Fetches PR diff via Azure DevOps REST API (or `git diff` fallback)
2. **Analyzes code** — Identifies routes, components, and API endpoints from changed files
3. **Generates tests** — Calls the GreenCI API to generate Playwright E2E tests
4. **Runs tests** — Executes generated tests with Playwright
5. **Self-heals** — If tests fail, sends errors back to the API for automatic fixes
6. **Reports results** — Posts a PR comment and sets pipeline variables
7. **Auto-commits** — Optionally commits passing tests to the PR branch

## Troubleshooting

### "Not a PR build — no changed files from PR"

GreenCI uses the Azure DevOps API to fetch PR file changes. If the build isn't triggered by a PR, it falls back to `git diff`. Ensure:
- Your pipeline has a `pr:` trigger
- `fetchDepth: 0` is set on checkout (for full git history)

### PR comments not appearing

1. Check that `SYSTEM_ACCESSTOKEN` is passed as an env variable
2. Verify the Build Service account has "Contribute to pull requests" permission:
   - **Project Settings → Repositories → [your repo] → Security**
   - Find your build service account and grant the permission

### Tests failing to run

- Ensure Playwright is installed: `npx playwright install --with-deps chromium`
- Verify your app is running and accessible at the configured `baseUrl`
- Check that `npx playwright test` works manually

### Auto-commit not working

- `persistCredentials: true` must be set on the checkout step
- The Build Service account needs write access to the repository

## Full Example

See [`example-pipeline.yml`](./example-pipeline.yml) for a complete pipeline configuration.
