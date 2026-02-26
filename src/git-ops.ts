import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import { PRContext } from './types';

export async function commitTests(
  token: string,
  prContext: PRContext,
  testFiles: string[],
  workDir: string
): Promise<string[]> {
  if (testFiles.length === 0) {
    core.info('No test files to commit');
    return [];
  }

  const octokit = github.getOctokit(token);
  const committedFiles: string[] = [];

  // Get the current commit tree
  const { data: ref } = await octokit.rest.git.getRef({
    owner: prContext.owner,
    repo: prContext.repo,
    ref: `heads/${prContext.branch}`,
  });

  const { data: commit } = await octokit.rest.git.getCommit({
    owner: prContext.owner,
    repo: prContext.repo,
    commit_sha: ref.object.sha,
  });

  // Create blobs for each test file
  const treeItems: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];

  for (const filePath of testFiles) {
    if (!fs.existsSync(filePath)) {
      core.warning(`Test file not found, skipping: ${filePath}`);
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(workDir, filePath);

    const { data: blob } = await octokit.rest.git.createBlob({
      owner: prContext.owner,
      repo: prContext.repo,
      content,
      encoding: 'utf-8',
    });

    treeItems.push({
      path: relativePath,
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    });

    committedFiles.push(relativePath);
  }

  if (treeItems.length === 0) return [];

  // Create tree
  const { data: tree } = await octokit.rest.git.createTree({
    owner: prContext.owner,
    repo: prContext.repo,
    base_tree: commit.tree.sha,
    tree: treeItems,
  });

  // Create commit
  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner: prContext.owner,
    repo: prContext.repo,
    message: '🤖 GreenCI: Add AI-generated E2E tests',
    tree: tree.sha,
    parents: [ref.object.sha],
  });

  // Update reference
  await octokit.rest.git.updateRef({
    owner: prContext.owner,
    repo: prContext.repo,
    ref: `heads/${prContext.branch}`,
    sha: newCommit.sha,
  });

  core.info(`Committed ${committedFiles.length} test file(s) to ${prContext.branch}`);
  return committedFiles;
}
