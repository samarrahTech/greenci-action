import * as github from '@actions/github';
import { unchangedOnDefaultBranch } from '../src/git-ops';
import { gitBlobSha } from '../src/dev-dependency';

jest.mock('@actions/core');
jest.mock('@actions/github');

// GC-150: the bootstrap PR is built on the default branch and uploads whole
// files. A package.json that is not what the default branch holds would bring
// its other differences into the PR.
describe('unchangedOnDefaultBranch', () => {
  const before = Buffer.from('{ "name": "app" }\n');
  const getContent = jest.fn();
  const files = [{ path: '/work/sub/package.json', before }];

  beforeEach(() => {
    jest.clearAllMocks();
    (github.getOctokit as jest.Mock).mockReturnValue({
      rest: { repos: { get: jest.fn().mockResolvedValue({ data: { default_branch: 'trunk' } }), getContent } },
    });
  });

  it('is true when the default branch holds exactly what the checkout had', async () => {
    getContent.mockResolvedValue({ data: { type: 'file', sha: gitBlobSha(before) } });
    expect(await unchangedOnDefaultBranch('t', 'o', 'r', '/work', files)).toBe(true);
    expect(getContent).toHaveBeenCalledWith({ owner: 'o', repo: 'r', path: 'sub/package.json', ref: 'trunk' });
  });

  it('is false when the default branch has other content (another branch, a merge during the run, CRLF)', async () => {
    getContent.mockResolvedValue({ data: { type: 'file', sha: gitBlobSha(Buffer.from('{ "name": "app", "x": 1 }\n')) } });
    expect(await unchangedOnDefaultBranch('t', 'o', 'r', '/work', files)).toBe(false);
  });

  it('is false when the file is not on the default branch (untracked or ignored lockfile)', async () => {
    getContent.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(await unchangedOnDefaultBranch('t', 'o', 'r', '/work', files)).toBe(false);
  });

  it('is false when the path is not a plain file there', async () => {
    getContent.mockResolvedValue({ data: [{ type: 'file' }] });
    expect(await unchangedOnDefaultBranch('t', 'o', 'r', '/work', files)).toBe(false);
  });
});
