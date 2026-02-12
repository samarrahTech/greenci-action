import * as core from '@actions/core';
import { ActionConfig, ChangeContext, GeneratedTest, ILLMClient, TestResult, RunReport } from './types';
import { runTests, writeTests } from './test-runner';
import { healFailedTests } from './self-healer';

export async function generateAndRunTests(
  context: ChangeContext,
  config: ActionConfig,
  llmClient: ILLMClient,
  workDir: string
): Promise<RunReport> {
  const startTime = Date.now();

  // 1. Generate tests
  core.info('🧪 Generating tests...');
  const generatedTests = await llmClient.generateTests(context, config);
  core.info(`Generated ${generatedTests.length} test(s)`);

  if (generatedTests.length === 0) {
    return {
      testsGenerated: 0,
      testsPassed: 0,
      testsFailed: 0,
      testsHealed: 0,
      filesChanged: context.modifiedFiles.map((f) => f.filename),
      duration: Date.now() - startTime,
      tests: [],
      committedFiles: [],
    };
  }

  // 2. Write tests to disk
  await writeTests(generatedTests, workDir);

  // 3. Run tests
  core.info('🏃 Running tests...');
  const initialResults = await runTests(generatedTests, config, workDir);

  // 4. Self-heal failed tests
  const failedTests = initialResults
    .map((result, i) => ({ test: generatedTests[i], result }))
    .filter(({ result }) => !result.passed);

  let healedTests: GeneratedTest[] = [];
  let healedResults: TestResult[] = [];

  if (failedTests.length > 0 && config.maxRetries > 0) {
    core.info(`🔧 Attempting to heal ${failedTests.length} failed test(s)...`);
    const healing = await healFailedTests(failedTests, context, config, llmClient, workDir);
    healedTests = healing.healed;
    healedResults = healing.results;
  }

  // 5. Compile final results
  const passedInitial = initialResults.filter((r) => r.passed);
  const allResults = [
    ...passedInitial,
    ...healedResults,
  ];

  const totalPassed = allResults.filter((r) => r.passed).length;
  const totalFailed = allResults.filter((r) => !r.passed).length;

  return {
    testsGenerated: generatedTests.length,
    testsPassed: totalPassed,
    testsFailed: totalFailed,
    testsHealed: healedTests.length,
    filesChanged: context.modifiedFiles.map((f) => f.filename),
    duration: Date.now() - startTime,
    tests: allResults,
    committedFiles: [], // Filled in by index.ts after commit
  };
}
