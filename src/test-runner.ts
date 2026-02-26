import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';
import { ActionConfig, GeneratedTest, TestResult } from './types';

export async function writeTests(tests: GeneratedTest[], workDir: string): Promise<string[]> {
  const writtenFiles: string[] = [];

  for (const test of tests) {
    const filePath = path.join(workDir, test.filename);
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, test.code, 'utf-8');
    writtenFiles.push(filePath);
    core.info(`Wrote test: ${test.filename}`);
  }

  return writtenFiles;
}

export async function runTests(
  tests: GeneratedTest[],
  config: ActionConfig,
  workDir: string
): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const test of tests) {
    const filePath = path.join(workDir, test.filename);
    const startTime = Date.now();

    let stdout = '';
    let stderr = '';

    try {
      // Use relative path from workDir so Playwright's testDir matching works
      const relativePath = path.relative(workDir, filePath);
      const exitCode = await exec.exec('npx', ['playwright', 'test', relativePath, '--reporter=line'], {
        cwd: workDir,
        env: {
          ...process.env,
          BASE_URL: config.baseUrl,
          CI: 'true',
        },
        silent: true,
        listeners: {
          stdout: (data) => {
            stdout += data.toString();
          },
          stderr: (data) => {
            stderr += data.toString();
          },
        },
        ignoreReturnCode: true,
      });

      const duration = Date.now() - startTime;
      const passed = exitCode === 0;

      results.push({
        filename: test.filename,
        passed,
        duration,
        error: passed ? undefined : stderr || stdout,
        stdout,
      });

      if (passed) {
        core.info(`✅ ${test.filename} passed (${duration}ms)`);
      } else {
        core.warning(`❌ ${test.filename} failed (${duration}ms)`);
        // Log stderr first (usually has the real error), then stdout
        const errorOutput = [stderr, stdout].filter(Boolean).join('\n');
        const errorSnippet = errorOutput.substring(0, 800);
        if (errorSnippet) {
          core.info(`   Error output:\n${errorSnippet}`);
        }
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      results.push({
        filename: test.filename,
        passed: false,
        duration,
        error: error instanceof Error ? error.message : String(error),
      });
      core.warning(`❌ ${test.filename} errored: ${error}`);
    }
  }

  return results;
}

export function cleanupTests(filePaths: string[]): void {
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
