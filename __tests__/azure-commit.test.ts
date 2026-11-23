import { COMMIT_MARKER, commitDestination, pushFilesViaApi } from '../src/azure-commit';

const SHA = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);

describe('commitDestination', () => {
  it('uses the pull request source branch and source commit, not the merge being built', () => {
    expect(
      commitDestination({
        BUILD_REPOSITORY_PROVIDER: 'TfsGit',
        SYSTEM_PULLREQUEST_SOURCEBRANCH: 'refs/heads/feature/x',
        SYSTEM_PULLREQUEST_SOURCECOMMITID: SHA,
        BUILD_SOURCEBRANCH: 'refs/pull/12/merge',
        BUILD_SOURCEVERSION: MERGE,
      })
    ).toEqual({ branchRef: 'refs/heads/feature/x', expectedTip: SHA });
  });

  it('uses the built branch and commit for a branch build', () => {
    expect(
      commitDestination({ BUILD_SOURCEBRANCH: 'refs/heads/main', BUILD_SOURCEVERSION: SHA })
    ).toEqual({
      branchRef: 'refs/heads/main',
      expectedTip: SHA,
    });
  });

  it.each([
    [
      'a fork',
      {
        SYSTEM_PULLREQUEST_ISFORK: 'True',
        SYSTEM_PULLREQUEST_SOURCEBRANCH: 'refs/heads/x',
        SYSTEM_PULLREQUEST_SOURCECOMMITID: SHA,
      },
      'fork',
    ],
    [
      'a GitHub-hosted repository',
      {
        BUILD_REPOSITORY_PROVIDER: 'GitHub',
        BUILD_SOURCEBRANCH: 'refs/heads/main',
        BUILD_SOURCEVERSION: SHA,
      },
      'GitHub',
    ],
    [
      'a tag build',
      { BUILD_SOURCEBRANCH: 'refs/tags/v1', BUILD_SOURCEVERSION: SHA },
      'not for a branch',
    ],
    [
      'a merge ref alone',
      { BUILD_SOURCEBRANCH: 'refs/pull/12/merge', BUILD_SOURCEVERSION: SHA },
      'not for a branch',
    ],
    [
      'an empty branch name',
      { BUILD_SOURCEBRANCH: 'refs/heads/', BUILD_SOURCEVERSION: SHA },
      'not for a branch',
    ],
    [
      'a pull request without its source commit',
      { SYSTEM_PULLREQUEST_SOURCEBRANCH: 'refs/heads/x', BUILD_SOURCEVERSION: MERGE },
      'which commit',
    ],
    ['no commit id', { BUILD_SOURCEBRANCH: 'refs/heads/main' }, 'which commit'],
    ['nothing at all', {}, 'not for a branch'],
  ])('has nowhere to commit for %s', (_name, env, reason) => {
    const out = commitDestination(env);
    expect('skip' in out && out.skip).toContain(reason);
  });
});

