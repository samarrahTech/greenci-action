import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseCypressSource, scanCypressDirectory } from '../src/cypress-parser';

describe('scanCypressDirectory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cypress-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('finds .cy.ts and .cy.js files', () => {
    fs.writeFileSync(path.join(tmpDir, 'login.cy.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'signup.cy.js'), '');
    fs.writeFileSync(path.join(tmpDir, 'utils.ts'), ''); // should be excluded

    const files = scanCypressDirectory(tmpDir);
    expect(files).toHaveLength(2);
    expect(files[0]).toContain('login.cy.ts');
    expect(files[1]).toContain('signup.cy.js');
  });

  test('finds .spec.ts and .spec.js files', () => {
    fs.writeFileSync(path.join(tmpDir, 'auth.spec.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'home.spec.js'), '');

    const files = scanCypressDirectory(tmpDir);
    expect(files).toHaveLength(2);
  });

  test('finds files in subdirectories', () => {
    const subDir = path.join(tmpDir, 'auth');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'login.cy.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'home.cy.ts'), '');

    const files = scanCypressDirectory(tmpDir);
    expect(files).toHaveLength(2);
  });

  test('returns empty array for non-existent directory', () => {
    const files = scanCypressDirectory('/non/existent/path');
    expect(files).toHaveLength(0);
  });
});

describe('parseCypressSource', () => {
  test('extracts Cypress commands', () => {
    const source = `
      cy.visit('/login');
      cy.get('#email').type('test@test.com');
      cy.get('#password').type('secret');
      cy.get('button').click();
      cy.contains('Welcome');
    `;

    const result = parseCypressSource('test.cy.ts', source);
    expect(result.commands).toContain('cy.visit');
    expect(result.commands).toContain('cy.get');
    expect(result.commands).toContain('cy.contains');
  });

  test('extracts test blocks', () => {
    const source = `
      describe('Login', () => {
        beforeEach(() => {
          cy.visit('/login');
        });

        it('should login successfully', () => {
          cy.get('#email').type('test@test.com');
        });

        it('should show error for invalid credentials', () => {
          cy.get('#email').type('bad@test.com');
        });
      });
    `;

    const result = parseCypressSource('test.cy.ts', source);
    expect(result.testBlocks).toHaveLength(4);
    expect(result.testBlocks[0].type).toBe('describe');
    expect(result.testBlocks[0].title).toBe('Login');
    expect(result.testBlocks[1].type).toBe('beforeEach');
    expect(result.testBlocks[2].type).toBe('it');
    expect(result.testBlocks[2].title).toBe('should login successfully');
    expect(result.testBlocks[3].type).toBe('it');
  });

  test('extracts fixtures', () => {
    const source = `
      cy.fixture('users').then((users) => {
        cy.get('#email').type(users.admin.email);
      });
      cy.fixture('products');
    `;

    const result = parseCypressSource('test.cy.ts', source);
    expect(result.fixtures).toEqual(['users', 'products']);
  });

  test('extracts aliases', () => {
    const source = `
      cy.intercept('GET', '/api/users').as('getUsers');
      cy.get('#submit').as('submitBtn');
    `;

    const result = parseCypressSource('test.cy.ts', source);
    expect(result.aliases).toEqual(['getUsers', 'submitBtn']);
  });

  test('extracts environment variables', () => {
    const source = `
      const apiUrl = Cypress.env('API_URL');
      cy.visit(Cypress.env('BASE_URL'));
    `;

    const result = parseCypressSource('test.cy.ts', source);
    expect(result.envVars).toEqual(['API_URL', 'BASE_URL']);
  });

  test('detects custom commands', () => {
    const source = `
      cy.login('admin', 'password');
      cy.get('#dashboard').should('be.visible');
      cy.dataCy('submit-button').click();
    `;

    const result = parseCypressSource('test.cy.ts', source);
    expect(result.customCommands).toContain('login');
    expect(result.customCommands).toContain('dataCy');
    expect(result.customCommands).not.toContain('get');
    expect(result.customCommands).not.toContain('should');
  });

  test('stores raw source', () => {
    const source = 'cy.visit("/");';
    const result = parseCypressSource('test.cy.ts', source);
    expect(result.rawSource).toBe(source);
  });
});
