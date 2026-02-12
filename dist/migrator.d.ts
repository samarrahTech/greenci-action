import { ActionConfig, ILLMClient, MigrationReport } from './types';
import { buildMigrationReportBody } from './migration-reporter';
export declare function runMigration(config: ActionConfig, llmClient: ILLMClient, workDir: string): Promise<MigrationReport>;
export { buildMigrationReportBody };
