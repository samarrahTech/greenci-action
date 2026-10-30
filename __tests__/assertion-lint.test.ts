import { lintAssertions } from '../src/assertion-lint';

const wrap = (body: string) => `import { test, expect } from '@playwright/test';

test('journey', async ({ page }) => {
  await page.goto('/');
${body}
});
`;

describe('lintAssertions — rejects tautologies', () => {
  it('rejects a test with no expect at all', () => {
    const r = lintAssertions(wrap(`  await page.getByRole('button', { name: 'Save' }).click();`));
    expect(r.ok).toBe(false);
    expect(r.total).toBe(0);
    expect(r.reason).toMatch(/no expect\(\)/);
  });

  it('rejects toHaveURL(/.*/) — the dogfood case', () => {
    const r = lintAssertions(wrap(`  await expect(page).toHaveURL(/.*/);`));
    expect(r.ok).toBe(false);
    expect(r.vacuous).toHaveLength(1);
    expect(r.vacuous[0].reason).toMatch(/matches any value/);
  });

  it('rejects toHaveURL(/.*/) plus body-visible together', () => {
    const r = lintAssertions(
      wrap(`  await expect(page).toHaveURL(/.*/);
  await expect(page.locator('body')).toBeVisible();`)
    );
    expect(r.ok).toBe(false);
    expect(r.total).toBe(2);
    expect(r.vacuous.map((v) => v.reason)).toEqual([
      expect.stringMatching(/matches any value/),
      'the document root is always rendered',
    ]);
  });

  it.each([
    ['/^.*$/', 'anchored dot-star'],
    ['/[\\s\\S]*/', 'any-char class'],
    ['/\\/?/', 'optional slash'],
    ['/./', 'single dot against a URL'],
    ['/.+/i', 'dot-plus with flags'],
  ])('rejects toHaveURL(%s) (%s)', (pattern) => {
    const r = lintAssertions(wrap(`  await expect(page).toHaveURL(${pattern});`));
    expect(r.ok).toBe(false);
  });

  it('rejects substring matchers fed an empty string or match-all regex', () => {
    for (const line of [
      `await expect(page.locator('h1')).toContainText('');`,
      `expect(await page.title()).toContain("");`,
      `expect(await page.textContent('body')).toMatch(/.*/);`,
      `await expect(page.locator('main')).toHaveText(/[\\s\\S]*/);`,
    ]) {
      expect(lintAssertions(wrap(`  ${line}`)).ok).toBe(false);
    }
  });

  it('rejects constants and always-defined fixtures', () => {
    for (const line of [
      `expect(true).toBe(true);`,
      `expect(1).toBe(1);`,
      `expect(page).toBeDefined();`,
      `expect(page.url()).toBeTruthy();`,
      `expect(page.locator('.row')).toBeDefined();`,
      `expect(page.getByRole('heading')).not.toBeNull();`,
      `expect(page.locator('li').first()).toBeTruthy();`,
    ]) {
      const r = lintAssertions(wrap(`  ${line}`));
      expect(r.ok).toBe(false);
    }
  });

  it('rejects expect.soft tautologies too', () => {
    const r = lintAssertions(wrap(`  await expect.soft(page).toHaveURL(/.*/);`));
    expect(r.ok).toBe(false);
  });

  it('ignores commented-out assertions', () => {
    const r = lintAssertions(
      wrap(`  // await expect(page.getByText('Saved')).toBeVisible();
  /* await expect(page).toHaveTitle('Dashboard'); */
  await page.click('text=Save');`)
    );
    expect(r.ok).toBe(false);
    expect(r.total).toBe(0);
  });
});

