import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertSafeToWrite, UnsafeTestPathError } from '../src/safe-paths';

/**
 * These use the REAL filesystem on purpose. safe-paths' lexical check is
 * symlink-blind by construction, so a test against a mocked `fs` cannot
 * demonstrate the containment property that matters here.
 *
 * The attack: a fork PR commits `e2e/login.spec.ts` as a symlink pointing
 * outside the test dir. The name passes every lexical rule; `writeFileSync`
 * then follows the link and writes attacker-chosen content wherever it points
 * — and the action commits the result.
 */
describe('assertSafeToWrite (real filesystem)', () => {
  let tmp: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'greenci-safe-paths-'));
    root = path.join(tmp, 'e2e');
    outside = path.join(tmp, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('allows a plain new file inside the test dir', () => {
    expect(() => assertSafeToWrite(root, path.join(root, 'login.spec.ts'))).not.toThrow();
  });

  it('allows overwriting an existing regular file', () => {
    const p = path.join(root, 'login.spec.ts');
    fs.writeFileSync(p, 'old', 'utf-8');
    expect(() => assertSafeToWrite(root, p)).not.toThrow();
  });

  it('BLOCKS a spec-named symlink pointing outside the test dir', () => {
    const target = path.join(outside, 'pre-commit');
    fs.writeFileSync(target, 'original', 'utf-8');
    const link = path.join(root, 'login.spec.ts');
    fs.symlinkSync(target, link);

    expect(() => assertSafeToWrite(root, link)).toThrow(UnsafeTestPathError);

    // Prove the attack would otherwise land: writing through the link mutates
    // the outside file.
    fs.writeFileSync(link, 'pwned', 'utf-8');
    expect(fs.readFileSync(target, 'utf-8')).toBe('pwned');
  });

  it('BLOCKS a write through a symlinked parent directory', () => {
    const linkedDir = path.join(root, 'nested');
    fs.symlinkSync(outside, linkedDir);
    expect(() => assertSafeToWrite(root, path.join(linkedDir, 'a.spec.ts'))).toThrow(UnsafeTestPathError);
  });

  it('BLOCKS a path that exists as a directory', () => {
    const p = path.join(root, 'weird.spec.ts');
    fs.mkdirSync(p);
    expect(() => assertSafeToWrite(root, p)).toThrow(UnsafeTestPathError);
  });

  it('allows a genuine nested subdirectory', () => {
    fs.mkdirSync(path.join(root, 'auth'), { recursive: true });
    expect(() => assertSafeToWrite(root, path.join(root, 'auth', 'login.spec.ts'))).not.toThrow();
  });

  it('tolerates a symlinked test root itself (checkout under a linked path)', () => {
    // macOS /tmp is itself a symlink to /private/tmp — the check must compare
    // real paths on both sides, not reject the whole run.
    const realRoot = fs.realpathSync.native(root);
    expect(() => assertSafeToWrite(realRoot, path.join(realRoot, 'a.spec.ts'))).not.toThrow();
    expect(() => assertSafeToWrite(root, path.join(realRoot, 'a.spec.ts'))).not.toThrow();
  });
});
