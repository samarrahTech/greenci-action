/**
 * Static Cypress → Playwright conversion rules.
 * Applied before LLM refinement pass.
 */

interface ConversionRule {
  pattern: RegExp;
  replace: string | ((...args: string[]) => string);
  note?: string;
}

const CONVERSION_RULES: ConversionRule[] = [
  // Test structure
  { pattern: /\bdescribe\s*\(/g, replace: 'test.describe(' },
  { pattern: /\bit\s*\(/g, replace: 'test(' },
  { pattern: /\bbefore\s*\(\s*((?:async\s+)?function|\(|async\s*\()/g, replace: 'test.beforeAll($1' },
  { pattern: /\bbeforeEach\s*\(\s*((?:async\s+)?function|\(|async\s*\()/g, replace: 'test.beforeEach($1' },
  { pattern: /\bafter\s*\(\s*((?:async\s+)?function|\(|async\s*\()/g, replace: 'test.afterAll($1' },
  { pattern: /\bafterEach\s*\(\s*((?:async\s+)?function|\(|async\s*\()/g, replace: 'test.afterEach($1' },

  // Navigation
  { pattern: /cy\.visit\s*\(([^)]+)\)/g, replace: 'await page.goto($1)' },

  // Selectors - click
  { pattern: /cy\.get\s*\(([^)]+)\)\.click\s*\(\)/g, replace: 'await page.locator($1).click()' },

  // Selectors - type → fill
  { pattern: /cy\.get\s*\(([^)]+)\)\.type\s*\(([^)]+)\)/g, replace: 'await page.locator($1).fill($2)' },

  // Selectors - clear
  { pattern: /cy\.get\s*\(([^)]+)\)\.clear\s*\(\)/g, replace: 'await page.locator($1).clear()' },

  // Assertions - should('be.visible')
  { pattern: /cy\.get\s*\(([^)]+)\)\.should\s*\(\s*['"`]be\.visible['"`]\s*\)/g, replace: 'await expect(page.locator($1)).toBeVisible()' },

  // Assertions - should('not.be.visible')
  { pattern: /cy\.get\s*\(([^)]+)\)\.should\s*\(\s*['"`]not\.be\.visible['"`]\s*\)/g, replace: 'await expect(page.locator($1)).not.toBeVisible()' },

  // Assertions - should('exist')
  { pattern: /cy\.get\s*\(([^)]+)\)\.should\s*\(\s*['"`]exist['"`]\s*\)/g, replace: 'await expect(page.locator($1)).toBeAttached()' },

  // Assertions - should('not.exist')
  { pattern: /cy\.get\s*\(([^)]+)\)\.should\s*\(\s*['"`]not\.exist['"`]\s*\)/g, replace: 'await expect(page.locator($1)).not.toBeAttached()' },

  // Assertions - should('have.text', 'x')
  { pattern: /cy\.get\s*\(([^)]+)\)\.should\s*\(\s*['"`]have\.text['"`]\s*,\s*([^)]+)\)/g, replace: 'await expect(page.locator($1)).toHaveText($2)' },

  // Assertions - should('contain', 'x')
  { pattern: /cy\.get\s*\(([^)]+)\)\.should\s*\(\s*['"`]contain['"`]\s*,\s*([^)]+)\)/g, replace: 'await expect(page.locator($1)).toContainText($2)' },

  // Assertions - should('have.value', 'x')
  { pattern: /cy\.get\s*\(([^)]+)\)\.should\s*\(\s*['"`]have\.value['"`]\s*,\s*([^)]+)\)/g, replace: 'await expect(page.locator($1)).toHaveValue($2)' },

  // Assertions - should('have.length', n)
  { pattern: /cy\.get\s*\(([^)]+)\)\.should\s*\(\s*['"`]have\.length['"`]\s*,\s*([^)]+)\)/g, replace: 'await expect(page.locator($1)).toHaveCount($2)' },

  // Assertions - should('be.disabled')
  { pattern: /cy\.get\s*\(([^)]+)\)\.should\s*\(\s*['"`]be\.disabled['"`]\s*\)/g, replace: 'await expect(page.locator($1)).toBeDisabled()' },

  // Assertions - should('be.enabled')
  { pattern: /cy\.get\s*\(([^)]+)\)\.should\s*\(\s*['"`]be\.enabled['"`]\s*\)/g, replace: 'await expect(page.locator($1)).toBeEnabled()' },

  // Assertions - should('be.checked')
  { pattern: /cy\.get\s*\(([^)]+)\)\.should\s*\(\s*['"`]be\.checked['"`]\s*\)/g, replace: 'await expect(page.locator($1)).toBeChecked()' },

  // Assertions - should('have.attr', 'x', 'y')
  { pattern: /cy\.get\s*\(([^)]+)\)\.should\s*\(\s*['"`]have\.attr['"`]\s*,\s*([^,)]+),\s*([^)]+)\)/g, replace: 'await expect(page.locator($1)).toHaveAttribute($2, $3)' },

  // cy.contains
  { pattern: /cy\.contains\s*\(([^)]+)\)\.click\s*\(\)/g, replace: 'await page.getByText($1).click()' },
  { pattern: /cy\.contains\s*\(([^)]+)\)/g, replace: 'page.getByText($1)' },

  // cy.get (generic - must come after more specific patterns)
  { pattern: /cy\.get\s*\(([^)]+)\)/g, replace: 'page.locator($1)' },

  // URL assertions
  {
    pattern: /cy\.url\s*\(\)\.should\s*\(\s*['"`]include['"`]\s*,\s*['"`]([^'"`]+)['"`]\s*\)/g,
    replace: (_match: string, p: string) => {
      const escaped = p.replace(/\//g, '\\/');
      return `await expect(page).toHaveURL(/${escaped}/)`;
    },
  },

  // cy.screenshot
  { pattern: /cy\.screenshot\s*\(\)/g, replace: 'await page.screenshot()' },
  { pattern: /cy\.screenshot\s*\(([^)]+)\)/g, replace: 'await page.screenshot({ path: $1 })' },

  // cy.wait with alias
  { pattern: /cy\.wait\s*\(\s*['"`]@([^'"`]+)['"`]\s*\)/g, replace: "// TODO: Replace with appropriate waitForResponse for alias '$1'" },

  // cy.wait with number (timeout)
  { pattern: /cy\.wait\s*\(\s*(\d+)\s*\)/g, replace: 'await page.waitForTimeout($1)' },

  // Viewport
  { pattern: /cy\.viewport\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g, replace: 'test.use({ viewport: { width: $1, height: $2 } })' },

  // Env vars
  { pattern: /Cypress\.env\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, replace: "process.env['$1']" },

  // cy.fixture
  { pattern: /cy\.fixture\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, replace: "// TODO: Load fixture '$1' - use JSON.parse(fs.readFileSync('fixtures/$1.json', 'utf-8'))" },

  // Intercept with alias
  { pattern: /cy\.intercept\s*\(\s*['"`](\w+)['"`]\s*,\s*(['"`][^'"`]+['"`])\s*\)\.as\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, replace: "await page.route($2, route => route.fulfill()) // alias: '$3', method: $1" },

  // Simple intercept
  { pattern: /cy\.intercept\s*\(\s*(['"`][^'"`]+['"`])\s*\)/g, replace: 'await page.route($1, route => route.fulfill())' },

  // cy.request
  { pattern: /cy\.request\s*\(\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]\s*,\s*([^)]+)\)/g, replace: 'await request.$1($2)' },
  { pattern: /cy\.request\s*\(\s*([^)]+)\)/g, replace: 'await request.get($1)' },
];

export function convertCypressToPlaywright(source: string): { code: string; notes: string[]; confidence: number } {
  const notes: string[] = [];
  let code = source;
  let rulesApplied = 0;
  let totalCypressPatterns = 0;

  // Count total Cypress patterns for confidence scoring
  const cypressPatternCount = (code.match(/cy\.\w+/g) || []).length;
  const cypressEnvCount = (code.match(/Cypress\.env/g) || []).length;
  totalCypressPatterns = cypressPatternCount + cypressEnvCount;

  // Apply conversion rules
  for (const rule of CONVERSION_RULES) {
    const matches = code.match(rule.pattern);
    if (matches) {
      rulesApplied += matches.length;
      code = code.replace(rule.pattern, rule.replace as any);
      if (rule.note) {
        notes.push(rule.note);
      }
    }
  }

  // Fix request method casing from cy.request conversion
  code = code.replace(/await request\.(GET|POST|PUT|DELETE|PATCH)\(/g, (_, method: string) => {
    return `await request.${method.toLowerCase()}(`;
  });

  // Check for remaining unconverted patterns
  const remainingCy = (code.match(/cy\.\w+/g) || []);
  const remainingCypressEnv = (code.match(/Cypress\.\w+/g) || []);
  if (remainingCy.length > 0) {
    notes.push(`Unconverted Cypress commands: ${[...new Set(remainingCy)].join(', ')}`);
  }
  if (remainingCypressEnv.length > 0) {
    notes.push(`Unconverted Cypress globals: ${[...new Set(remainingCypressEnv)].join(', ')}`);
  }

  // Check for TODOs we added
  const todoCount = (code.match(/\/\/ TODO:/g) || []).length;
  if (todoCount > 0) {
    notes.push(`${todoCount} item(s) need manual review (marked with TODO)`);
  }

  // Add Playwright imports
  code = addPlaywrightImports(code);

  // Calculate confidence
  const unconvertedCount = remainingCy.length + remainingCypressEnv.length;
  let confidence = totalCypressPatterns > 0
    ? Math.max(0.1, 1 - (unconvertedCount + todoCount) / totalCypressPatterns)
    : 0.9;
  confidence = Math.round(confidence * 100) / 100;

  return { code, notes, confidence };
}

function addPlaywrightImports(code: string): string {
  const hasExpect = code.includes('expect(');
  const hasTest = code.includes('test(') || code.includes('test.describe(');

  const imports: string[] = [];
  if (hasTest) imports.push('test');
  if (hasExpect) imports.push('expect');

  if (imports.length === 0) {
    imports.push('test', 'expect');
  }

  const importLine = `import { ${imports.join(', ')} } from '@playwright/test';\n\n`;

  // Remove existing Cypress-related imports
  code = code.replace(/^import\s+.*['"]cypress.*['"].*\n?/gm, '');

  return importLine + code;
}
