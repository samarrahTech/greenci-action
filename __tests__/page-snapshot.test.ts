import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPageSnapshot } from '../src/test-runner';

jest.mock('@actions/core');

// Shape Playwright 1.62 writes for a failed spec (trimmed).
const ERROR_CONTEXT = `# Instructions

- Following Playwright test failed.

# Error details

\`\`\`
TimeoutError: locator.fill: Timeout 1000ms exceeded.
\`\`\`

# Page snapshot

\`\`\`yaml
- heading "New expense" [level=1] [ref=e2]
- textbox "Vendor" [ref=e5]
- button "Save expense" [ref=e8]
\`\`\`

# Test source

\`\`\`ts
await page.getByLabel('Merchant').fill('x');
\`\`\`
`;

describe('readPageSnapshot (GC-092)', () => {
  let workDir: string;
  let outside: string;

  const write = (dir: string, rel: string, body: string) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc092-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gc092-outside-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('returns only the page snapshot section of the error context Playwright printed', () => {
    write(workDir, 'test-results/expenses-add/error-context.md', ERROR_CONTEXT);
    const output = '  1) e2e/expenses-add.spec.ts › adds\n\n    Error Context: test-results/expenses-add/error-context.md\n\n  1 failed';

    expect(readPageSnapshot(output, workDir)).toBe(
      '- heading "New expense" [level=1] [ref=e2]\n- textbox "Vendor" [ref=e5]\n- button "Save expense" [ref=e8]',
    );
  });

  it('accepts an absolute path inside the repo', () => {
    const file = write(workDir, 'out/x/error-context.md', ERROR_CONTEXT);
    expect(readPageSnapshot(`Error Context: ${file}`, workDir)).toContain('textbox "Vendor"');
  });

  it('returns nothing when no error context was printed or the file has no snapshot', () => {
    expect(readPageSnapshot('1 failed', workDir)).toBeUndefined();
    write(workDir, 'test-results/a/error-context.md', '# Error details\n\nboom\n');
    expect(readPageSnapshot('Error Context: test-results/a/error-context.md', workDir)).toBeUndefined();
    expect(readPageSnapshot('Error Context: test-results/missing/error-context.md', workDir)).toBeUndefined();
  });

  it('never reads a file outside the repo, even through a symlink', () => {
    const secret = write(outside, 'error-context.md', ERROR_CONTEXT);
    expect(readPageSnapshot(`Error Context: ${secret}`, workDir)).toBeUndefined();
    expect(readPageSnapshot('Error Context: ../' + path.basename(outside) + '/error-context.md', workDir)).toBeUndefined();
    fs.mkdirSync(path.join(workDir, 'test-results'));
    fs.symlinkSync(secret, path.join(workDir, 'test-results', 'error-context.md'));
    expect(readPageSnapshot('Error Context: test-results/error-context.md', workDir)).toBeUndefined();
  });

  it('reads the path when Playwright colours its output (FORCE_COLOR)', () => {
    write(workDir, 'test-results/c/error-context.md', ERROR_CONTEXT);
    const output = '\x1b[2m    Error Context: test-results/c/error-context.md\x1b[22m\n';
    expect(readPageSnapshot(output, workDir)).toContain('textbox "Vendor"');
  });

  it('gives each failed test its own named block', () => {
    write(workDir, 'test-results/add/error-context.md', ERROR_CONTEXT.replace('# Error details', '# Test info\n\n- Name: expenses >> adds\n\n# Error details'));
    write(
      workDir,
      'test-results/edit/error-context.md',
      '# Test info\n\n- Name: expenses >> edits\n\n# Page snapshot\n\n```yaml\n- textbox "Notes" [ref=e9]\n```\n',
    );
    const output = 'Error Context: test-results/add/error-context.md\nError Context: test-results/edit/error-context.md\nError Context: test-results/add/error-context.md';

    const snap = readPageSnapshot(output, workDir)!;
    expect(snap).toBe(
      '# expenses >> adds\n- heading "New expense" [level=1] [ref=e2]\n- textbox "Vendor" [ref=e5]\n- button "Save expense" [ref=e8]' +
        '\n\n# expenses >> edits\n- textbox "Notes" [ref=e9]',
    );
  });

  it('keeps dialogs and main first, in document order, when the tree is over budget', () => {
    const nav = Array.from({ length: 1500 }, (_, i) => `  - link "Nav ${i}"`).join('\n');
    const tree =
      `- banner:\n${nav}\n- main:\n  - textbox "Vendor" [ref=e5]\n  - button "Save expense"\n` +
      `- dialog "Confirm":\n  - button "Yes"`;
    write(workDir, 'test-results/d/error-context.md', `# Page snapshot\n\n\`\`\`yaml\n${tree}\n\`\`\`\n`);

    const snap = readPageSnapshot('Error Context: test-results/d/error-context.md', workDir)!;
    const mainAt = snap.indexOf('- main:');
    expect(mainAt).toBeGreaterThan(0);
    expect(snap.indexOf('- dialog "Confirm":\n  - button "Yes"')).toBeGreaterThan(mainAt);
    expect(snap).toContain('  - textbox "Vendor" [ref=e5]');
    expect(snap.startsWith('- banner:')).toBe(true);
    expect(snap.endsWith('\n… (truncated)')).toBe(true);
    expect(snap.length).toBeLessThanOrEqual(8_000);
  });

  it('shortens one overlong line instead of dropping everything after it', () => {
    const tree = `- main:\n  - paragraph: ${'terms '.repeat(3000)}\n  - textbox "Vendor" [ref=e5]`;
    write(workDir, 'test-results/e/error-context.md', `# Page snapshot\n\n\`\`\`yaml\n${tree}\n\`\`\`\n`);

    const snap = readPageSnapshot('Error Context: test-results/e/error-context.md', workDir)!;
    expect(snap).toContain('textbox "Vendor"');
    expect(snap.split('\n').every((l) => l.length <= 301)).toBe(true);
  });

  it('keeps one block per test: the last retry wins (CI=true retries)', () => {
    const ctx = (tree: string) => `# Test info\n\n- Name: expenses >> adds\n- Location: e2e/add.spec.ts:3:5\n\n# Page snapshot\n\n\`\`\`yaml\n${tree}\n\`\`\`\n`;
    write(workDir, 'test-results/add/error-context.md', ctx('- textbox "First"'));
    write(workDir, 'test-results/add-retry1/error-context.md', ctx('- textbox "Last"'));
    const output = 'Error Context: test-results/add/error-context.md\nError Context: test-results/add-retry1/error-context.md';

    expect(readPageSnapshot(output, workDir, 'e2e/add.spec.ts')).toBe('- textbox "Last"');
  });

  it("drops another spec's failure that the file filter also ran", () => {
    const ctx = (loc: string, tree: string) => `# Test info\n\n- Name: ${loc}\n- Location: e2e/${loc}:3:5\n\n# Page snapshot\n\n${tree}\n`;
    write(workDir, 'test-results/a/error-context.md', ctx('add.spec.ts', '- textbox "Mine"'));
    write(workDir, 'test-results/b/error-context.md', ctx('expenses-add.spec.ts', '- textbox "Other"'));
    const output = 'Error Context: test-results/a/error-context.md\nError Context: test-results/b/error-context.md';

    expect(readPageSnapshot(output, workDir, 'e2e/add.spec.ts')).toBe('- textbox "Mine"');
  });

  it('labels blocks by directory when error-context.md has no test name', () => {
    write(workDir, 'test-results/one/error-context.md', '# Page snapshot\n\n- textbox "A"\n');
    write(workDir, 'test-results/two/error-context.md', '# Page snapshot\n\n- textbox "B"\n');
    const output = 'Error Context: test-results/one/error-context.md\nError Context: test-results/two/error-context.md';

    expect(readPageSnapshot(output, workDir)).toBe('# one\n- textbox "A"\n\n# two\n- textbox "B"');
  });

  it('drops a same-named spec in another folder', () => {
    const ctx = (loc: string, tree: string) => `# Test info\n\n- Name: ${loc}\n- Location: ${loc}:3:5\n\n# Page snapshot\n\n${tree}\n`;
    write(workDir, 'test-results/a/error-context.md', ctx('e2e/a/add.spec.ts', '- textbox "Mine"'));
    write(workDir, 'test-results/b/error-context.md', ctx('e2e/b/add.spec.ts', '- textbox "Other"'));
    const output = 'Error Context: test-results/a/error-context.md\nError Context: test-results/b/error-context.md';

    expect(readPageSnapshot(output, workDir, 'e2e/a/add.spec.ts')).toBe('- textbox "Mine"');
  });

  it('ignores a "# Page snapshot" line quoted inside the error details', () => {
    const text =
      '# Error details\n\n```\nReceived: "x\n# Page snapshot\n- button \\"Fake\\""\n```\n\n# Page snapshot\n\n```yaml\n- textbox "Real"\n```\n';
    write(workDir, 'test-results/f/error-context.md', text);
    expect(readPageSnapshot('Error Context: test-results/f/error-context.md', workDir)).toBe('- textbox "Real"');
  });

  it('never ends a cut line on half an emoji', () => {
    const tree = `- paragraph: ${'x'.repeat(285)}${'🎉'.repeat(20)}\n- textbox "Vendor"`;
    write(workDir, 'test-results/g/error-context.md', `# Page snapshot\n\n${tree}\n`);
    const snap = readPageSnapshot('Error Context: test-results/g/error-context.md', workDir)!;
    expect(snap).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(snap).toContain('textbox "Vendor"');
  });

  it('keeps a usable tree per test even with very long test names', () => {
    const ctx = (name: string, tree: string) => `# Test info\n\n- Name: ${name}\n\n# Page snapshot\n\n${tree}\n`;
    const many = Array.from({ length: 200 }, (_, i) => `  - link "L${i}"`).join('\n');
    write(workDir, 'test-results/h1/error-context.md', ctx('a'.repeat(5000), `- main:\n  - textbox "One"\n${many}`));
    write(workDir, 'test-results/h2/error-context.md', ctx('b'.repeat(5000), `- main:\n  - textbox "Two"\n${many}`));
    const output = 'Error Context: test-results/h1/error-context.md\nError Context: test-results/h2/error-context.md';

    const snap = readPageSnapshot(output, workDir)!;
    expect(snap).toContain('textbox "One"');
    expect(snap).toContain('textbox "Two"');
    expect(snap.length).toBeLessThanOrEqual(8_000);
  });

  it('caps a very large snapshot', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `- listitem "row ${i}"`).join('\n');
    write(workDir, 'test-results/b/error-context.md', `# Page snapshot\n\n\`\`\`yaml\n${big}\n\`\`\`\n`);
    const snap = readPageSnapshot('Error Context: test-results/b/error-context.md', workDir)!;
    expect(snap.length).toBeLessThanOrEqual(8_000);
    expect(snap.endsWith('\n… (truncated)')).toBe(true);
    // Cut between lines, never inside one.
    expect(snap.split('\n').slice(0, -1).every((l) => /^- listitem "row \d+"$/.test(l))).toBe(true);
  });
});

