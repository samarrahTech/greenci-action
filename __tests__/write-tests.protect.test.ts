import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeTests, ProtectExisting } from '../src/test-runner';
import { healFailedTests } from '../src/self-healer';
import * as testRunner from '../src/test-runner';
import { ActionConfig, ILLMClient } from '../src/types';

jest.mock('@actions/core');
jest.mock('@actions/exec');

// Real filesystem: the no-overwrite guarantee is about files on disk, so the
// test must be too (the prompt's existing-tests list is NOT the source of truth).
describe('writeTests with ProtectExisting', () => {
  let work: string;
  const mk = (name: string, code = 'theirs') => {
    fs.mkdirSync(path.dirname(path.join(work, 'e2e', name)), { recursive: true });
    fs.writeFileSync(path.join(work, 'e2e', name), code);
  };
  const read = (name: string) => fs.readFileSync(path.join(work, 'e2e', name), 'utf-8');
  const gen = (filename: string, code = 'generated') => ({ filename, code, description: '', confidence: 1 });

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'greenci-protect-'));
  });
  afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

  it('writes a colliding generated spec under <stem>-bootstrap and leaves the customer file intact', async () => {
    mk('auth-login.spec.ts');
    const protect: ProtectExisting = { owned: new Set(), renamed: [] };
    const tests = [gen('auth-login.spec.ts')];
    await writeTests(tests, work, 'e2e', protect);
    expect(read('auth-login.spec.ts')).toBe('theirs');
    expect(read('auth-login-bootstrap.spec.ts')).toBe('generated');
    expect(tests[0].filename).toBe('auth-login-bootstrap.spec.ts');
    expect(protect.renamed).toEqual([{ from: 'auth-login.spec.ts', to: 'auth-login-bootstrap.spec.ts' }]);
  });

  it('protects files the prompt list would skip: a 60KB spec, a .spec.tsx, a .spec.mts, a nested path', async () => {
    mk('big.spec.ts', 'x'.repeat(60 * 1024));
    mk('login.spec.tsx');
    mk('cart.spec.mts');
    mk('nested/flow.test.js');
    const protect: ProtectExisting = { owned: new Set(), renamed: [] };
    const tests = [gen('big.spec.ts'), gen('login.spec.tsx'), gen('cart.spec.mts'), gen('e2e/nested/flow.test.js')];
    await writeTests(tests, work, 'e2e', protect);
    expect(tests.map((t) => t.filename)).toEqual([
      'big-bootstrap.spec.ts',
      'login-bootstrap.spec.tsx',
      'cart-bootstrap.spec.mts',
      'nested/flow-bootstrap.test.js',
    ]);
    expect(read('login.spec.tsx')).toBe('theirs');
    expect(read('nested/flow.test.js')).toBe('theirs');
    expect(read('nested/flow-bootstrap.test.js')).toBe('generated');
  });

  it('skips a -bootstrap name that is itself taken', async () => {
    mk('a.spec.ts');
    mk('a-bootstrap.spec.ts');
    const protect: ProtectExisting = { owned: new Set(), renamed: [] };
    const tests = [gen('a.spec.ts')];
    await writeTests(tests, work, 'e2e', protect);
    expect(tests[0].filename).toBe('a-bootstrap-2.spec.ts');
  });

  it('lets this run rewrite its own files (healing) and does not report that as a customer collision', async () => {
    const protect: ProtectExisting = { owned: new Set(), renamed: [] };
    await writeTests([gen('new.spec.ts', 'v1')], work, 'e2e', protect);
    await writeTests([gen('new.spec.ts', 'v2')], work, 'e2e', protect);
    expect(read('new.spec.ts')).toBe('v2');
    expect(protect.renamed).toEqual([]);
  });

  it('a healed test is written back to the renamed file, not to the name the heal API returns', async () => {
    mk('auth-login.spec.ts');
    const protect: ProtectExisting = { owned: new Set(), renamed: [] };
    const tests = [gen('auth-login.spec.ts', 'v1')];
    await writeTests(tests, work, 'e2e', protect);
    const runSpy = jest.spyOn(testRunner, 'runTests').mockResolvedValue([{ filename: 'auth-login-bootstrap.spec.ts', passed: true, duration: 1 }]);
    const llm = {
      healTest: jest.fn().mockResolvedValue({ ...gen('auth-login.spec.ts', 'healed'), verdict: { classification: 'test-issue', reasoning: '' } }),
    } as unknown as ILLMClient;
    const config = { testDir: 'e2e', baseUrl: 'http://localhost:3000', maxRetries: 1 } as ActionConfig;
    const out = await healFailedTests(
      [{ test: tests[0], result: { filename: tests[0].filename, passed: false, duration: 1, error: 'strict mode violation' } }],
      { routes: [], components: [], apiEndpoints: [], modifiedFiles: [], summary: '' },
      config,
      llm,
      work,
      protect,
    );
    runSpy.mockRestore();
    expect(read('auth-login.spec.ts')).toBe('theirs');
    expect(read('auth-login-bootstrap.spec.ts')).toBe('healed');
    expect(out.healed[0].filename).toBe('auth-login-bootstrap.spec.ts');
  });
});
