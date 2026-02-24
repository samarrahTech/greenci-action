import * as core from '@actions/core';
import { runMigration } from '../src/migrator';
import { ActionConfig, ILLMClient } from '../src/types';
import * as cypressParser from '../src/cypress-parser';
import * as playwrightConverter from '../src/playwright-converter';

jest.mock('@actions/core');
jest.mock('../src/cypress-parser');
jest.mock('../src/playwright-converter');

const mockMkdirSync = jest.fn();
const mockWriteFileSync = jest.fn();
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    mkdirSync: (...args: any[]) => mockMkdirSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  };
});

const mockConfig: ActionConfig = {
  apiKey: 'mock-key',
  llmProvider: 'greenci',
  llmModel: '',
  awsRegion: 'us-east-1',
  testDir: 'e2e',
  baseUrl: 'http://localhost:3000',
  maxRetries: 2,
  autoCommit: true,
  greenCIApiUrl: 'https://api.greenci.ai',
  mode: 'migrate',
  cypressDir: 'cypress/e2e',
};

const mockLLMClient: ILLMClient = {
  generateTests: jest.fn(),
  healTest: jest.fn(),
  migrateTest: jest.fn().mockResolvedValue('refined code'),
};

describe('runMigration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return empty report when no cypress files found', async () => {
    (cypressParser.scanCypressDirectory as jest.Mock).mockReturnValue([]);
    const report = await runMigration(mockConfig, mockLLMClient, '/work');
    expect(report.totalFiles).toBe(0);
    expect(report.converted).toBe(0);
  });

  it('should convert files and return report', async () => {
    (cypressParser.scanCypressDirectory as jest.Mock).mockReturnValue(['/work/cypress/e2e/login.cy.ts']);
    (cypressParser.parseCypressFile as jest.Mock).mockReturnValue({
      filePath: '/work/cypress/e2e/login.cy.ts',
      rawSource: 'cy.visit("/")',
      commands: [], testBlocks: [], customCommands: [], fixtures: [], aliases: [], envVars: [],
    });
    (playwrightConverter.convertCypressToPlaywright as jest.Mock).mockReturnValue({
      code: 'static converted code', notes: [], confidence: 0.8,
    });

    const report = await runMigration(mockConfig, mockLLMClient, '/work');
    expect(report.totalFiles).toBe(1);
    expect(report.converted).toBe(1);
    expect(mockLLMClient.migrateTest).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('should mark low-confidence files as needs-review', async () => {
    (cypressParser.scanCypressDirectory as jest.Mock).mockReturnValue(['/work/cypress/e2e/complex.cy.ts']);
    (cypressParser.parseCypressFile as jest.Mock).mockReturnValue({
      filePath: '/work/cypress/e2e/complex.cy.ts',
      rawSource: 'cy.custom()',
      commands: [], testBlocks: [], customCommands: [], fixtures: [], aliases: [], envVars: [],
    });
    (playwrightConverter.convertCypressToPlaywright as jest.Mock).mockReturnValue({
      code: '// TODO: unconverted', notes: ['Unconverted command'], confidence: 0.3,
    });
    (mockLLMClient.migrateTest as jest.Mock).mockResolvedValue('');

    const report = await runMigration(mockConfig, mockLLMClient, '/work');
    expect(report.needsReview).toBe(1);
  });

  it('should handle conversion errors gracefully', async () => {
    (cypressParser.scanCypressDirectory as jest.Mock).mockReturnValue(['/work/cypress/e2e/broken.cy.ts']);
    (cypressParser.parseCypressFile as jest.Mock).mockImplementation(() => { throw new Error('Parse error'); });

    const report = await runMigration(mockConfig, mockLLMClient, '/work');
    expect(report.failed).toBe(1);
  });

  it('should continue when LLM refinement fails', async () => {
    (cypressParser.scanCypressDirectory as jest.Mock).mockReturnValue(['/work/cypress/e2e/test.cy.ts']);
    (cypressParser.parseCypressFile as jest.Mock).mockReturnValue({
      filePath: '/work/cypress/e2e/test.cy.ts',
      rawSource: 'cy.visit("/")',
      commands: [], testBlocks: [], customCommands: [], fixtures: [], aliases: [], envVars: [],
    });
    (playwrightConverter.convertCypressToPlaywright as jest.Mock).mockReturnValue({
      code: 'static code', notes: [], confidence: 0.8,
    });
    (mockLLMClient.migrateTest as jest.Mock).mockRejectedValue(new Error('LLM down'));

    const report = await runMigration(mockConfig, mockLLMClient, '/work');
    expect(report.totalFiles).toBe(1);
    expect(report.files[0].notes).toContain('LLM refinement failed, using static conversion only');
  });
});
