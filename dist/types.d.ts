export type OperationMode = 'generate' | 'generate-only' | 'migrate' | 'bootstrap';
export interface ActionConfig {
    apiKey: string;
    llmProvider: LLMProvider;
    llmModel: string;
    awsRegion: string;
    testDir: string;
    baseUrl: string;
    maxRetries: number;
    autoCommit: boolean;
    greenCIApiUrl: string;
    mode: OperationMode;
    cypressDir: string;
    journeys: string;
}
export type LLMProvider = 'greenci' | 'anthropic' | 'openai' | 'bedrock' | 'azure-openai' | 'ollama';
export interface ChangedFile {
    filename: string;
    status: FileStatus;
    additions: number;
    deletions: number;
    patch?: string;
    previousFilename?: string;
}
export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'copied';
export interface PRContext {
    owner: string;
    repo: string;
    prNumber: number;
    baseSha: string;
    headSha: string;
    branch: string;
}
export interface ChangeContext {
    routes: RouteChange[];
    components: ComponentChange[];
    apiEndpoints: APIEndpointChange[];
    modifiedFiles: ChangedFile[];
    summary: string;
    existingTests?: string[];
}
export interface RouteChange {
    path: string;
    file: string;
    method?: string;
    isNew: boolean;
}
export interface ComponentChange {
    name: string;
    file: string;
    isNew: boolean;
    props?: string[];
}
export interface APIEndpointChange {
    path: string;
    method: string;
    file: string;
    isNew: boolean;
}
export interface GeneratedTest {
    filename: string;
    code: string;
    description: string;
    confidence: number;
    /** Present on tests returned by the heal endpoint */
    verdict?: HealVerdict;
}
export interface HealVerdict {
    classification: 'test-issue' | 'app-bug-suspected';
    confidence: number;
    reasoning: string;
}
export interface SuspectedBug {
    filename: string;
    reasoning: string;
    error?: string;
}
export interface TestResult {
    filename: string;
    passed: boolean;
    duration: number;
    error?: string;
    stdout?: string;
}
export interface SelfHealRequest {
    test: GeneratedTest;
    error: string;
    attempt: number;
    context: ChangeContext;
}
export interface RunReport {
    testsGenerated: number;
    testsPassed: number;
    testsFailed: number;
    testsHealed: number;
    filesChanged: string[];
    duration: number;
    tests: TestResult[];
    committedFiles: string[];
    /** Healed tests with their verdicts, for evidence in the PR report */
    healedTests?: GeneratedTest[];
    /** Failures the healer classified as likely real app regressions */
    suspectedBugs?: SuspectedBug[];
}
export interface ILLMClient {
    generateTests(context: ChangeContext, config: ActionConfig): Promise<GeneratedTest[]>;
    healTest(request: SelfHealRequest, config: ActionConfig): Promise<GeneratedTest>;
    migrateTest?(cypressSource: string, staticConversion: string, config: ActionConfig): Promise<string>;
    bootstrapTests?(journeys: string[], pages: {
        url: string;
        html: string;
    }[], config: ActionConfig, existingTests?: string[]): Promise<GeneratedTest[]>;
}
export interface CypressCommand {
    type: string;
    selector?: string;
    args?: string[];
    chained?: CypressCommand[];
    raw: string;
}
export interface CypressTestBlock {
    type: 'describe' | 'it' | 'before' | 'beforeEach' | 'after' | 'afterEach';
    title?: string;
    body: string;
    children?: CypressTestBlock[];
}
export interface CypressFileInfo {
    filePath: string;
    commands: string[];
    testBlocks: CypressTestBlock[];
    customCommands: string[];
    fixtures: string[];
    aliases: string[];
    envVars: string[];
    rawSource: string;
}
export interface MigrationResult {
    source: string;
    target: string;
    code: string;
    status: 'converted' | 'needs-review' | 'failed';
    notes: string[];
    confidence: number;
}
export interface MigrationReport {
    totalFiles: number;
    converted: number;
    needsReview: number;
    failed: number;
    files: MigrationResult[];
    duration: number;
}
