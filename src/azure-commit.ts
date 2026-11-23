/**
 * Auto-commit for the Azure DevOps task, through the REST API.
 *
 * The task used to run `git add`, `git commit` and `git push` in the
 * workspace. By then model-written tests have run there, and a git command
 * takes its orders from repository state those tests can write: hooks,
 * `remote.origin.pushurl` and `receivepack`, push refspecs, proxies, the
 * index. A push that carries the job token cannot be made safe against all of
 * that by overriding settings one at a time.
 *
 * So no git process handles the token at all, and nothing is read back from
 * the workspace either: a passing test could have rewritten its own file. The
 * task sends the code it wrote and validated, from memory, to the Pushes API,
 * for the branch and commit named by the pipeline's own environment. It also
 * works on a pull request build, where the checkout is a detached merge
 * commit that `git push` could not push anywhere.
 *
 * No dependency on the Azure task library, and the HTTP call is injected, so
 * this is unit-tested without a network.
 */

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface PushTarget {
  /** SYSTEM_TEAMFOUNDATIONCOLLECTIONURI, e.g. https://dev.azure.com/org/ */
  collectionUri: string;
  project: string;
  repoId: string;
  /** Full ref, e.g. refs/heads/feature/x */
  branchRef: string;
  /**
   * The commit of that branch this build ran on. The push names it as the
   * tip it expects, so a branch that moved while the tests ran is left alone.
   */
  expectedTip: string;
}

export interface CommitFile {
  /** Path from the repository root, forward slashes, no leading slash. */
  path: string;
  content: string;
}

/** First line of every auto-commit; also how a later build recognises one. */
export const COMMIT_MARKER = '🤖 GreenCI: Add AI-generated E2E tests';

/**
 * Where an auto-commit belongs: the pull request's source branch at its
 * source commit, or the built branch at the built commit. Null when there is
 * nowhere to write: a tag build, a pull request from a fork (its branch lives
 * in a repository the job token cannot write), or a repository that is not
 * hosted in Azure Repos.
 */
export function commitDestination(
  env: Record<string, string | undefined>
): { branchRef: string; expectedTip: string } | { skip: string } {
  const provider = env.BUILD_REPOSITORY_PROVIDER || '';
  if (provider && provider !== 'TfsGit') {
    return {
      skip: `the repository is hosted on ${provider}, and auto-commit supports Azure Repos only`,
    };
  }
  if ((env.SYSTEM_PULLREQUEST_ISFORK || '').toLowerCase() === 'true') {
    return { skip: 'the pull request comes from a fork, which the job token cannot write to' };
  }
  const isPr = !!env.SYSTEM_PULLREQUEST_SOURCEBRANCH;
  const branchRef = (isPr ? env.SYSTEM_PULLREQUEST_SOURCEBRANCH : env.BUILD_SOURCEBRANCH) || '';
  // On a pull request build BUILD_SOURCEVERSION is the merge commit, which is
  // on no branch.
  const expectedTip =
    (isPr ? env.SYSTEM_PULLREQUEST_SOURCECOMMITID : env.BUILD_SOURCEVERSION) || '';
  if (!branchRef.startsWith('refs/heads/') || branchRef.length <= 'refs/heads/'.length) {
    return { skip: 'this build is not for a branch' };
  }
  if (!/^[0-9a-f]{40}$/i.test(expectedTip)) {
    return { skip: 'the pipeline did not say which commit of the branch was built' };
  }
  return { branchRef, expectedTip };
}

async function failure(what: string, res: Response): Promise<Error> {
  let detail = '';
  try {
    detail = ((await res.json()) as { message?: string }).message || '';
  } catch {
    // No JSON body.
  }
  return new Error(`${what}: HTTP ${res.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
}

export interface PushOutcome {
  /** Paths in the new commit. Empty when no commit was made. */
  committed: string[];
  /** Why no commit was made, when that was a decision and not an error. */
  skipped?: string;
}

/**
 * Create one commit on `target.branchRef` holding exactly `files`.
 *
 * No commit is made, and `skipped` says why, when:
 *  - the commit the build ran on is itself an auto-commit: the push triggers
 *    a new build, and committing again from that build would loop;
 *  - every file already has this content on the branch.
 *
 * Throws with the API's answer when it refuses, for example when the branch
 * moved since the build started or the Build Service lacks Contribute.
 */
export async function pushFilesViaApi(
  target: PushTarget,
  files: CommitFile[],
  fetcher: Fetcher
): Promise<PushOutcome> {
  // One entry per path, the last one given: two changes for one item make the
  // API refuse the whole push.
  const unique = [...new Map(files.map((f) => [f.path, f])).values()];
  if (unique.length === 0) return { committed: [] };

  const base = `${target.collectionUri.replace(/\/+$/, '')}/${encodeURIComponent(target.project)}/_apis/git/repositories/${encodeURIComponent(target.repoId)}`;

  const tipRes = await fetcher(`${base}/commits/${target.expectedTip}?api-version=7.1`);
  if (!tipRes.ok) throw await failure('Could not read the commit this build ran on', tipRes);
  const tip = (await tipRes.json()) as { comment?: string };
  if ((tip.comment || '').startsWith(COMMIT_MARKER)) {
    return { committed: [], skipped: 'the commit that was built is itself a GreenCI auto-commit' };
  }

  const checked = await Promise.all(
    unique.map(async (file) => {
      const res = await fetcher(
        `${base}/items?path=${encodeURIComponent(`/${file.path}`)}` +
          `&versionDescriptor.version=${target.expectedTip}&versionDescriptor.versionType=commit` +
          `&includeContent=true&$format=json&api-version=7.1`
      );
      if (res.status === 404) return { file, changeType: 'add' as const };
      if (!res.ok) throw await failure(`Could not check ${file.path} on the branch`, res);
      const item = (await res.json()) as { content?: string };
      return { file, changeType: item.content === file.content ? null : ('edit' as const) };
    })
  );
  const changes = checked
    .filter((c) => c.changeType !== null)
    .map((c) => ({
      changeType: c.changeType,
      item: { path: `/${c.file.path}` },
      newContent: { content: c.file.content, contentType: 'rawtext' },
    }));
  if (changes.length === 0) {
    return { committed: [], skipped: 'the branch already has these tests with the same content' };
  }

  const pushRes = await fetcher(`${base}/pushes?api-version=7.1`, {
    method: 'POST',
    body: JSON.stringify({
      refUpdates: [{ name: target.branchRef, oldObjectId: target.expectedTip }],
      commits: [{ comment: `${COMMIT_MARKER} [skip ci]`, changes }],
    }),
  });
  if (!pushRes.ok) throw await failure('The push was refused', pushRes);
  return { committed: changes.map((c) => c.item.path.slice(1)) };
}
