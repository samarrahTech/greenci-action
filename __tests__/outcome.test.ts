import * as core from '@actions/core';
import { concludeRun } from '../src/outcome';
import { ActionConfig } from '../src/types';

jest.mock('@actions/core');

const config = { maxRetries: 2 } as ActionConfig;

// GC-109: on greenci-landing a run with 0 of 1 tests passing finished with a
// green check.
describe('concludeRun', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fails the check when generated tests failed', () => {
    concludeRun({ testsGenerated: 1, testsPassed: 0, testsFailed: 1 }, config);
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('1 test(s) failed after self-healing attempts'));
  });

  it('leaves the check green when every test passed', () => {
    concludeRun({ testsGenerated: 2, testsPassed: 2, testsFailed: 0 }, config);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('2/2 tests passing'));
  });

  it('only warns when the workflow asked for report-only', () => {
    concludeRun({ testsGenerated: 1, testsPassed: 0, testsFailed: 1 }, { ...config, failOnTestFailure: false });
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('1 test(s) failed'));
  });

  it('does not claim heal attempts that max-retries 0 never made', () => {
    concludeRun({ testsGenerated: 1, testsPassed: 0, testsFailed: 1 }, { ...config, maxRetries: 0 });
    expect(core.setFailed).toHaveBeenCalledWith(expect.not.stringContaining('self-healing'));
  });
});
