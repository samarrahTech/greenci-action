import * as fs from 'fs';
import * as path from 'path';
import { readExistingTests, formatExistingTestsForAPI, avoidOverwritingExisting } from '../src/existing-tests';

describe('existing-tests', () => {
  const tmpDir = path.join(__dirname, '__tmp_existing_tests__');
  const testDir = 'e2e';
  const fullTestDir = path.join(tmpDir, testDir);

  beforeEach(() => {
    fs.mkdirSync(fullTestDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads .spec.ts and .test.ts files from testDir', () => {
    fs.writeFileSync(path.join(fullTestDir, 'login.spec.ts'), 'test("login", () => {});');
    fs.writeFileSync(path.join(fullTestDir, 'signup.test.ts'), 'test("signup", () => {});');
    fs.writeFileSync(path.join(fullTestDir, 'utils.ts'), 'export const x = 1;'); // should be skipped

    const results = readExistingTests(tmpDir, testDir);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.filename).sort()).toEqual(['login.spec.ts', 'signup.test.ts']);
    expect(results[0].code).toBeTruthy();
  });

  it('reads files from nested subdirectories', () => {
    const subDir = path.join(fullTestDir, 'auth');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'oauth.spec.ts'), 'test("oauth", () => {});');

    const results = readExistingTests(tmpDir, testDir);
    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe(path.join('auth', 'oauth.spec.ts'));
  });

  it('skips files larger than 50KB', () => {
    const bigContent = 'x'.repeat(51 * 1024);
    fs.writeFileSync(path.join(fullTestDir, 'big.spec.ts'), bigContent);
    fs.writeFileSync(path.join(fullTestDir, 'small.spec.ts'), 'test("small", () => {});');

    const results = readExistingTests(tmpDir, testDir);
    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe('small.spec.ts');
  });

  it('returns empty array if testDir does not exist', () => {
    const results = readExistingTests(tmpDir, 'nonexistent');
    expect(results).toEqual([]);
  });

  it('returns empty array if no test files exist', () => {
    fs.writeFileSync(path.join(fullTestDir, 'readme.md'), '# Tests');
    const results = readExistingTests(tmpDir, testDir);
    expect(results).toEqual([]);
  });

  describe('formatExistingTestsForAPI', () => {
    it('formats tests with filename comments', () => {
      const tests = [
        { filename: 'login.spec.ts', code: 'test("login", () => {});' },
        { filename: 'signup.spec.ts', code: 'test("signup", () => {});' },
      ];

      const formatted = formatExistingTestsForAPI(tests);
      expect(formatted).toHaveLength(2);
      expect(formatted[0]).toBe('// filename: login.spec.ts\ntest("login", () => {});');
      expect(formatted[1]).toBe('// filename: signup.spec.ts\ntest("signup", () => {});');
    });

    it('returns empty array for empty input', () => {
      expect(formatExistingTestsForAPI([])).toEqual([]);
    });
  });
});

// Bootstrap rewrote committed specs (TME-web PR #25): a generated file that
// collides with an existing one must be written under a new name instead.
describe('avoidOverwritingExisting', () => {
  const existing = [
    { filename: 'auth-login.spec.ts', code: '' },
    { filename: 'auth-login-bootstrap.spec.ts', code: '' },
    { filename: 'nested/cart.test.ts', code: '' },
  ];

  it('leaves non-colliding names alone', () => {
    const r = avoidOverwritingExisting([{ filename: 'checkout.spec.ts' }], existing, 'e2e');
    expect(r.tests[0].filename).toBe('checkout.spec.ts');
    expect(r.renamed).toEqual([]);
  });

  it('renames a collision and skips names that are also taken', () => {
    const r = avoidOverwritingExisting([{ filename: 'auth-login.spec.ts' }], existing, 'e2e');
    expect(r.tests[0].filename).toBe('auth-login-bootstrap-2.spec.ts');
    expect(r.renamed).toEqual([{ from: 'auth-login.spec.ts', to: 'auth-login-bootstrap-2.spec.ts' }]);
  });

  it('normalises a testDir prefix and nested paths before comparing', () => {
    const r = avoidOverwritingExisting([{ filename: 'e2e/nested/cart.test.ts' }], existing, 'e2e');
    expect(r.tests[0].filename).toBe('nested/cart-bootstrap.test.ts');
  });

  it('does not let two generated files collide with each other after renaming', () => {
    const r = avoidOverwritingExisting(
      [{ filename: 'auth-login.spec.ts' }, { filename: 'auth-login.spec.ts' }],
      [{ filename: 'auth-login.spec.ts', code: '' }],
      'e2e',
    );
    expect(r.tests.map((t) => t.filename)).toEqual(['auth-login-bootstrap.spec.ts', 'auth-login-bootstrap-2.spec.ts']);
  });
});