describe('readPageSnapshot: project and navigation (GC-097, GC-098)', () => {
  let workDir: string;
  const context = (name: string, heading: string, source: string) =>
    `# Test info\n\n- Name: ${name}\n- Location: e2e/expenses.spec.ts:5:7\n\n# Page snapshot\n\n\`\`\`yaml\n- heading "${heading}" [level=1]\n\`\`\`\n\n# Test source\n\n\`\`\`ts\n${source}\n\`\`\`\n`;
  const write = (rel: string, body: string) => {
    const file = path.join(workDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const SOURCE = [
    "  5 |   await page.goto('/businesses/b1/expenses');",
    "  6 |   await page.goto('/businesses/b1/expenses/new');",
    "> 7 |   await expect(page.getByRole('heading')).toHaveText('New expense');",
    '    |                                           ^ Error: expect failed',
    "  8 |   await page.goto('/never-reached');",
  ].join('\n');

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc097-'));
  });
  afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

  it('keeps the page from every project when the same test fails in several', () => {
    write('test-results/expenses-adds-chromium/error-context.md', context('expenses.spec.ts >> adds', 'Chromium page', SOURCE));
    write('test-results/expenses-adds-firefox/error-context.md', context('expenses.spec.ts >> adds', 'Firefox page', SOURCE));
    const output =
      'Error Context: test-results/expenses-adds-chromium/error-context.md\nError Context: test-results/expenses-adds-firefox/error-context.md';

    const snapshot = readPageSnapshot(output, workDir)!;

    expect(snapshot).toContain('Chromium page');
    expect(snapshot).toContain('Firefox page');
    expect(snapshot).toContain('# expenses.spec.ts >> adds (expenses-adds-chromium)');
    expect(snapshot).toContain('# expenses.spec.ts >> adds (expenses-adds-firefox)');
  });

  it('still lets a retry replace the earlier attempt of the same test in the same project', () => {
    write('test-results/expenses-adds-chromium/error-context.md', context('expenses.spec.ts >> adds', 'First attempt', SOURCE));
    write('test-results/expenses-adds-chromium-retry1/error-context.md', context('expenses.spec.ts >> adds', 'Retry', SOURCE));
    const output =
      'Error Context: test-results/expenses-adds-chromium/error-context.md\nError Context: test-results/expenses-adds-chromium-retry1/error-context.md';

    const snapshot = readPageSnapshot(output, workDir)!;

    expect(snapshot).toContain('Retry');
    expect(snapshot).not.toContain('First attempt');
  });

  it('says which page the test last went to before the failing line', () => {
    write('test-results/expenses-adds-chromium/error-context.md', context('expenses.spec.ts >> adds', 'Not found', SOURCE));

    const snapshot = readPageSnapshot('Error Context: test-results/expenses-adds-chromium/error-context.md', workDir)!;

    expect(snapshot).toContain('Last page.goto in the test before the failing line: /businesses/b1/expenses/new');
    expect(snapshot).not.toContain('/never-reached');
    expect(snapshot).toContain('heading "Not found"');
  });

  it('sends one block when every project shows the same page', () => {
    write('test-results/expenses-adds-chromium/error-context.md', context('expenses.spec.ts >> adds', 'Same page', SOURCE));
    write('test-results/expenses-adds-firefox/error-context.md', context('expenses.spec.ts >> adds', 'Same page', SOURCE));
    const output =
      'Error Context: test-results/expenses-adds-chromium/error-context.md\nError Context: test-results/expenses-adds-firefox/error-context.md';

    const snapshot = readPageSnapshot(output, workDir)!;

    expect(snapshot.match(/Same page/g)).toHaveLength(1);
    expect(snapshot).not.toContain('# expenses.spec.ts');
  });

  it('keeps the project on the header when the test name is very long', () => {
    const long = `expenses.spec.ts >> ${'x'.repeat(300)}`;
    write('test-results/e-chromium/error-context.md', context(long, 'Chromium page', SOURCE));
    write('test-results/e-firefox/error-context.md', context(long, 'Firefox page', SOURCE));

    const snapshot = readPageSnapshot('Error Context: test-results/e-chromium/error-context.md\nError Context: test-results/e-firefox/error-context.md', workDir)!;

    expect(snapshot).toContain('(e-chromium)');
    expect(snapshot).toContain('(e-firefox)');
  });

  it('keeps the navigation line when the page is too large to send whole', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `- text "row ${i}"`).join('\n');
    write(
      'test-results/big-chromium/error-context.md',
      `# Test info\n\n- Name: big.spec.ts >> t\n\n# Page snapshot\n\n\`\`\`yaml\n- main:\n${big}\n\`\`\`\n\n# Test source\n\n\`\`\`ts\n${SOURCE}\n\`\`\`\n`,
    );

    const snapshot = readPageSnapshot('Error Context: test-results/big-chromium/error-context.md', workDir)!;

    expect(snapshot.length).toBeLessThanOrEqual(8000);
    expect(snapshot).toContain('Last page.goto in the test before the failing line: /businesses/b1/expenses/new (the app may have redirected since)');
  });

  it.each([
    [
      'a goto from an earlier test in the file',
      ["  2 | test('first', async ({ page }) => {", "  3 |   await page.goto('/first');", '  4 | });', "  5 | test('second', async ({ page }) => {", "> 6 |   await expect(page.locator('h1')).toBeVisible();"],
    ],
    ['the failing line itself', ["  2 | test('t', async ({ page }) => {", "> 3 |   await page.goto('/reports');"]],
    ['a commented-out goto', ["  2 | test('t', async ({ page }) => {", "  3 |   // await page.goto('/old');", "> 4 |   await expect(page.locator('h1')).toBeVisible();"]],
    ['a target built by concatenation', ["  2 | test('t', async ({ page }) => {", "  3 |   await page.goto('/businesses/' + id + '/new');", "> 4 |   await expect(page.locator('h1')).toBeVisible();"]],
    ['a template with a placeholder', ["  2 | test('t', async ({ page }) => {", '  3 |   await page.goto(`/businesses/${id}/new`);', "> 4 |   await expect(page.locator('h1')).toBeVisible();"]],
  ])('gives no navigation line for %s', (_name, source) => {
    write('test-results/n-chromium/error-context.md', context('n.spec.ts >> t', 'Home', source.join('\n')));
    expect(readPageSnapshot('Error Context: test-results/n-chromium/error-context.md', workDir)).toBe('- heading "Home" [level=1]');
  });

  it('adds no navigation line when the source shows none before the failure', () => {
    write(
      'test-results/x-chromium/error-context.md',
      context('x.spec.ts >> t', 'Home', "> 3 |   await expect(page.locator('h1')).toBeVisible();"),
    );
    expect(readPageSnapshot('Error Context: test-results/x-chromium/error-context.md', workDir)).toBe('- heading "Home" [level=1]');
  });
});
