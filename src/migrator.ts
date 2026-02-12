import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { ActionConfig, ILLMClient, MigrationReport, MigrationResult } from './types';
import { scanCypressDirectory, parseCypressFile } from './cypress-parser';
import { convertCypressToPlaywright } from './playwright-converter';
import { buildMigrationReportBody } from './migration-reporter';

export async function runMigration(
  config: ActionConfig,
  llmClient: ILLMClient,
  workDir: string
): Promise<MigrationReport> {
  const startTime = Date.now();
  const cypressDir = path.resolve(workDir, config.cypressDir);
  const targetDir = path.resolve(workDir, config.testDir);

  core.info(`📂 Scanning Cypress directory: ${cypressDir}`);
  const cypressFiles = scanCypressDirectory(cypressDir);

  if (cypressFiles.length === 0) {
    core.warning(`No Cypress test files found in ${cypressDir}`);
    return {
      totalFiles: 0,
      converted: 0,
      needsReview: 0,
      failed: 0,
      files: [],
      duration: Date.now() - startTime,
    };
  }

  core.info(`Found ${cypressFiles.length} Cypress test file(s)`);

  // Ensure target directory exists
  fs.mkdirSync(targetDir, { recursive: true });

  const results: MigrationResult[] = [];

  for (const filePath of cypressFiles) {
    core.info(`🔄 Converting: ${path.relative(workDir, filePath)}`);
    const result = await convertFile(filePath, cypressDir, targetDir, config, llmClient, workDir);
    results.push(result);

    const icon = result.status === 'converted' ? '✅' : result.status === 'needs-review' ? '⚠️' : '❌';
    core.info(`  ${icon} ${result.status} (confidence: ${Math.round(result.confidence * 100)}%)`);
  }

  const report: MigrationReport = {
    totalFiles: cypressFiles.length,
    converted: results.filter((r) => r.status === 'converted').length,
    needsReview: results.filter((r) => r.status === 'needs-review').length,
    failed: results.filter((r) => r.status === 'failed').length,
    files: results,
    duration: Date.now() - startTime,
  };

  core.info(`\n📊 Migration Summary:`);
  core.info(`  Total: ${report.totalFiles}`);
  core.info(`  Converted: ${report.converted}`);
  core.info(`  Needs Review: ${report.needsReview}`);
  core.info(`  Failed: ${report.failed}`);

  return report;
}

async function convertFile(
  filePath: string,
  cypressDir: string,
  targetDir: string,
  config: ActionConfig,
  llmClient: ILLMClient,
  workDir: string
): Promise<MigrationResult> {
  const relativePath = path.relative(cypressDir, filePath);
  // Convert filename: *.cy.ts → *.spec.ts
  const targetFilename = relativePath
    .replace(/\.cy\.(ts|js)x?$/, '.spec.$1')
    .replace(/\.spec\.(ts|js)x?$/, '.spec.$1');
  const targetPath = path.join(targetDir, targetFilename);
  const source = path.relative(workDir, filePath);
  const target = path.relative(workDir, targetPath);

  try {
    const fileInfo = parseCypressFile(filePath);

    // Step 1: Static conversion
    const { code: staticCode, notes, confidence: staticConfidence } = convertCypressToPlaywright(fileInfo.rawSource);

    let finalCode = staticCode;
    let finalConfidence = staticConfidence;
    const allNotes = [...notes];

    // Step 2: LLM refinement (if available)
    if (llmClient.migrateTest) {
      try {
        core.info(`  🤖 Sending to LLM for refinement...`);
        const refined = await llmClient.migrateTest(fileInfo.rawSource, staticCode, config);
        if (refined && refined.trim().length > 0) {
          finalCode = refined;
          finalConfidence = Math.min(1, staticConfidence + 0.15);
          allNotes.push('LLM refinement applied');
        }
      } catch (error) {
        core.warning(`  LLM refinement failed: ${error}. Using static conversion.`);
        allNotes.push('LLM refinement failed, using static conversion only');
      }
    }

    // Write converted file
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, finalCode, 'utf-8');

    // Determine status
    let status: MigrationResult['status'] = 'converted';
    if (finalConfidence < 0.5 || allNotes.some((n) => n.includes('TODO') || n.includes('Unconverted'))) {
      status = 'needs-review';
    }

    return { source, target, code: finalCode, status, notes: allNotes, confidence: finalConfidence };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      source,
      target,
      code: '',
      status: 'failed',
      notes: [`Conversion error: ${errorMsg}`],
      confidence: 0,
    };
  }
}

export { buildMigrationReportBody };
