import * as github from '@actions/github';
import { ChangedFile, FileStatus, PRContext } from './types';

const STATUS_MAP: Record<string, FileStatus> = {
  added: 'added',
  modified: 'modified',
  removed: 'removed',
  renamed: 'renamed',
  copied: 'copied',
};

export function getPRContext(): PRContext {
  const context = github.context;

  if (!context.payload.pull_request) {
    throw new Error('This action can only run on pull_request events');
  }

  const pr = context.payload.pull_request;

  return {
    owner: context.repo.owner,
    repo: context.repo.repo,
    prNumber: pr.number,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    branch: pr.head.ref,
  };
}

export async function getChangedFiles(
  token: string,
  prContext: PRContext
): Promise<ChangedFile[]> {
  const octokit = github.getOctokit(token);

  const files: ChangedFile[] = [];
  let page = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await octokit.rest.pulls.listFiles({
      owner: prContext.owner,
      repo: prContext.repo,
      pull_number: prContext.prNumber,
      per_page: 100,
      page,
    });

    if (response.data.length === 0) break;

    for (const file of response.data) {
      files.push({
        filename: file.filename,
        status: STATUS_MAP[file.status] || 'modified',
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
        previousFilename: file.previous_filename,
      });
    }

    if (response.data.length < 100) break;
    page++;
  }

  return files;
}

export function filterTestableFiles(files: ChangedFile[]): ChangedFile[] {
  const testableExtensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.html', '.htm'];
  const ignorePaths = [
    'node_modules/',
    'dist/',
    'build/',
    '.github/',
    '__tests__/',
    '*.test.',
    '*.spec.',
    '.eslint',
    '.prettier',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
  ];

  return files.filter((file) => {
    if (file.status === 'removed') return false;

    const hasTestableExt = testableExtensions.some((ext) => file.filename.endsWith(ext));
    if (!hasTestableExt) return false;

    const isIgnored = ignorePaths.some((pattern) => {
      if (pattern.startsWith('*')) {
        return file.filename.includes(pattern.slice(1));
      }
      return file.filename.includes(pattern);
    });

    return !isIgnored;
  });
}

export function parseFileDiff(patch: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];

  if (!patch) return { added, removed };

  const lines = patch.split('\n');
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push(line.slice(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed.push(line.slice(1));
    }
  }

  return { added, removed };
}
