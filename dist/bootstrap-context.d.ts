export interface BootstrapPage {
    url: string;
    html: string;
}
/** Parse the multiline `journeys` input into individual journey descriptions. */
export declare function parseJourneys(input: string): string[];
/**
 * Collect the URL paths to fetch for grounding: the app root plus any
 * absolute paths mentioned in the journey text (e.g. "/jobs/new").
 */
export declare function collectPaths(journeys: string[]): string[];
/** Strip scripts/styles/svg/comments and collapse whitespace so real DOM structure fits the prompt. */
export declare function sanitizeHtml(html: string): string;
/**
 * Fetch the rendered HTML of the app's key pages so generated selectors are
 * grounded in the real DOM. Non-fatal per page: a 404 path just gets skipped.
 */
export declare function fetchPages(baseUrl: string, journeys: string[]): Promise<BootstrapPage[]>;
