/**
 * Static Cypress → Playwright conversion rules.
 * Applied before LLM refinement pass.
 */
export declare function convertCypressToPlaywright(source: string): {
    code: string;
    notes: string[];
    confidence: number;
};
