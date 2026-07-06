import * as core from '@actions/core';
import { PRContext, RunReport } from './types';

/**
 * Post the run summary to the GreenCI API so the dashboard's "Recent runs"
 * view (pass/fail counts, self-heals, suspected app bugs) has data.
 * Non-fatal: a dashboard hiccup must never fail the user's CI.
 */
export async function uploadResults(
  apiUrl: string,
  apiKey: string,
  prContext: PRContext,
  report: RunReport,
): Promise<void> {
  const verdicts = [
    ...(report.healedTests ?? [])
      .filter((t) => t.verdict)
      .map((t) => ({
        filename: t.filename,
        classification: t.verdict!.classification,
        reasoning: t.verdict!.reasoning,
      })),
    ...(report.suspectedBugs ?? []).map((b) => ({
      filename: b.filename,
      classification: 'app-bug-suspected' as const,
      reasoning: b.reasoning,
    })),
  ];

  try {
    const res = await fetch(`${apiUrl}/v1/results`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        repository: `${prContext.owner}/${prContext.repo}`,
        commit: prContext.headSha,
        branch: prContext.branch,
        pr_number: prContext.prNumber,
        total_tests: report.testsGenerated,
        passed_tests: report.testsPassed,
        failed_tests: report.testsFailed,
        self_healing_events: report.testsHealed,
        suspected_app_bugs: report.suspectedBugs?.length ?? 0,
        verdicts,
        execution_time: `${(report.duration / 1000).toFixed(1)}s`,
        environment: 'ci',
        framework: 'playwright',
      }),
    });

    if (res.ok) {
      core.info('📊 Run results uploaded to the GreenCI dashboard');
    } else {
      core.warning(`Results upload failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    core.warning(`Results upload error: ${err instanceof Error ? err.message : err}`);
  }
}
