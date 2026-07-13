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

/**
 * Bootstrap mode runs from workflow_dispatch with no PR context: commit the
 * generated suite to a new branch off the default branch and open a PR.
 * Returns the PR URL and the list of committed files.
 */
export async function createBootstrapPR(
  token: string,
  owner: string,
  repo: string,
  testFiles: string[],
  workDir: string,
  prBody: string,
): Promise<{ prUrl: string; committedFiles: string[] }> {
  const octokit = github.getOctokit(token);

  const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoInfo.default_branch;

  const { data: baseRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${defaultBranch}`,
  });
  const { data: baseCommit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: baseRef.object.sha,
  });

  const branchName = `greenci/bootstrap-${process.env.GITHUB_RUN_ID || Date.now()}`;
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseRef.object.sha,
  });

  const treeItems: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
  const committedFiles: string[] = [];

  for (const filePath of testFiles) {
    if (!fs.existsSync(filePath)) {
      core.warning(`Test file not found, skipping: ${filePath}`);
      continue;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(workDir, filePath);
    const { data: blob } = await octokit.rest.git.createBlob({ owner, repo, content, encoding: 'utf-8' });
    treeItems.push({ path: relativePath, mode: '100644', type: 'blob', sha: blob.sha });
    committedFiles.push(relativePath);
  }

  if (treeItems.length === 0) {
    throw new Error('Bootstrap produced no committable test files');
  }

  const { data: tree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: treeItems,
  });
  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: '🤖 GreenCI: Bootstrap foundational E2E test suite',
    tree: tree.sha,
    parents: [baseRef.object.sha],
  });
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: newCommit.sha,
  });

  let pr;
  try {
    const res = await octokit.rest.pulls.create({
      owner,
      repo,
      title: '🌱 GreenCI: Foundational E2E test suite',
      head: branchName,
      base: defaultBranch,
      body: prBody,
    });
    pr = res.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not permitted to create')) {
      throw new Error(
        `Your test suite was committed to branch '${branchName}', but GitHub blocked the PR creation. ` +
          `Enable it under Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests", ` +
          `then re-run — or open a PR from that branch manually. Nothing was lost.`,
      );
    }
    throw err;
  }

  core.info(`Opened bootstrap PR #${pr.number}: ${pr.html_url}`);
  return { prUrl: pr.html_url, committedFiles };
}
