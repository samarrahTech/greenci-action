import * as fs from 'fs';
import {
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
