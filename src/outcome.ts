import * as core from '@actions/core';
import { ActionConfig, RunReport } from './types';

/**
 * How a PR run ends. A run whose generated tests fail used to finish green:
 * the PR comment said 0 of 1 passing while the check said success, so nobody
 * who trusts the check looked. Failed tests now fail the check, unless the
 * workflow asks for report-only with `fail-on-test-failure: false`.
 */
export function concludeRun(report: Pick<RunReport, 'testsFailed' | 'testsPassed' | 'testsGenerated'>, config: ActionConfig): void {
  core.info(`🌱 GreenCI complete: ${report.testsPassed}/${report.testsGenerated} tests passing`);
  if (report.testsFailed === 0) return;

  const message = `${report.testsFailed} test(s) failed${config.maxRetries > 0 ? ' after self-healing attempts' : ''}`;
  if (config.failOnTestFailure === false) {
    core.warning(`${message} (fail-on-test-failure is false, so the check stays green)`);
  } else {
    core.setFailed(`${message}. See the GreenCI report on the pull request. Set fail-on-test-failure: false to report without failing the check.`);
  }
}
