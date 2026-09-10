import * as fs from 'fs';
import * as path from 'path';

/**
 * Test filenames are model output, and model output is attacker-reachable:
 * the PR diff is fed to the model, so a contributor can put
 * `// filename: ../../.github/scripts/release.sh` in a comment and try to get
 * the action to write — and then commit — a file outside the test directory.
 *
 * `path.join` does NOT neutralise `..`; it resolves it. Every place that turns
 * a model-supplied filename into a real path must go through resolveTestPath.
 */
export class UnsafeTestPathError extends Error {
  constructor(filename: string, reason: string) {
    super(`Refusing to use test filename ${JSON.stringify(filename)}: ${reason}`);
    this.name = 'UnsafeTestPathError';
  }
}

/**
 * Suffixes a generated Playwright test is allowed to have.
 *
 * Must stay in step with existing-tests.ts, which harvests BOTH `.spec.*` and
 * `.test.*`, and with the prompt that tells the model to reuse an existing
 * filename when updating a test. Accepting only `.spec.*` here silently drops
 * every update in a repo whose e2e files are named `*.test.ts` — which is also
 * Playwright's default testMatch.
 */
const ALLOWED_SUFFIX = /\.(spec|test)\.(ts|tsx|js|jsx|mts|mjs)$/;

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
export function resolveTestPath(workDir: string, testDir: string, filename: string): ResolvedTestPath {
  if (typeof filename !== 'string' || filename.trim() === '') {
    throw new UnsafeTestPathError(String(filename), 'empty or not a string');
  }
  if (filename.includes('\0')) {
    throw new UnsafeTestPathError(filename, 'contains a null byte');
  }
  // Backslashes are a path separator on win32 and a traversal vector there;
  // runners are Linux, but never let the meaning of a path depend on the OS.
  if (filename.includes('\\')) {
    throw new UnsafeTestPathError(filename, 'contains a backslash');
  }
  if (path.isAbsolute(filename) || /^[a-zA-Z]:/.test(filename)) {
    throw new UnsafeTestPathError(filename, 'is an absolute path');
  }

  // Models often echo the test dir back ("e2e/auth.spec.ts") — strip one
  // leading copy so we don't nest e2e/e2e/. Cosmetic, not a security control.
  let candidate = filename;
  if (testDir && candidate.startsWith(`${testDir}/`)) {
    candidate = candidate.slice(testDir.length + 1);
  }

  if (!ALLOWED_SUFFIX.test(path.basename(candidate))) {
    throw new UnsafeTestPathError(filename, 'is not a .spec/.test .{ts,tsx,js,jsx,mts,mjs} file');
  }

  const root = path.resolve(workDir, testDir);
  const absolute = path.resolve(root, candidate);

  // The containment check. `absolute === root` is also rejected: a filename
  // that resolves to the directory itself is not a file we should write.
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new UnsafeTestPathError(filename, `escapes the test directory (${root})`);
  }
  if (absolute === root) {
    throw new UnsafeTestPathError(filename, 'resolves to the test directory itself');
  }

  return { absolute, relative: path.relative(root, absolute) };
}

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
export function assertSafeToWrite(root: string, absolute: string): void {
  // If the path exists at all, it must be a regular file — not a link.
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    stat = undefined; // does not exist yet: fine, that's the common case
  }
  if (stat && stat.isSymbolicLink()) {
    throw new UnsafeTestPathError(absolute, 'already exists as a symlink');
  }
  if (stat && !stat.isFile()) {
    throw new UnsafeTestPathError(absolute, 'exists and is not a regular file');
  }

  // The parent chain must not escape via a link either.
  const realRoot = realPathOrSelf(root);
  const realParent = realPathOrSelf(path.dirname(absolute));
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
    throw new UnsafeTestPathError(absolute, 'resolves outside the test directory via a symlinked parent');
  }
}

/** realpath, falling back to the lexical path when it doesn't exist yet. */
function realPathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * True when the filename is safe. For call sites that want to skip a bad test
 * and carry on rather than fail the whole run.
 */
export function isSafeTestPath(workDir: string, testDir: string, filename: string): boolean {
  try {
    resolveTestPath(workDir, testDir, filename);
    return true;
  } catch {
    return false;
  }
}
