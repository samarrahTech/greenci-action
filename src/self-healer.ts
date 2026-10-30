import * as core from '@actions/core';
import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, SuspectedBug, TestResult } from './types';
import { runTests, writeTests, type ProtectExisting } from './test-runner';
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

export async function healFailedTests(
  failedTests: { test: GeneratedTest; result: TestResult }[],
  context: ChangeContext,
  config: ActionConfig,
  llmClient: ILLMClient,
  workDir: string,
  protect?: ProtectExisting,
): Promise<HealingOutcome> {
  const healed: GeneratedTest[] = [];
  const results: TestResult[] = [];
  const suspectedBugs: SuspectedBug[] = [];
  const authBlocked: { filename: string; error?: string; kind: AuthFailureKind }[] = [];

  for (const { test, result } of failedTests) {
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
        const [healedResult] = await runTests([healedTest], config, workDir);

        if (healedResult.passed) {
          core.info(`✅ ${test.filename} healed on attempt ${attempt}`);
          healed.push(healedTest);
          results.push(healedResult);
          wasHealed = true;
          break;
        }

        currentTest = healedTest;
        currentResult = healedResult;
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
