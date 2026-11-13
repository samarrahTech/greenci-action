import * as core from '@actions/core';
import { getConfig } from '../src/config';

jest.mock('@actions/core');

const mockGetInput = core.getInput as jest.MockedFunction<typeof core.getInput>;
const mockGetBooleanInput = core.getBooleanInput as jest.MockedFunction<typeof core.getBooleanInput>;

// Mirrors @actions/core: YAML 1.2 core-schema booleans, TypeError otherwise.
function booleanFromInput(name: string): boolean {
  const value = mockGetInput(name);
  if (['true', 'True', 'TRUE'].includes(value)) return true;
  if (['false', 'False', 'FALSE'].includes(value)) return false;
  throw new TypeError(`Input does not meet YAML 1.2 "Core Schema" specification: ${name}`);
}

describe('getConfig', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetBooleanInput.mockImplementation(booleanFromInput);
    mockGetInput.mockImplementation((name: string, _opts?: core.InputOptions) => {
      const defaults: Record<string, string> = {
        'api-key': 'mock-api-key-12345',
        'llm-provider': 'greenci',
        'llm-model': '',
        'aws-region': '',
        'test-dir': '',
        'base-url': '',
        'max-retries': '',
        // What the runner supplies from action.yml when the workflow sets neither.
        'auto-commit': 'true',
        'page-snapshot': 'true',
        'fail-on-test-failure': 'true',
        'greenci-api-url': '',
        'mode': '',
        'cypress-dir': '',
      };
      return defaults[name] ?? '';
    });
  });

  it('should return default config when minimal inputs provided', () => {
    const config = getConfig();
    expect(config.apiKey).toBe('mock-api-key-12345');
    expect(config.llmProvider).toBe('greenci');
    expect(config.testDir).toBe('e2e');
    expect(config.baseUrl).toBe('http://localhost:3000');
    // GC-108: an unset input must not override a repo config's baseURL.
    expect(config.baseUrlExplicit).toBe(false);
    expect(config.maxRetries).toBe(2);
    expect(config.autoCommit).toBe(true);
    expect(config.sendPageSnapshot).toBe(true);
    expect(config.mode).toBe('generate');
    expect(config.cypressDir).toBe('cypress/e2e');
    expect(config.awsRegion).toBe('us-east-1');
    expect(config.greenCIApiUrl).toBe('https://api.greenci.ai');
  });

  it('should parse custom values', () => {
    mockGetInput.mockImplementation((name: string) => {
      const vals: Record<string, string> = {
        'api-key': 'custom-key',
        'llm-provider': 'openai',
        'max-retries': '5',
        'auto-commit': 'false',
        'page-snapshot': 'false',
        'mode': 'migrate',
        'test-dir': 'tests',
        'base-url': 'http://localhost:8080',
      };
      return vals[name] ?? '';
    });
    const config = getConfig();
    expect(config.llmProvider).toBe('openai');
    expect(config.maxRetries).toBe(5);
    expect(config.autoCommit).toBe(false);
    expect(config.sendPageSnapshot).toBe(false);
    expect(config.mode).toBe('migrate');
    expect(config.testDir).toBe('tests');
    expect(config.baseUrl).toBe('http://localhost:8080');
    expect(config.baseUrlExplicit).toBe(true);
  });

  it('accepts any YAML casing for page-snapshot', () => {
    mockGetInput.mockImplementation((name: string) => ({ 'api-key': 'k', 'page-snapshot': 'False' } as Record<string, string>)[name] ?? '');
    expect(getConfig().sendPageSnapshot).toBe(false);
  });

  // GC-102: `page-snapshot: ${{ vars.X }}` with X undefined arrives as ''.
  // The runner only passes '' when the workflow did (action.yml has a
  // default), and it used to mean "send snapshots".
  it('turns page snapshots off, with a warning, on an explicitly empty page-snapshot', () => {
    mockGetInput.mockImplementation((name: string) => ({ 'api-key': 'k', 'page-snapshot': '', 'auto-commit': 'true' } as Record<string, string>)[name] ?? '');
    expect(getConfig().sendPageSnapshot).toBe(false);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('page-snapshot was passed an empty value'));
  });

  // GC-109: failing is the safe reading of a value we cannot read.
  it.each([['false', false], ['False', false], ['true', true], ['', true], ['nope', true]])('reads fail-on-test-failure %p as %p', (value, expected) => {
    mockGetInput.mockImplementation(
      (name: string) => ({ 'api-key': 'k', 'fail-on-test-failure': value, 'auto-commit': 'true', 'page-snapshot': 'true' } as Record<string, string>)[name] ?? '',
    );
    expect(getConfig().failOnTestFailure).toBe(expected);
  });

  // GC-103: 'True' used to parse as false without a word, while page-snapshot accepted it.
  it.each(['true', 'True', 'TRUE', ' true '])('reads auto-commit %p as on', (value) => {
    mockGetInput.mockImplementation((name: string) => ({ 'api-key': 'k', 'auto-commit': value, 'page-snapshot': 'true', 'fail-on-test-failure': 'true' } as Record<string, string>)[name] ?? '');
    expect(getConfig().autoCommit).toBe(true);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each(['yes', '1', ''])('does not commit, with a warning, when auto-commit is %p', (value) => {
    mockGetInput.mockImplementation((name: string) => ({ 'api-key': 'k', 'auto-commit': value, 'page-snapshot': 'true', 'fail-on-test-failure': 'true' } as Record<string, string>)[name] ?? '');
    expect(getConfig().autoCommit).toBe(false);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('auto-commit'));
  });

  it('turns page snapshots off, with a warning, on an unreadable page-snapshot value', () => {
    mockGetInput.mockImplementation((name: string) => ({ 'api-key': 'k', 'page-snapshot': 'flase' } as Record<string, string>)[name] ?? '');
    expect(getConfig().sendPageSnapshot).toBe(false);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('page-snapshot'));
  });

  it('should throw on invalid provider', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'llm-provider') return 'invalid-provider';
      if (name === 'api-key') return 'key';
      return '';
    });
    expect(() => getConfig()).toThrow('Invalid LLM provider');
  });

  it('should throw on invalid mode', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'mode') return 'bad-mode';
      if (name === 'api-key') return 'key';
      return '';
    });
    expect(() => getConfig()).toThrow('Invalid mode');
  });

  it('should accept generate-only mode', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'mode') return 'generate-only';
      if (name === 'api-key') return 'key';
      return '';
    });
    expect(getConfig().mode).toBe('generate-only');
  });

  it('should accept all valid providers', () => {
    for (const p of ['greenci', 'bedrock', 'azure-openai', 'openai', 'ollama']) {
      mockGetInput.mockImplementation((name: string) => {
        if (name === 'llm-provider') return p;
        if (name === 'api-key') return 'key';
        return '';
      });
      expect(getConfig().llmProvider).toBe(p);
    }
  });
});
// test
