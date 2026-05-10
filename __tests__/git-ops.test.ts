import * as github from '@actions/github';
import { commitTests } from '../src/git-ops';
import { PRContext } from '../src/types';

jest.mock('@actions/core');
jest.mock('@actions/github');

// Mock only specific fs functions, not the whole module
const mockExistsSync = jest.fn().mockReturnValue(true);
const mockReadFileSync = jest.fn().mockReturnValue('test content');
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  };
});

const mockOctokit = {
  rest: {
    git: {
      getRef: jest.fn(),
      getCommit: jest.fn(),
      createBlob: jest.fn(),
      createTree: jest.fn(),
      createCommit: jest.fn(),
      updateRef: jest.fn(),
    },
  },
};

const prContext: PRContext = {
  owner: 'test-owner',
  repo: 'test-repo',
  prNumber: 1,
  baseSha: 'base-sha',
  headSha: 'head-sha',
  branch: 'feature-branch',
};

describe('commitTests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (github.getOctokit as jest.Mock).mockReturnValue(mockOctokit);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('test content');

    mockOctokit.rest.git.getRef.mockResolvedValue({ data: { object: { sha: 'ref-sha' } } });
    mockOctokit.rest.git.getCommit.mockResolvedValue({ data: { tree: { sha: 'tree-sha' } } });
    mockOctokit.rest.git.createBlob.mockResolvedValue({ data: { sha: 'blob-sha' } });
    mockOctokit.rest.git.createTree.mockResolvedValue({ data: { sha: 'new-tree-sha' } });
    mockOctokit.rest.git.createCommit.mockResolvedValue({ data: { sha: 'new-commit-sha' } });
    mockOctokit.rest.git.updateRef.mockResolvedValue({});
  });

  it('should return empty array when no files provided', async () => {
    const result = await commitTests('mock-token', prContext, [], '/work');
    expect(result).toEqual([]);
  });

  it('should commit test files and return relative paths', async () => {
    const result = await commitTests('mock-token', prContext, ['/work/e2e/test.spec.ts'], '/work');
    expect(result).toEqual(['e2e/test.spec.ts']);
    expect(mockOctokit.rest.git.createBlob).toHaveBeenCalledTimes(1);
    expect(mockOctokit.rest.git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ message: '🤖 GreenCI: Add AI-generated E2E tests' })
    );
    expect(mockOctokit.rest.git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/feature-branch', sha: 'new-commit-sha' })
    );
  });

  it('should skip files that do not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await commitTests('mock-token', prContext, ['/work/missing.ts'], '/work');
    expect(result).toEqual([]);
  });

  it('should handle multiple files', async () => {
    const result = await commitTests('mock-token', prContext, ['/work/e2e/a.spec.ts', '/work/e2e/b.spec.ts'], '/work');
    expect(result).toHaveLength(2);
    expect(mockOctokit.rest.git.createBlob).toHaveBeenCalledTimes(2);
  });
});
