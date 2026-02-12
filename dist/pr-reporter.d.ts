import { PRContext, RunReport } from './types';
export declare function postReport(token: string, prContext: PRContext, report: RunReport): Promise<string>;
