import * as core from '@actions/core';
import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, SuspectedBug, TestResult } from './types';
import { runTests, writeTests, type ProtectExisting, type SessionRenewal } from './test-runner';
import { classifyAuthFailure, hasTestCredentials, type AuthFailureKind } from './auth-scaffold';
import { lintAssertions } from './assertion-lint';

export interface HealingOutcome {
  healed: GeneratedTest[];
  results: TestResult[];
  suspectedBugs: SuspectedBug[];
  /** Failures caused by auth (missing session, or a setup that couldn't sign
   *  in) — deterministically classified, never sent to the LLM healer. */
  authBlocked: { filename: string; error?: string; kind: AuthFailureKind }[];
}

const UNREACHABLE_CODES =
  'net::ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|EMPTY_RESPONSE|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED)' +
  '|NS_ERROR_(?:CONNECTION_REFUSED|UNKNOWN_HOST|NET_RESET|NET_TIMEOUT)' +
  '|Could not connect to (?:the )?server';

/**
 * The address a navigation could not reach, when that is the whole story of
 * the failure: nothing listening, or the name does not resolve. Returns the
 * origin (e.g. http://localhost:3000), or null when this is an ordinary
 * failure the healer should see.
 *
 * Deliberately narrow, because a wrong "unreachable" verdict denies a real
 * heal:
 * - the network error must be the message of a page.goto itself, not a
 *   code-frame line or a request the page made;
 * - an assertion failure anywhere in the output means some test did reach a
 *   page, so the file is not simply "app down";
 * - if the spec spells that origin out itself, the address is the test's own
 *   mistake (a hard-coded port, an invented host) and a heal can fix it.
 */
export function unreachableOrigin(error: string | undefined, specCode = ''): string | null {
  if (!error) return null;
  const goto = new RegExp(`page\\.goto: (?:${UNREACHABLE_CODES})(?: at (\\S+))?`).exec(error);
  if (!goto) return null;
  if (/Error: expect\(/.test(error)) return null;
  const url = goto[1] ?? /navigating to "([^"]+)"/.exec(error)?.[1];
  if (!url) return null;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  if (origin === 'null' || specCode.includes(origin)) return null;
  return origin;
}

function unreachableResult(result: TestResult, origin: string): TestResult {
  return {
    ...result,
    error:
      `Nothing answered at ${origin}, so this is not a problem with the test. ` +
      `Check that the app is running before GreenCI starts and that base-url (or baseURL in your Playwright config) points at it.\n\n${result.error}`,
  };
}

