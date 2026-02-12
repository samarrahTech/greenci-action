import { CypressFileInfo } from './types';
export declare function scanCypressDirectory(dir: string): string[];
export declare function parseCypressFile(filePath: string): CypressFileInfo;
export declare function parseCypressSource(filePath: string, rawSource: string): CypressFileInfo;
