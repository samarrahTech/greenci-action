/**
 * Test filenames are model output, and model output is attacker-reachable:
 * the PR diff is fed to the model, so a contributor can put
 * `// filename: ../../.github/scripts/release.sh` in a comment and try to get
 * the action to write — and then commit — a file outside the test directory.
 *
 * `path.join` does NOT neutralise `..`; it resolves it. Every place that turns
 * a model-supplied filename into a real path must go through resolveTestPath.
 */
export declare class UnsafeTestPathError extends Error {
    constructor(filename: string, reason: string);
}
export interface ResolvedTestPath {
    /** Absolute path to write/run, guaranteed inside `<workDir>/<testDir>`. */
    absolute: string;
    /** Filename relative to `<workDir>/<testDir>`, normalised (no leading testDir). */
    relative: string;
}
/**
 * Resolve a model-supplied test filename to an absolute path inside the test
 * directory, or throw. Containment is checked on the *resolved* path, which is
 * the only check that actually holds — prefix-stripping and `..` counting are
 * both bypassable.
 */
export declare function resolveTestPath(workDir: string, testDir: string, filename: string): ResolvedTestPath;
/**
 * Containment check that also survives symlinks.
 *
 * `resolveTestPath` resolves lexically, which is the right check for the *name*
 * but blind to the filesystem: the attacker in this threat model supplies the
 * PR contents as well as the injected filename, so they can commit
 * `e2e/login.spec.ts` as a symlink to `../../.git/hooks/pre-commit`. That name
 * passes every lexical rule, and `fs.writeFileSync` follows the link — writing
 * attacker-chosen content outside the test directory, which is then committed
 * (and, for a hook, executed).
 *
 * So before writing: reject if the target itself is a symlink, and verify the
 * real path of the parent directory is still inside the real test directory.
 */
export declare function assertSafeToWrite(root: string, absolute: string): void;
/**
 * True when the filename is safe. For call sites that want to skip a bad test
 * and carry on rather than fail the whole run.
 */
export declare function isSafeTestPath(workDir: string, testDir: string, filename: string): boolean;
