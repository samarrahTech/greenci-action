/**
 * Post-generation tautology lint.
 *
 * A generated spec that cannot fail is worse than no spec: it inflates the
 * count, and a customer who reads one (`toHaveURL(/.*\/)`, "body is visible")
 * stops trusting the whole suite. This module decides, without running
 * anything, whether a spec contains at least one assertion that a real page
 * could falsify. It is deliberately a heuristic scanner rather than a full
 * parser: the vacuous patterns a model produces are few and stable, and a
 * false "ok" costs nothing more than today, while a false rejection would
 * throw away a real test — so every rule below only fires on shapes that are
 * unfalsifiable by construction.
 */
import type { GeneratedTest } from './types';
export interface VacuousAssertion {
    /** The assertion source, trimmed to one line for logs. */
    snippet: string;
    /** Why it can never fail. */
    reason: string;
}
export interface AssertionLintResult {
    /** True when at least one assertion in the file can fail. */
    ok: boolean;
    /** Number of expect(...) assertions found. */
    total: number;
    /** Assertions judged unfalsifiable. */
    vacuous: VacuousAssertion[];
    /** One-line explanation when `ok` is false. */
    reason?: string;
}
export interface RejectedTest {
    filename: string;
    reason: string;
}
/**
 * Decide whether `code` has at least one falsifiable assertion.
 */
export declare function lintAssertions(code: string): AssertionLintResult;
/**
 * Split generated tests into the ones worth running and the ones that could
 * never fail. Callers log and surface `rejected`; nothing in it reaches disk.
 */
export declare function rejectTautologies(tests: GeneratedTest[]): {
    kept: GeneratedTest[];
    rejected: RejectedTest[];
};
/** The PR-body section both report builders show for rejected tests. */
export declare function renderRejectedSection(rejected: RejectedTest[] | undefined): string;