export async function healFailedTests(
  failedTests: { test: GeneratedTest; result: TestResult }[],
  context: ChangeContext,
  config: ActionConfig,
  llmClient: ILLMClient,
  workDir: string,
  protect?: ProtectExisting,
  session?: SessionRenewal,
): Promise<HealingOutcome> {
  const healed: GeneratedTest[] = [];
  const results: TestResult[] = [];
  const suspectedBugs: SuspectedBug[] = [];
  const authBlocked: { filename: string; error?: string; kind: AuthFailureKind }[] = [];

  for (const { test, result } of failedTests) {
    // Nothing answered at the app's address: no edit to the test can fix
    // that, so do not spend heal calls on it. Checked before the auth
    // classifier, which would otherwise read a dead app as a sign-in problem.
    const down = unreachableOrigin(result.error, test.code);
    if (down) {
      core.warning(`🔌 ${test.filename}: nothing answered at ${down} — skipping heal`);
      results.push(unreachableResult(result, down));
      continue;
    }

    // Auth walls are not selector bugs: a heal cannot conjure a session, so
    // don't spend LLM calls on them — route to the credentials instructions.
    const authKind = classifyAuthFailure(result.error, { hasCredentials: hasTestCredentials() });
    if (authKind) {
      const why: Record<AuthFailureKind, string> = {
        'missing-session': `🔐 ${test.filename} needs login credentials — skipping heal (see PR instructions)`,
        'setup-not-run': `🔐 ${test.filename}: credentials are set but no session file existed when this spec ran — skipping heal`,
        'setup-failed': `🔐 ${test.filename} blocked: the login setup ran but could not sign in — skipping heal`,
      };
      core.warning(why[authKind]);
      authBlocked.push({ filename: test.filename, error: result.error, kind: authKind });
      results.push(result);
      continue;
    }

    let currentTest = test;
    let currentResult = result;
    // What the next heal request is told went wrong. Starts as the real
    // failure; a rejected heal appends its reason here, never to
    // currentResult, which is what the PR reports if nothing heals.
    let healError = result.error || 'Unknown error';
    let wasHealed = false;
    let bugSuspected = false;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      core.info(`🔧 Self-healing ${test.filename} (attempt ${attempt}/${config.maxRetries})`);

      try {
        const healedTest = await llmClient.healTest(
          {
            test: currentTest,
            error: healError,
            pageSnapshot: currentResult.pageSnapshot,
            attempt,
            context,
          },
          config
        );

        // The healer classified this as a likely real app regression: do not
        // rewrite the test to pass around it — surface it instead.
        if (healedTest.verdict?.classification === 'app-bug-suspected') {
          core.warning(
            `🚨 ${test.filename}: possible app regression, not healing — ${healedTest.verdict.reasoning}`
          );
          suspectedBugs.push({
            filename: test.filename,
            reasoning: healedTest.verdict.reasoning,
            error: currentResult.error,
          });
          bugSuspected = true;
          break;
        }

        // A heal rewrites THIS file: the API's filename echo is not trusted,
        // or a renamed bootstrap spec could come back under the customer's
        // original name and overwrite it.
        healedTest.filename = currentTest.filename;

        // The cheapest way to make a failing test pass is to delete what it
        // asserts. A heal that leaves nothing falsifiable is not a fix; keep
        // the current version and tell the next attempt why this one lost.
        const lint = lintAssertions(healedTest.code);
        if (!lint.ok) {
          core.warning(`🚫 ${test.filename}: heal attempt ${attempt} rejected — ${lint.reason}`);
          healError = `${healError}\n\nGreenCI rejected the previous fix because ${lint.reason}. Keep a real assertion about the page.`;
          continue;
        }
        // Write and run the healed test
        await writeTests([healedTest], workDir, config.testDir, protect);
        const [healedResult] = await runTests([healedTest], config, workDir, session);

        if (healedResult.passed) {
          core.info(`✅ ${test.filename} healed on attempt ${attempt}`);
          healed.push(healedTest);
          results.push(healedResult);
          wasHealed = true;
          break;
        }

        // The app went away between runs: stop, another heal cannot help.
        const wentDown = unreachableOrigin(healedResult.error, healedTest.code);
        if (wentDown) {
          core.warning(`🔌 ${test.filename}: nothing answered at ${wentDown} on the rerun — stopping heal`);
          currentResult = unreachableResult(healedResult, wentDown);
          bugSuspected = true; // suppresses the "could not be healed after N attempts" line: N attempts were not made
          break;
        }

        currentTest = healedTest;
        // A rerun that broke before the page loaded leaves no snapshot; the
        // last page seen is still the best evidence for the next attempt.
        currentResult = { ...healedResult, pageSnapshot: healedResult.pageSnapshot ?? currentResult.pageSnapshot };
        healError = healedResult.error || 'Unknown error';
      } catch (error) {
        core.warning(`Self-healing attempt ${attempt} failed: ${error}`);
      }
    }

    if (!wasHealed) {
      if (!bugSuspected && config.maxRetries > 0) {
        core.warning(`❌ ${test.filename} could not be healed after ${config.maxRetries} attempts`);
      }
      results.push(currentResult);
    }
  }

  return { healed, results, suspectedBugs, authBlocked };
}
