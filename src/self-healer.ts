import * as core from '@actions/core';
import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, SuspectedBug, TestResult } from './types';
import { runTests, writeTests } from './test-runner';

export interface HealingOutcome {
  healed: GeneratedTest[];
  results: TestResult[];
  suspectedBugs: SuspectedBug[];
}

export async function healFailedTests(
  failedTests: { test: GeneratedTest; result: TestResult }[],
  context: ChangeContext,
  config: ActionConfig,
  llmClient: ILLMClient,
  workDir: string
): Promise<HealingOutcome> {
  const healed: GeneratedTest[] = [];
  const results: TestResult[] = [];
  const suspectedBugs: SuspectedBug[] = [];

  for (const { test, result } of failedTests) {
    let currentTest = test;
    let currentResult = result;
    let wasHealed = false;
    let bugSuspected = false;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      core.info(`🔧 Self-healing ${test.filename} (attempt ${attempt}/${config.maxRetries})`);

      try {
        const healedTest = await llmClient.healTest(
          {
            test: currentTest,
            error: currentResult.error || 'Unknown error',
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

        // Write and run the healed test
        await writeTests([healedTest], workDir, config.testDir);
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
      } catch (error) {
        core.warning(`Self-healing attempt ${attempt} failed: ${error}`);
      }
    }

    if (!wasHealed) {
      if (!bugSuspected) {
        core.warning(`❌ ${test.filename} could not be healed after ${config.maxRetries} attempts`);
      }
      results.push(currentResult);
    }
  }

  return { healed, results, suspectedBugs };
}
