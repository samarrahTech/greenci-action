import { PRContext } from './types';
export declare function commitTests(token: string, prContext: PRContext, testFiles: string[], workDir: string): Promise<string[]>;