describe('pushFilesViaApi', () => {
  const target = {
    collectionUri: 'https://dev.azure.com/org/',
    project: 'My Project',
    repoId: 'repo-id',
    branchRef: 'refs/heads/feature/x',
    expectedTip: SHA,
  };
  const BASE = 'https://dev.azure.com/org/My%20Project/_apis/git/repositories/repo-id';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  /** `onBranch`: path -> content already on the branch (or a status to fail with). */
  function fetcher(
    answers: { tip?: Response; onBranch?: Record<string, string | number>; push?: Response } = {}
  ) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fn = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith(`${BASE}/commits/`))
        return answers.tip ?? json({ comment: 'feat: something' });
      if (url.startsWith(`${BASE}/items?`)) {
        const p = decodeURIComponent(/path=([^&]+)/.exec(url)![1]);
        const known = answers.onBranch?.[p];
        if (known === undefined) return json({}, 404);
        return typeof known === 'number' ? json({}, known) : json({ path: p, content: known });
      }
      if (url.startsWith(`${BASE}/pushes?`)) return answers.push ?? json({ pushId: 1 }, 201);
      throw new Error(`unexpected ${url}`);
    });
    const pushBody = () => {
      const push = calls.find((c) => c.url.startsWith(`${BASE}/pushes?`));
      return push ? JSON.parse(String(push.init?.body)) : null;
    };
    return { fn, calls, pushBody };
  }

  it('creates one commit with exactly the given files, on the branch, at the commit that was built', async () => {
    const { fn, calls, pushBody } = fetcher({ onBranch: { '/e2e/old.spec.ts': 'previous' } });

    const out = await pushFilesViaApi(
      target,
      [
        { path: 'e2e/new.spec.ts', content: 'new' },
        { path: 'e2e/old.spec.ts', content: 'old' },
      ],
      fn
    );

    expect(out).toEqual({ committed: ['e2e/new.spec.ts', 'e2e/old.spec.ts'] });
    expect(pushBody()).toEqual({
      // The commit the build ran on: if the branch moved, the API refuses.
      refUpdates: [{ name: 'refs/heads/feature/x', oldObjectId: SHA }],
      commits: [
        {
          comment: `${COMMIT_MARKER} [skip ci]`,
          changes: [
            {
              changeType: 'add',
              item: { path: '/e2e/new.spec.ts' },
              newContent: { content: 'new', contentType: 'rawtext' },
            },
            {
              changeType: 'edit',
              item: { path: '/e2e/old.spec.ts' },
              newContent: { content: 'old', contentType: 'rawtext' },
            },
          ],
        },
      ],
    });
    expect(calls[0].url).toBe(`${BASE}/commits/${SHA}?api-version=7.1`);
    expect(calls[1].url).toContain(
      `versionDescriptor.version=${SHA}&versionDescriptor.versionType=commit`
    );
    expect(calls[1].url).toContain('includeContent=true');
  });

  // The push triggers a new build of the branch. Committing again from that
  // build would loop.
  it('makes no commit when the commit that was built is an auto-commit', async () => {
    const { fn, pushBody } = fetcher({ tip: json({ comment: `${COMMIT_MARKER} [skip ci]` }) });
    const out = await pushFilesViaApi(target, [{ path: 'a.spec.ts', content: 'a' }], fn);
    expect(out.committed).toEqual([]);
    expect(out.skipped).toContain('auto-commit');
    expect(pushBody()).toBeNull();
  });

  it('leaves out files the branch already has with the same content', async () => {
    const { fn, pushBody } = fetcher({
      onBranch: { '/same.spec.ts': 'same', '/diff.spec.ts': 'before' },
    });
    const out = await pushFilesViaApi(
      target,
      [
        { path: 'same.spec.ts', content: 'same' },
        { path: 'diff.spec.ts', content: 'after' },
      ],
      fn
    );
    expect(out.committed).toEqual(['diff.spec.ts']);
    expect(pushBody().commits[0].changes).toHaveLength(1);
  });

  it('makes no commit when nothing differs', async () => {
    const { fn, pushBody } = fetcher({ onBranch: { '/same.spec.ts': 'same' } });
    const out = await pushFilesViaApi(target, [{ path: 'same.spec.ts', content: 'same' }], fn);
    expect(out).toEqual({
      committed: [],
      skipped: 'the branch already has these tests with the same content',
    });
    expect(pushBody()).toBeNull();
  });

  // Two changes for one item make the API refuse the whole push.
  it('sends a path once, with the last content given', async () => {
    const { fn, pushBody } = fetcher();
    await pushFilesViaApi(
      target,
      [
        { path: 'a.spec.ts', content: 'first' },
        { path: 'a.spec.ts', content: 'second' },
      ],
      fn
    );
    expect(pushBody().commits[0].changes).toEqual([
      {
        changeType: 'add',
        item: { path: '/a.spec.ts' },
        newContent: { content: 'second', contentType: 'rawtext' },
      },
    ]);
  });

  it('makes no call for an empty list', async () => {
    const { fn } = fetcher();
    expect(await pushFilesViaApi(target, [], fn)).toEqual({ committed: [] });
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports the API answer when the push is refused', async () => {
    const { fn } = fetcher({
      push: json({ message: 'TF401027: You need the Git GenericContribute permission' }, 403),
    });
    await expect(
      pushFilesViaApi(target, [{ path: 'a.spec.ts', content: 'a' }], fn)
    ).rejects.toThrow('The push was refused: HTTP 403 TF401027');
  });

  it('fails without pushing when the built commit cannot be read', async () => {
    const { fn, pushBody } = fetcher({ tip: json({ message: 'not found' }, 404) });
    await expect(
      pushFilesViaApi(target, [{ path: 'a.spec.ts', content: 'a' }], fn)
    ).rejects.toThrow('Could not read the commit this build ran on: HTTP 404');
    expect(pushBody()).toBeNull();
  });

  it('fails without pushing when a file check errors with something other than 404', async () => {
    const { fn, pushBody } = fetcher({ onBranch: { '/a.spec.ts': 500 } });
    await expect(
      pushFilesViaApi(target, [{ path: 'a.spec.ts', content: 'a' }], fn)
    ).rejects.toThrow('Could not check a.spec.ts');
    expect(pushBody()).toBeNull();
  });
});