describe('lintAssertions — accepts real assertions', () => {
  it.each([
    [`await expect(page).toHaveURL(/\\/dashboard/);`],
    [`await expect(page).toHaveURL('/expenses');`],
    [`await expect(page.getByRole('heading', { name: 'Expenses' })).toBeVisible();`],
    [`await expect(page.getByText('Lunch — $12.00')).toBeVisible();`],
    [`await expect(page.locator('tbody tr')).toHaveCount(3);`],
    [`await expect(page.locator('h1')).toHaveText('');`],
    [`await expect(page.locator('input[name="email"]')).toHaveValue('a@b.co');`],
    [`expect(await page.title()).toContain('Dashboard');`],
    [`expect(response.status()).toBe(200);`],
    [`await expect(page.locator('body')).toContainText('Welcome back');`],
    [`await expect(page.locator('body')).not.toContainText('Error');`],
    [`await expect(page.getByTestId('toast')).toBeHidden();`],
    [`await expect.poll(async () => (await page.locator('.item').count())).toBeGreaterThan(0);`],
    [`await expect(async () => { await page.reload(); }).toPass();`],
  ])('accepts %s', (line) => {
    const r = lintAssertions(wrap(`  ${line}`));
    expect(r.ok).toBe(true);
    expect(r.vacuous).toHaveLength(0);
  });

  it('accepts a file that mixes one real assertion with vacuous ones, reporting the vacuous', () => {
    const r = lintAssertions(
      wrap(`  await expect(page).toHaveURL(/.*/);
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();`)
    );
    expect(r.ok).toBe(true);
    expect(r.total).toBe(2);
    expect(r.vacuous).toHaveLength(1);
  });

  it('handles strings containing parentheses and regex with slashes inside arguments', () => {
    const r = lintAssertions(
      wrap(`  await expect(page.getByText('Total (incl. VAT)')).toBeVisible();
  await expect(page).toHaveURL(/\\/orders\\/\\d+\\/confirm/);`)
    );
    expect(r.ok).toBe(true);
    expect(r.total).toBe(2);
  });

  it('does not count an unfinished chain as vacuous', () => {
    // Weird but possible model output; Playwright will complain, not us.
    const r = lintAssertions(
      wrap(`  const e = expect(page.locator('h1'));\n  await e.toBeVisible();`)
    );
    expect(r.ok).toBe(true);
  });
});

describe('lintAssertions — review regressions', () => {
  // GC-055: awaited query results are real values, not locator handles.
  it.each([
    [`expect(await page.locator('h1').textContent()).toBeTruthy();`],
    [`expect(await page.getByRole('link').getAttribute('href')).not.toBeNull();`],
    [`expect(await page.locator('.row').count()).toBeTruthy();`],
    [`expect(await page.locator('.row').count()).toBeGreaterThan(0);`],
  ])('keeps %s', (line) => {
    expect(lintAssertions(wrap(`  ${line}`)).ok).toBe(true);
  });

  // GC-056: a constant subject with a dynamic expectation is backwards but real.
  it.each([
    [`expect(200).toBe(response.status());`],
    ["expect(`${total}`).toBe('3');"],
    [`expect('Dashboard').toBe(await page.title());`],
  ])('keeps %s', (line) => {
    expect(lintAssertions(wrap(`  ${line}`)).ok).toBe(true);
  });

  it('still rejects a literal against a literal', () => {
    expect(lintAssertions(wrap("  expect('a').toBe('a');")).ok).toBe(false);
    expect(lintAssertions(wrap('  expect(`a`).toBeDefined();')).ok).toBe(false);
  });

  // GC-057: scheme/host checks are real URL assertions.
  it.each([[`/^https?:\\/\\//`], [`/localhost/`], [`/^http/`]])(
    'keeps toHaveURL(%s)',
    (pattern) => {
      expect(lintAssertions(wrap(`  await expect(page).toHaveURL(${pattern});`)).ok).toBe(true);
    }
  );

  // GC-060: g/y flags must not make the probe loop stateful.
  it.each([[`/.+/g`], [`/.*/y`], [`/./gi`]])('rejects toHaveURL(%s)', (pattern) => {
    expect(lintAssertions(wrap(`  await expect(page).toHaveURL(${pattern});`)).ok).toBe(false);
  });

  // GC-060: expect( inside a string is not an assertion.
  it('does not count expect( inside string literals', () => {
    const r = lintAssertions(
      wrap(`  await page.fill('#q', 'expect(x)');\n  await page.fill('#r', "expect.soft(y)");`)
    );
    expect(r.ok).toBe(false);
    expect(r.total).toBe(0);
  });

  it('handles a long file without quadratic blow-up', () => {
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `  await expect(page.getByTestId('row-${i}')).toBeVisible();`
    ).join('\n');
    const started = Date.now();
    const r = lintAssertions(wrap(lines));
    expect(r.ok).toBe(true);
    expect(r.total).toBe(2000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
