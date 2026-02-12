import * as fs from 'fs';
import * as path from 'path';
import { CypressFileInfo, CypressTestBlock } from './types';

const CYPRESS_FILE_PATTERNS = [/\.cy\.[tj]sx?$/, /\.spec\.[tj]sx?$/];

export function scanCypressDirectory(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (CYPRESS_FILE_PATTERNS.some((p) => p.test(entry.name))) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files.sort();
}

export function parseCypressFile(filePath: string): CypressFileInfo {
  const rawSource = fs.readFileSync(filePath, 'utf-8');
  return parseCypressSource(filePath, rawSource);
}

export function parseCypressSource(filePath: string, rawSource: string): CypressFileInfo {
  const commands = extractCommands(rawSource);
  const testBlocks = extractTestBlocks(rawSource);
  const customCommands = extractCustomCommands(rawSource);
  const fixtures = extractFixtures(rawSource);
  const aliases = extractAliases(rawSource);
  const envVars = extractEnvVars(rawSource);

  return {
    filePath,
    commands,
    testBlocks,
    customCommands,
    fixtures,
    aliases,
    envVars,
    rawSource,
  };
}

function extractCommands(source: string): string[] {
  const commandPattern = /cy\.(\w+)/g;
  const commands = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = commandPattern.exec(source)) !== null) {
    commands.add(`cy.${match[1]}`);
  }
  return Array.from(commands).sort();
}

function extractTestBlocks(source: string): CypressTestBlock[] {
  const blocks: CypressTestBlock[] = [];
  const blockPattern = /\b(describe|it|before|beforeEach|after|afterEach)\s*\(\s*(?:['"`]([^'"`]*)['"`]\s*,\s*)?/g;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(source)) !== null) {
    blocks.push({
      type: match[1] as CypressTestBlock['type'],
      title: match[2] || undefined,
      body: '',
    });
  }

  return blocks;
}

function extractCustomCommands(source: string): string[] {
  const customPattern = /Cypress\.Commands\.add\s*\(\s*['"`](\w+)['"`]/g;
  const chainPattern = /cy\.(\w+)\s*\(/g;
  const builtinCommands = new Set([
    'get', 'visit', 'click', 'type', 'contains', 'intercept', 'wait',
    'request', 'fixture', 'url', 'location', 'title', 'window', 'document',
    'should', 'and', 'then', 'wrap', 'its', 'invoke', 'as', 'find',
    'within', 'parent', 'parents', 'children', 'siblings', 'first', 'last',
    'eq', 'filter', 'not', 'each', 'scrollIntoView', 'scrollTo', 'trigger',
    'focus', 'blur', 'clear', 'check', 'uncheck', 'select', 'screenshot',
    'viewport', 'clearCookie', 'clearCookies', 'clearLocalStorage', 'getCookie',
    'getCookies', 'setCookie', 'log', 'debug', 'pause', 'exec', 'task',
    'readFile', 'writeFile', 'stub', 'spy', 'clock', 'tick', 'go', 'reload',
    'hash', 'on', 'once', 'off', 'root', 'end',
  ]);

  const custom = new Set<string>();

  // Explicit Cypress.Commands.add
  let match: RegExpExecArray | null;
  while ((match = customPattern.exec(source)) !== null) {
    custom.add(match[1]);
  }

  // Any cy.xxx that's not a builtin
  while ((match = chainPattern.exec(source)) !== null) {
    if (!builtinCommands.has(match[1])) {
      custom.add(match[1]);
    }
  }

  return Array.from(custom).sort();
}

function extractFixtures(source: string): string[] {
  const fixturePattern = /cy\.fixture\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const fixtures: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fixturePattern.exec(source)) !== null) {
    fixtures.push(match[1]);
  }
  return fixtures;
}

function extractAliases(source: string): string[] {
  const aliasPattern = /\.as\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const aliases: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = aliasPattern.exec(source)) !== null) {
    aliases.push(match[1]);
  }
  return aliases;
}

function extractEnvVars(source: string): string[] {
  const envPattern = /Cypress\.env\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const envVars: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = envPattern.exec(source)) !== null) {
    envVars.push(match[1]);
  }
  return envVars;
}
