import * as core from '@actions/core';
import * as github from '@actions/github';

jest.mock('@actions/core');
jest.mock('@actions/github');
jest.mock('../src/config');
jest.mock('../src/diff-parser');
jest.mock('../src/context-builder');
jest.mock('../src/llm-client');
jest.mock('../src/test-generator');
jest.mock('../src/git-ops');
jest.mock('../src/pr-reporter');
jest.mock('../src/migrator');
jest.mock('../src/trace-uploader');

import { getConfig } from '../src/config';
import { getPRContext, getChangedFiles, filterTestableFiles } from '../src/diff-parser';
import { buildChangeContext } from '../src/context-builder';
import { createLLMClient } from '../src/llm-client';
import { generateAndRunTests } from '../src/test-generator';
import { commitTests } from '../src/git-ops';
import { postReport } from '../src/pr-reporter';
import { runMigration, buildMigrationReportBody } from '../src/migrator';
import { uploadTraces } from '../src/trace-uploader';

const mockConfig = {
  apiKey: 'mock-key',
  llmProvider: 'greenci' as const,
  llmModel: '',
  awsRegion: 'us-east-1',
  testDir: 'e2e',
  baseUrl: 'http://localhost:3000',
  maxRetries: 2,
  autoCommit: true,
  greenCIApiUrl: 'https://api.greenci.ai',
  mode: 'generate' as const,
  cypressDir: 'cypress/e2e',
};

const mockPRContext = {
  owner: 'owner',
  repo: 'repo',
  prNumber: 1,
  baseSha: 'base',
  headSha: 'head',
  branch: 'feature',
};

describe('index (run)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (core.getInput as jest.Mock).mockImplementation((name: string) => {
      if (name === 'github-token') return 'mock-token';
      if (name === 'project-id') return '';
      return '';
    });
    (getConfig as jest.Mock).mockReturnValue(mockConfig);
    (getPRContext as jest.Mock).mockReturnValue(mockPRContext);
    (getChangedFiles as jest.Mock).mockResolvedValue([
      { filename: 'src/app.ts', status: 'modified', additions: 5, deletions: 2 },
    ]);
    (filterTestableFiles as jest.Mock).mockReturnValue([
      { filename: 'src/app.ts', status: 'modified', additions: 5, deletions: 2 },
    ]);
    (buildChangeContext as jest.Mock).mockReturnValue({
      routes: [],
      components: [],
      apiEndpoints: [],
      modifiedFiles: [],
      summary: 'summary',
    });
    (createLLMClient as jest.Mock).mockReturnValue({});
    (generateAndRunTests as jest.Mock).mockResolvedValue({
      testsGenerated: 1,
      testsPassed: 1,
      testsFailed: 0,
      testsHealed: 0,
      filesChanged: ['src/app.ts'],
      duration: 5000,
      tests: [{ filename: 'e2e/app.spec.ts', passed: true, duration: 2000 }],
      committedFiles: [],
    });
    (commitTests as jest.Mock).mockResolvedValue(['e2e/app.spec.ts']);
    (postReport as jest.Mock).mockResolvedValue('https://github.com/comment/1');
    (uploadTraces as jest.Mock).mockResolvedValue(undefined);
  });

  // We need to dynamically import to trigger run()
  async function executeRun() {
    // Clear module cache to re-run
    jest.isolateModules(() => {
      require('../src/index');
    });
    // Wait for async run() to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  it('should execute the generate flow', async () => {
    await executeRun();
    expect(getConfig).toHaveBeenCalled();
    expect(getPRContext).toHaveBeenCalled();
    expect(getChangedFiles).toHaveBeenCalled();
    expect(generateAndRunTests).toHaveBeenCalled();
  });

  it('should skip when no testable files', async () => {
    (filterTestableFiles as jest.Mock).mockReturnValue([]);
    await executeRun();
    expect(generateAndRunTests).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('tests-generated', '0');
  });

  it('should run migration mode', async () => {
    (getConfig as jest.Mock).mockReturnValue({ ...mockConfig, mode: 'migrate' });
    (runMigration as jest.Mock).mockResolvedValue({
      totalFiles: 2,
      converted: 2,
      needsReview: 0,
      failed: 0,
      files: [{ status: 'converted', target: 'e2e/test.spec.ts' }],
      duration: 3000,
    });
    (buildMigrationReportBody as jest.Mock).mockReturnValue('report body');

    // Mock @actions/github.getOctokit for migration mode
    (github.getOctokit as jest.Mock) = jest.fn().mockReturnValue({
      rest: { issues: { createComment: jest.fn().mockResolvedValue({}) } },
    });

    await executeRun();
    expect(runMigration).toHaveBeenCalled();
  });

  it('should handle errors gracefully', async () => {
    (getConfig as jest.Mock).mockImplementation(() => {
      throw new Error('Bad config');
    });
    await executeRun();
    expect(core.setFailed).toHaveBeenCalledWith('Bad config');
  });
});
