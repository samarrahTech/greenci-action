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
