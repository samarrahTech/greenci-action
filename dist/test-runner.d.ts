import { ActionConfig, GeneratedTest, TestResult } from './types';
export declare function writeTests(tests: GeneratedTest[], workDir: string, testDir?: string): Promise<string[]>;
export declare function runTests(tests: GeneratedTest[], config: ActionConfig, workDir: string): Promise<TestResult[]>;
export declare function cleanupTests(filePaths: string[]): void;
