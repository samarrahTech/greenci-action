import { ActionConfig, GeneratedTest, TestResult } from './types';
/**
 * Zero-test repos (the bootstrap audience) usually have neither
 * @playwright/test nor browsers installed. Install what's missing so the
 * first run works out of the box. Returns true if anything was installed.
 */
export declare function ensurePlaywright(workDir: string): Promise<boolean>;
/**
 * Without a Playwright config, relative page.goto('/...') calls fail because
 * there is no baseURL. If the repo has no config, write a minimal one so the
 * generated tests run. Returns true if a config was created (callers should
 * tell the user to add a permanent one).
 */
export declare function ensurePlaywrightConfig(workDir: string, baseUrl: string, testDir: string): boolean;
export declare function writeTests(tests: GeneratedTest[], workDir: string, testDir?: string): Promise<string[]>;
export declare function runTests(tests: GeneratedTest[], config: ActionConfig, workDir: string): Promise<TestResult[]>;
export declare function cleanupTests(filePaths: string[]): void;
