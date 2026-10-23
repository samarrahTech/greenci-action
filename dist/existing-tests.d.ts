export interface ExistingTest {
    filename: string;
    code: string;
}
/**
 * Reads existing test files from the test directory.
 * Skips files larger than 50KB to avoid token bloat.
 */
export declare function readExistingTests(workDir: string, testDir: string): ExistingTest[];
/**
 * Formats existing tests for the API's existingTests field.
 * Each string = "// filename: login.spec.ts\n{code}"
 */
export declare function formatExistingTestsForAPI(tests: ExistingTest[]): string[];
export interface RenamedTest {
    from: string;
    to: string;
}
/**
 * Bootstrap must never rewrite a test the customer already has. The model is
 * shown the existing suite and told to add, not replace — but it still reuses
 * a committed filename often enough (TME-web PR #25 rewrote auth-login.spec.ts)
 * that the guarantee has to live here: a generated file whose name is already
 * in the repo is written under `<stem>-bootstrap.spec.ts` instead, and the PR
 * says so, so the owner can diff the two and keep one.
 */
export declare function avoidOverwritingExisting<T extends {
    filename: string;
}>(tests: T[], existing: ExistingTest[], testDir: string): {
    tests: T[];
    renamed: RenamedTest[];
};
