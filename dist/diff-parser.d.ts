import { ChangedFile, PRContext } from './types';
export declare function getPRContext(): PRContext;
export declare function getChangedFiles(token: string, prContext: PRContext): Promise<ChangedFile[]>;
export declare function filterTestableFiles(files: ChangedFile[]): ChangedFile[];
export declare function parseFileDiff(patch: string): {
    added: string[];
    removed: string[];
};
