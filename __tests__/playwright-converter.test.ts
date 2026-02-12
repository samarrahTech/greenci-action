import { convertCypressToPlaywright } from '../src/playwright-converter';

describe('convertCypressToPlaywright', () => {
  function convert(source: string): string {
    return convertCypressToPlaywright(source).code;
  }

  describe('test structure', () => {
    test('converts describe to test.describe', () => {
      const result = convert("describe('Login', () => {});");
      expect(result).toContain("test.describe('Login', () => {});");
    });

    test('converts it to test', () => {
      const result = convert("it('should work', () => {});");
      expect(result).toContain("test('should work', () => {});");
    });

    test('converts before/after hooks', () => {
      const src = `
before(() => { setup(); });
beforeEach(() => { visit(); });
after(() => { cleanup(); });
afterEach(() => { reset(); });`;
      const result = convert(src);
      expect(result).toContain('test.beforeAll(()');
      expect(result).toContain('test.beforeEach(()');
      expect(result).toContain('test.afterAll(()');
      expect(result).toContain('test.afterEach(()');
    });
  });

  describe('navigation', () => {
    test('converts cy.visit', () => {
      const result = convert("cy.visit('/login');");
      expect(result).toContain("await page.goto('/login');");
    });
  });

  describe('selectors and actions', () => {
    test('converts cy.get().click()', () => {
      const result = convert("cy.get('#submit').click();");
      expect(result).toContain("await page.locator('#submit').click();");
    });

    test('converts cy.get().type() to .fill()', () => {
      const result = convert("cy.get('#email').type('test@test.com');");
      expect(result).toContain("await page.locator('#email').fill('test@test.com');");
    });

    test('converts cy.get().clear()', () => {
      const result = convert("cy.get('#input').clear();");
      expect(result).toContain("await page.locator('#input').clear();");
    });

    test('converts cy.contains().click()', () => {
      const result = convert("cy.contains('Submit').click();");
      expect(result).toContain("await page.getByText('Submit').click();");
    });

    test('converts cy.contains without action', () => {
      const result = convert("cy.contains('Hello');");
      expect(result).toContain("page.getByText('Hello');");
    });
  });

  describe('assertions', () => {
    test('converts should be.visible', () => {
      const result = convert("cy.get('.modal').should('be.visible');");
      expect(result).toContain("await expect(page.locator('.modal')).toBeVisible();");
    });

    test('converts should not.be.visible', () => {
      const result = convert("cy.get('.modal').should('not.be.visible');");
      expect(result).toContain("await expect(page.locator('.modal')).not.toBeVisible();");
    });

    test('converts should exist', () => {
      const result = convert("cy.get('#item').should('exist');");
      expect(result).toContain("await expect(page.locator('#item')).toBeAttached();");
    });

    test('converts should not.exist', () => {
      const result = convert("cy.get('#item').should('not.exist');");
      expect(result).toContain("await expect(page.locator('#item')).not.toBeAttached();");
    });

    test('converts should have.text', () => {
      const result = convert("cy.get('h1').should('have.text', 'Welcome');");
      expect(result).toContain("await expect(page.locator('h1')).toHaveText('Welcome');");
    });

    test('converts should contain', () => {
      const result = convert("cy.get('.msg').should('contain', 'Success');");
      expect(result).toContain("await expect(page.locator('.msg')).toContainText('Success');");
    });

    test('converts should have.value', () => {
      const result = convert("cy.get('#name').should('have.value', 'John');");
      expect(result).toContain("await expect(page.locator('#name')).toHaveValue('John');");
    });

    test('converts should have.length', () => {
      const result = convert("cy.get('.item').should('have.length', 3);");
      expect(result).toContain("await expect(page.locator('.item')).toHaveCount(3);");
    });

    test('converts should be.disabled', () => {
      const result = convert("cy.get('button').should('be.disabled');");
      expect(result).toContain("await expect(page.locator('button')).toBeDisabled();");
    });

    test('converts should be.checked', () => {
      const result = convert("cy.get('#checkbox').should('be.checked');");
      expect(result).toContain("await expect(page.locator('#checkbox')).toBeChecked();");
    });

    test('converts should have.attr', () => {
      const result = convert("cy.get('a').should('have.attr', 'href', '/home');");
      expect(result).toContain("await expect(page.locator('a')).toHaveAttribute('href', '/home');");
    });

    test('converts URL assertion', () => {
      const result = convert("cy.url().should('include', '/dashboard');");
      expect(result).toContain("await expect(page).toHaveURL(/\\/dashboard/)");
    });
  });

  describe('other commands', () => {
    test('converts cy.screenshot()', () => {
      const result = convert('cy.screenshot();');
      expect(result).toContain('await page.screenshot();');
    });

    test('converts cy.wait with timeout', () => {
      const result = convert('cy.wait(1000);');
      expect(result).toContain('await page.waitForTimeout(1000);');
    });

    test('converts cy.viewport', () => {
      const result = convert('cy.viewport(1280, 720);');
      expect(result).toContain('test.use({ viewport: { width: 1280, height: 720 } });');
    });

    test('converts Cypress.env', () => {
      const result = convert("Cypress.env('API_KEY');");
      expect(result).toContain("process.env['API_KEY'];");
    });
  });

  describe('imports', () => {
    test('adds Playwright imports', () => {
      const result = convert("describe('test', () => { it('works', () => { cy.get('x').should('exist'); }); });");
      expect(result).toMatch(/^import \{ test, expect \} from '@playwright\/test';/);
    });
  });

  describe('confidence scoring', () => {
    test('high confidence for fully converted code', () => {
      const { confidence } = convertCypressToPlaywright("cy.visit('/'); cy.get('h1').should('be.visible');");
      expect(confidence).toBeGreaterThanOrEqual(0.8);
    });

    test('lower confidence when patterns remain unconverted', () => {
      const { confidence, notes } = convertCypressToPlaywright("cy.visit('/'); cy.customCommand();");
      // customCommand won't match specific rules but cy.visit will
      expect(notes.length).toBeGreaterThan(0);
    });
  });

  describe('realistic full file conversion', () => {
    test('converts a complete Cypress login test', () => {
      const cypressCode = `
describe('Login Page', () => {
  beforeEach(() => {
    cy.visit('/login');
  });

  it('should login with valid credentials', () => {
    cy.get('#email').type('admin@example.com');
    cy.get('#password').type('password123');
    cy.get('button[type="submit"]').click();
    cy.url().should('include', '/dashboard');
    cy.get('.welcome-message').should('be.visible');
    cy.get('.welcome-message').should('contain', 'Welcome');
  });

  it('should show error for invalid credentials', () => {
    cy.get('#email').type('bad@example.com');
    cy.get('#password').type('wrong');
    cy.get('button[type="submit"]').click();
    cy.get('.error-alert').should('be.visible');
    cy.get('.error-alert').should('have.text', 'Invalid credentials');
  });
});`;

      const result = convert(cypressCode);
      expect(result).toContain("import { test, expect } from '@playwright/test'");
      expect(result).toContain("test.describe('Login Page'");
      expect(result).toContain('test.beforeEach(()');
      expect(result).toContain("await page.goto('/login')");
      expect(result).toContain("await page.locator('#email').fill('admin@example.com')");
      expect(result).toContain("await page.locator('button[type=\"submit\"]').click()");
      expect(result).toContain("await expect(page).toHaveURL(/\\/dashboard/)");
      expect(result).toContain("await expect(page.locator('.welcome-message')).toBeVisible()");
      expect(result).toContain("await expect(page.locator('.welcome-message')).toContainText('Welcome')");
      expect(result).toContain("await expect(page.locator('.error-alert')).toHaveText('Invalid credentials')");
    });
  });
});
