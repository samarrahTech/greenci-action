import { PRContext } from './types';
export declare function commitTests(token: string, prContext: PRContext, testFiles: string[], workDir: string): Promise<string[]>;
/**
 * Bootstrap mode runs from workflow_dispatch with no PR context: commit the
 * generated suite to a new branch off the default branch and open a PR.
 * Returns the PR URL and the list of committed files.
 */
export declare function createBootstrapPR(token: string, owner: string, repo: string, testFiles: string[], workDir: string, prBody: string): Promise<{
    prUrl: string;
    committedFiles: string[];
}>;
