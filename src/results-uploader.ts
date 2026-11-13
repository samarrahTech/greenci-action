import * as core from '@actions/core';
import { PRContext, RunReport } from './types';

// Same limits, order and clipping as the API (greenci-api src/types.ts:
// MAX_STORED_VERDICTS, clipStart, clipEnd, keepStoredVerdicts). The API clips
// too, but only after it has accepted the body: a run with many long verdicts
// went over the 2 MB request limit and was dropped whole with a 413, so the
// dashboard showed nothing for the runs with the most to say. If the API
// raises a limit, raise it here.
const MAX_VERDICTS = 50;
const MAX_REASONING = 4096;
const MAX_FILENAME = 512;
const MAX_CLASSIFICATION = 64;

interface UploadedVerdict {
  filename: string;
  classification: string;
  reasoning: string;
}

/** The heal verdict is not validated where it is parsed, so any field may be missing or not a string. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(text).join(' ');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** Keep the start, mark the cut, never leave half of a character pair. */
export function clipEnd(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  if (isHighSurrogate(s.charCodeAt(end - 1))) end--;
  return `${s.slice(0, end)}…`;
}

/** Keep the end (a spec's name is at the end of its path), mark the cut. */
export function clipStart(s: string, max: number): string {
  if (s.length <= max) return s;
  let start = s.length - (max - 1);
  if (isLowSurrogate(s.charCodeAt(start))) start++;
  return `…${s.slice(start)}`;
}

/**
 * The verdicts to store, within the API's limits. Suspected app bugs go
 * first, so they are the ones kept when there are more than fit.
 */
export function buildVerdicts(report: RunReport): UploadedVerdict[] {
  const clip = (v: { filename: unknown; classification: unknown; reasoning: unknown }): UploadedVerdict => ({
    filename: clipStart(text(v.filename), MAX_FILENAME),
    // The API rejects the whole report on a classification over its limit; it does not clip this field.
    classification: text(v.classification).slice(0, MAX_CLASSIFICATION) || 'unknown',
    reasoning: clipEnd(text(v.reasoning), MAX_REASONING),
  });
  const all = [
    ...(report.suspectedBugs ?? []).map((b) => clip({ filename: b.filename, classification: 'app-bug-suspected', reasoning: b.reasoning })),
    ...(report.healedTests ?? [])
      .filter((t) => t.verdict)
      .map((t) => clip({ filename: t.filename, classification: t.verdict!.classification, reasoning: t.verdict!.reasoning })),
  ];
  if (all.length > MAX_VERDICTS) {
    core.info(`📊 ${all.length} verdicts this run; the dashboard keeps ${MAX_VERDICTS} (suspected app bugs first). The PR report lists all of them.`);
  }
  return all.slice(0, MAX_VERDICTS);
}

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
  const verdicts = buildVerdicts(report);

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
