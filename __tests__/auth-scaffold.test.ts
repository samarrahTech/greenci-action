import * as fs from 'fs';
import {
  classifyAuthFailure,
  needsAuthScaffold,
  loginPathFromJourneys,
  authSetupSource,
  isAuthSetupFailure,
  writeAuthScaffold,
} from '../src/auth-scaffold';

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, mkdirSync: jest.fn(), writeFileSync: jest.fn() };
});

describe('needsAuthScaffold', () => {
  it('detects storageState references in generated specs', () => {
    expect(needsAuthScaffold([{ filename: 'a.spec.ts', code: "test.use({ storageState: 'playwright/.auth/user.json' })", description: '', confidence: 1 }])).toBe(true);
    expect(needsAuthScaffold([{ filename: 'b.spec.ts', code: 'await page.goto("/")', description: '', confidence: 1 }])).toBe(false);
  });
});

describe('loginPathFromJourneys', () => {
  it('extracts a mentioned login path', () => {
    expect(loginPathFromJourneys(['Sign in with email at /account/login then browse'])).toBe('/account/login');
    expect(loginPathFromJourneys(['Visit /signin and authenticate'])).toBe('/signin');
  });
  it('defaults to /login', () => {
    expect(loginPathFromJourneys(['Open the expenses page'])).toBe('/login');
  });
});

describe('authSetupSource', () => {
  it('reads credentials from env, saves storageState, never hardcodes secrets', () => {
    const src = authSetupSource('/login');
    expect(src).toContain('process.env.TEST_USER_EMAIL');
    expect(src).toContain('process.env.TEST_USER_PASSWORD');
    expect(src).toContain("storageState({ path: 'playwright/.auth/user.json' })");
    expect(src).toContain("goto('/login')");
    expect(src).toContain('setup.skip(!EMAIL || !PASSWORD');
  });
});

describe('writeAuthScaffold', () => {
  it('writes auth.setup.ts into the test dir', () => {
    const p = writeAuthScaffold('/work', 'e2e', '/login');
    expect(p).toContain('e2e/auth.setup.ts');
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('auth.setup.ts'), expect.stringContaining('TEST_USER_EMAIL'), 'utf-8');
  });
});

describe('isAuthSetupFailure', () => {
  it('classifies the missing-storageState family', () => {
    expect(isAuthSetupFailure("Error: ENOENT: no such file or directory, open 'playwright/.auth/user.json'")).toBe(true);
    expect(isAuthSetupFailure('Error reading storage state from playwright/.auth/user.json')).toBe(true);
    expect(isAuthSetupFailure('TEST_USER_EMAIL / TEST_USER_PASSWORD not set — authenticated specs will be skipped')).toBe(true);
  });
  it('does not classify ordinary failures', () => {
    expect(isAuthSetupFailure('strict mode violation: getByText resolved to 2 elements')).toBe(false);
    expect(isAuthSetupFailure(undefined)).toBe(false);
  });
});

describe('isAuthSetupFailure — setup-execution failures', () => {
  it('classifies a failing setup project (the broken-login case)', () => {
    const err = [
      '  1) [setup] › e2e/auth.setup.ts:16:6 › authenticate ────────────────',
      '    TimeoutError: page.waitForURL: Timeout 60000ms exceeded.',
      '      3 did not run',
    ].join('\n');
    expect(isAuthSetupFailure(err)).toBe(true);
  });

  it('classifies dependent specs skipped because setup failed', () => {
    expect(isAuthSetupFailure('e2e/auth.setup.ts failed\n\n  3 did not run')).toBe(true);
  });

  it('still ignores ordinary spec failures that merely mention timeouts', () => {
    expect(isAuthSetupFailure('TimeoutError: locator.click: Timeout 5000ms exceeded')).toBe(false);
    expect(isAuthSetupFailure('expected 2 elements, strict mode violation')).toBe(false);
  });
});

describe('isAuthSetupFailure — must NOT fire on ordinary failures (review findings)', () => {
  it('ignores a spec failure whose trace merely mentions auth.setup.ts', () => {
    expect(isAuthSetupFailure('Error: expected visible\n    at e2e/cart.spec.ts:9\n  (session from auth.setup.ts)')).toBe(false);
  });

  it('ignores a passing setup that logs to stdout (no failure marker)', () => {
    expect(isAuthSetupFailure('  [setup] › e2e/auth.setup.ts:16:6 › authenticate\nsigned in as test user')).toBe(false);
  });

  it('ignores a spec named like the scaffold running in the normal project', () => {
    expect(isAuthSetupFailure('  1) [chromium] › e2e/auth.setup.ts:3:1 › smoke\n    Error: boom')).toBe(false);
  });

  it('ignores "did not run" without any auth.setup.ts involvement', () => {
    expect(isAuthSetupFailure('  1) [chromium] › e2e/cart.spec.ts:2:1 › x\n  2 did not run')).toBe(false);
  });
});

describe('classifyAuthFailure families', () => {
  it('separates missing-session from setup-failed', () => {
    expect(classifyAuthFailure("ENOENT: no such file or directory, open 'playwright/.auth/user.json'")).toBe('missing-session');
    expect(classifyAuthFailure('  1) [setup] › e2e/auth.setup.ts:16:6 › authenticate\n TimeoutError\n 3 did not run')).toBe('setup-failed');
    expect(classifyAuthFailure('strict mode violation')).toBeNull();
  });
});

describe('authSetupSource — session reuse', () => {
  it('skips signing in again when a recent session file exists', () => {
    const src = authSetupSource('/login');
    expect(src).toContain("hasUsableSession('playwright/.auth/user.json')");
    expect(src).toContain('SESSION_MAX_AGE_MS');
    expect(src).toContain('statSync');
  });

  it('only reuses a session that actually carries credentials', () => {
    const src = authSetupSource('/login');
    // A fresh-but-empty file must not short-circuit auth for the whole run
    expect(src).toMatch(/cookies > 0 \|\| stored > 0/);
    expect(src).toContain('catch');
  });

  it('checks the credentials guard AFTER the skip, so unset creds still classify as missing-session', () => {
    const src = authSetupSource('/login');
    expect(src.indexOf('setup.skip(!EMAIL')).toBeGreaterThan(-1);
    expect(src.indexOf('if (hasUsableSession(')).toBeGreaterThan(src.indexOf('setup.skip(!EMAIL'));
  });
});
