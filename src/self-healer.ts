import * as core from '@actions/core';
import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, TestResult } from './types';
import { runTests, writeTests } from './test-runner';

export async function healFailedTests(
  failedTests: { test: GeneratedTest; result: TestResult }[],
  context: ChangeContext,
  config: ActionConfig,
  llmClient: ILLMClient,
  workDir: string
): Promise<{ healed: GeneratedTest[]; results: TestResult[] }> {
  const healed: GeneratedTest[] = [];
  const results: TestResult[] = [];

  for (const { test, result } of failedTests) {
    let currentTest = test;
    let currentResult = result;
    let wasHealed = false;

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

        // Write and run the healed test
        await writeTests([healedTest], workDir);
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
      core.warning(`❌ ${test.filename} could not be healed after ${config.maxRetries} attempts`);
      results.push(currentResult);
    }
  }

  return { healed, results };
}
