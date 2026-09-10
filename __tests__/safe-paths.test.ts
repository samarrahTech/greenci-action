import * as path from 'path';
import { resolveTestPath, isSafeTestPath, UnsafeTestPathError } from '../src/safe-paths';

const WORK = '/work';
const DIR = 'e2e';

describe('resolveTestPath', () => {
  describe('blocks the attack from the audit', () => {
    // The finding: a PR author puts `// filename: ../../<path>` in a diff the
    // model reads, and the action writes — then commits — outside the test dir.
    it.each([
      ['../../package.json'],
      ['../../.github/workflows/deploy.yml'],
      ['../../../etc/passwd'],
      ['e2e/../../package.json'],
      ['a/../../../outside.spec.ts'],
      ['./../../outside.spec.ts'],
    ])('rejects traversal: %s', (filename) => {
      expect(() => resolveTestPath(WORK, DIR, filename)).toThrow(UnsafeTestPathError);
    });

    it('rejects absolute paths', () => {
      expect(() => resolveTestPath(WORK, DIR, '/etc/cron.d/evil.spec.ts')).toThrow(UnsafeTestPathError);
    });

    it('rejects windows drive and UNC paths', () => {
      expect(() => resolveTestPath(WORK, DIR, 'C:/evil.spec.ts')).toThrow(UnsafeTestPathError);
      expect(() => resolveTestPath(WORK, DIR, 'a\\..\\..\\evil.spec.ts')).toThrow(UnsafeTestPathError);
    });

    it('rejects a null byte', () => {
      expect(() => resolveTestPath(WORK, DIR, 'ok.spec.ts\0.png')).toThrow(UnsafeTestPathError);
    });

    it('rejects non-spec files even inside the test dir', () => {
      // Writing e2e/package.json or e2e/*.sh is still a write the model chose.
      expect(() => resolveTestPath(WORK, DIR, 'package.json')).toThrow(UnsafeTestPathError);
      expect(() => resolveTestPath(WORK, DIR, 'setup.sh')).toThrow(UnsafeTestPathError);
    });

    it('rejects empty and non-string filenames', () => {
      expect(() => resolveTestPath(WORK, DIR, '')).toThrow(UnsafeTestPathError);
      expect(() => resolveTestPath(WORK, DIR, '   ')).toThrow(UnsafeTestPathError);
      expect(() => resolveTestPath(WORK, DIR, undefined as unknown as string)).toThrow(UnsafeTestPathError);
    });

    it('rejects a name resolving to the test dir itself', () => {
      expect(() => resolveTestPath(WORK, DIR, '.')).toThrow(UnsafeTestPathError);
    });

    it('does not let a testDir-prefixed name smuggle traversal', () => {
      // The old code stripped the `e2e/` prefix and then joined, so this
      // resolved to /work/package.json.
      expect(() => resolveTestPath(WORK, DIR, 'e2e/../package.json')).toThrow(UnsafeTestPathError);
    });
  });

  describe('still accepts the legitimate cases', () => {
    it('resolves a plain filename', () => {
      expect(resolveTestPath(WORK, DIR, 'login.spec.ts')).toEqual({
        absolute: path.join(WORK, DIR, 'login.spec.ts'),
        relative: 'login.spec.ts',
      });
    });

    it('strips one leading copy of the test dir', () => {
      expect(resolveTestPath(WORK, DIR, 'e2e/login.spec.ts')).toEqual({
        absolute: path.join(WORK, DIR, 'login.spec.ts'),
        relative: 'login.spec.ts',
      });
    });

    it('allows nested subdirectories', () => {
      expect(resolveTestPath(WORK, DIR, 'auth/signup.spec.ts').relative).toBe(path.join('auth', 'signup.spec.ts'));
    });

    it.each(['a.spec.ts', 'a.spec.tsx', 'a.spec.js', 'a.spec.jsx', 'a.spec.mts', 'a.spec.mjs'])(
      'accepts suffix %s',
      (filename) => {
        expect(() => resolveTestPath(WORK, DIR, filename)).not.toThrow();
      },
    );

    it('honours a custom test dir', () => {
      expect(resolveTestPath(WORK, 'tests/e2e', 'a.spec.ts').absolute).toBe(path.join(WORK, 'tests/e2e', 'a.spec.ts'));
    });
  });

  it('isSafeTestPath mirrors resolveTestPath without throwing', () => {
    expect(isSafeTestPath(WORK, DIR, 'ok.spec.ts')).toBe(true);
    expect(isSafeTestPath(WORK, DIR, '../../evil.spec.ts')).toBe(false);
  });
});
