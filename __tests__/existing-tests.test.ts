import * as fs from 'fs';
import * as path from 'path';
import { readExistingTests, formatExistingTestsForAPI } from '../src/existing-tests';

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
