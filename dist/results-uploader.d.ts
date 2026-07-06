import { PRContext, RunReport } from './types';
/**
 * Post the run summary to the GreenCI API so the dashboard's "Recent runs"
 * view (pass/fail counts, self-heals, suspected app bugs) has data.
 * Non-fatal: a dashboard hiccup must never fail the user's CI.
 */
export declare function uploadResults(apiUrl: string, apiKey: string, prContext: PRContext, report: RunReport): Promise<void>;
