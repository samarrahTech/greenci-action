import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { savePlaywrightDevDependency, gitBlobSha } from '../src/dev-dependency';

jest.mock('@actions/core');
jest.mock('@actions/exec');

// GC-078: a bootstrap PR on a repo without Playwright committed specs that
// import @playwright/test and left the dependency out.
describe('savePlaywrightDevDependency', () => {
  let workDir: string;
  const write = (rel: string, content: string) => {
    const file = path.join(workDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const read = (rel: string) => fs.readFileSync(path.join(workDir, rel), 'utf-8');
  const exists = (rel: string) => fs.existsSync(path.join(workDir, rel));
  const PKG = '{\n  "name": "app",\n  "dependencies": { "left-pad": "1.3.0" }\n}\n';
  const NPM_LOCK = '{ "lockfileVersion": 3, "packages": {} }';

  /** Stand-in for the package manager: declares the dependency and rewrites the files given. */
  const managerWrites = (files: Record<string, string>, range = '^1.65.0') =>
    (exec.exec as jest.Mock).mockImplementation(async () => {
      const pkg = JSON.parse(read('package.json'));
      pkg.devDependencies = { '@playwright/test': range };
      write('package.json', JSON.stringify(pkg, null, 2));
      for (const [f, content] of Object.entries(files)) write(f, content);
      return 0;
    });
  const expectUntouched = (files: Record<string, string>) => {
    for (const [f, content] of Object.entries(files)) expect(read(f)).toBe(content);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc078-'));
    write('package.json', PKG);
    write('node_modules/@playwright/test/package.json', '{ "version": "1.65.0" }');
  });
  afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

  it.each([
    ['package-lock.json', NPM_LOCK, '{ "lockfileVersion": 3, "packages": { "pw": {} } }', 'npm', ['install', '-D', '@playwright/test@1.65.0', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']],
    ['pnpm-lock.yaml', "lockfileVersion: '9.0'\n", "lockfileVersion: '9.0'\npw: 1\n", 'pnpm', ['add', '-D', '@playwright/test@1.65.0', '--lockfile-only', '--ignore-scripts']],
    ['bun.lock', '{ "lockfileVersion": 1 }', '{ "lockfileVersion": 1, "pw": 1 }', 'bun', ['add', '-d', '@playwright/test@1.65.0', '--lockfile-only', '--ignore-scripts']],
  ])('with %s: changes package.json and the lockfile only, at the version the tests ran on', async (lockfile, was, becomes, tool, args) => {
    write(lockfile, was);
    managerWrites({ [lockfile]: becomes });

    const outcome = await savePlaywrightDevDependency(workDir);

    expect(exec.exec).toHaveBeenCalledWith(tool, args, expect.objectContaining({ cwd: workDir }));
    expect(outcome.status).toBe('saved');
    expect(outcome.files.map((f) => path.relative(workDir, f.path)).sort()).toEqual(['package.json', lockfile].sort());
    // What each file held before travels with it, so the caller can compare it with the default branch.
    expect(outcome.files.find((f) => f.path.endsWith('package.json'))!.before.toString()).toBe(PKG);
    expect(outcome.files.find((f) => f.path.endsWith(lockfile))!.before.toString()).toBe(was);
  });

  it('uses lockfile-only mode on Yarn 2+, detected by .yarnrc.yml or packageManager', async () => {
    for (const marker of ['yarnrc', 'packageManager']) {
      write('package.json', marker === 'packageManager' ? '{ "name": "app", "packageManager": "yarn@4.5.0" }' : PKG);
      if (marker === 'yarnrc') write('.yarnrc.yml', 'nodeLinker: node-modules');
      else fs.rmSync(path.join(workDir, '.yarnrc.yml'), { force: true });
      write('yarn.lock', '__metadata:\n  version: 8\n');
      managerWrites({ 'yarn.lock': '__metadata:\n  version: 8\npw: 1\n' });
      const outcome = await savePlaywrightDevDependency(workDir);
      expect(outcome.status).toBe('saved');
    }
    for (const [tool, args] of (exec.exec as jest.Mock).mock.calls) {
      expect([tool, args]).toEqual(['yarn', ['add', '-D', '@playwright/test@1.65.0', '--mode=update-lockfile']]);
    }
  });

  it('declares the dependency without inventing a lockfile when the repo has none', async () => {
    write('.git/HEAD', 'ref: refs/heads/main');
    managerWrites({});
    const outcome = await savePlaywrightDevDependency(workDir);
    expect(exec.exec).toHaveBeenCalledWith('npm', ['pkg', 'set', 'devDependencies.@playwright/test=^1.65.0'], expect.anything());
    expect(outcome.status).toBe('saved');
    expect(outcome.files.map((f) => path.basename(f.path))).toEqual(['package.json']);
    expect(exists('package-lock.json')).toBe(false);
  });

  it('does not edit package.json alone in a subfolder, where the lockfile may live further up', async () => {
    const outcome = await savePlaywrightDevDependency(workDir);
    expect(outcome.status).toBe('manual');
    expect(exec.exec).not.toHaveBeenCalled();
  });

  it('restoreFiles puts back what a caller decided not to commit', () => {
    const { restoreFiles } = jest.requireActual('../src/dev-dependency');
    write('package.json', 'changed');
    restoreFiles([{ path: path.join(workDir, 'package.json'), before: Buffer.from(PKG) }]);
    expect(read('package.json')).toBe(PKG);
  });

  it('adds -w in a pnpm workspace root', async () => {
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write('pnpm-workspace.yaml', 'packages: []');
    managerWrites({ 'pnpm-lock.yaml': "lockfileVersion: '9.0'\npw: 1\n" });
    await savePlaywrightDevDependency(workDir);
    expect((exec.exec as jest.Mock).mock.calls[0][1]).toContain('-w');
  });

  it.each([
    ['Yarn 1 (no lockfile-only mode)', { 'yarn.lock': '# yarn lockfile v1\n' }],
    ["a Yarn Plug'n'Play repo", { 'yarn.lock': '__metadata:\n  version: 8\n', '.yarnrc.yml': 'x: 1', '.pnp.cjs': '' }],
    ['a Yarn zero-install repo', { 'yarn.lock': '__metadata:\n  version: 8\n', '.yarnrc.yml': 'x: 1', '.yarn/cache/a.zip': '' }],
    ["Bun's binary lockfile", { 'bun.lockb': 'binary' }],
  ])('leaves %s alone and runs nothing', async (_name, files) => {
    for (const [f, content] of Object.entries(files)) write(f, content);
    const outcome = await savePlaywrightDevDependency(workDir);
    expect(outcome.status).toBe('manual');
    expect(exec.exec).not.toHaveBeenCalled();
    expect(read('package.json')).toBe(PKG);
  });

  it('puts every file back, and says why, when the package manager fails', async () => {
    write('package-lock.json', NPM_LOCK);
    (exec.exec as jest.Mock).mockImplementation(async (_t: string, _a: string[], opts: { listeners: { stderr: (d: Buffer) => void } }) => {
      write('package.json', '{ "half": "written" }');
      write('package-lock.json', 'half');
      opts.listeners.stderr(Buffer.from('npm error code E401\nnpm error Incorrect or missing password.\n'));
      return 1;
    });

    const outcome = await savePlaywrightDevDependency(workDir);

    expect(outcome.status).toBe('manual');
    expectUntouched({ 'package.json': PKG, 'package-lock.json': NPM_LOCK });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('E401'));
  });

  it('removes a lockfile a failed attempt created', async () => {
    (exec.exec as jest.Mock).mockImplementation(async () => {
      write('package-lock.json', 'half');
      return 1;
    });
    await savePlaywrightDevDependency(workDir);
    expect(exists('package-lock.json')).toBe(false);
  });

  // A newer npm/pnpm on the runner succeeds and rewrites the whole lockfile
  // in its own format, which breaks the customer's `npm ci`.
  it('backs out when the lockfile came back in a different format', async () => {
    const old = '{ "lockfileVersion": 1, "dependencies": {} }';
    write('package-lock.json', old);
    managerWrites({ 'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }' });

    const outcome = await savePlaywrightDevDependency(workDir);

    expect(outcome.status).toBe('manual');
    expectUntouched({ 'package.json': PKG, 'package-lock.json': old });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('different format'));
  });

  it('backs out when the dependency was written as a workspace catalog reference', async () => {
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write('pnpm-workspace.yaml', 'packages: []\n');
    managerWrites({ 'pnpm-lock.yaml': "lockfileVersion: '9.0'\npw: 1\n", 'pnpm-workspace.yaml': 'packages: []\ncatalog: {}\n' }, 'catalog:');

    const outcome = await savePlaywrightDevDependency(workDir);

    expect(outcome.status).toBe('manual');
    expectUntouched({ 'package.json': PKG, 'pnpm-workspace.yaml': 'packages: []\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
  });

  it('backs out when the command changed a file this PR would not carry', async () => {
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write('pnpm-workspace.yaml', 'packages: []\n');
    managerWrites({ 'pnpm-lock.yaml': "lockfileVersion: '9.0'\npw: 1\n", 'pnpm-workspace.yaml': 'packages: []\nextra: 1\n' });

    const outcome = await savePlaywrightDevDependency(workDir);

    expect(outcome.status).toBe('manual');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('pnpm-workspace.yaml'));
    expect(read('pnpm-workspace.yaml')).toBe('packages: []\n');
  });

  it('reports a repo that already declares the dependency, and runs nothing', async () => {
    write('package.json', '{ "devDependencies": { "@playwright/test": "^1.40.0" } }');
    expect((await savePlaywrightDevDependency(workDir)).status).toBe('declared');
    expect(exec.exec).not.toHaveBeenCalled();
  });

  it('does nothing without an installed version to pin, or without a package.json', async () => {
    fs.rmSync(path.join(workDir, 'node_modules'), { recursive: true });
    expect((await savePlaywrightDevDependency(workDir)).status).toBe('manual');
    fs.rmSync(path.join(workDir, 'package.json'));
    expect((await savePlaywrightDevDependency(workDir)).status).toBe('manual');
    expect(exec.exec).not.toHaveBeenCalled();
  });
});

describe('gitBlobSha', () => {
  it('matches what git itself computes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc078-sha-'));
    try {
      const content = Buffer.from('{\n  "name": "app"\n}\n');
      fs.writeFileSync(path.join(dir, 'f'), content);
      const expected = execFileSync('git', ['hash-object', path.join(dir, 'f')], { encoding: 'utf-8' }).trim();
      expect(gitBlobSha(content)).toBe(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
