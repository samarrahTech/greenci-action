import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

function findZipFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findZipFiles(full));
    else if (entry.name.endsWith('.zip')) results.push(full);
  }
  return results;
}

export async function uploadTraces(
  testResultsDir: string,
  apiUrl: string,
  apiKey: string,
  projectId: string,
  runId: string
): Promise<void> {
  const traceFiles = findZipFiles(testResultsDir);
  if (traceFiles.length === 0) {
    core.info('📦 No trace files found to upload.');
    return;
  }

  core.info(`📦 Uploading ${traceFiles.length} trace file(s) to GreenCI dashboard...`);

  for (const filePath of traceFiles) {
    const testFilename = path.relative(testResultsDir, filePath);
    try {
      const fileBase64 = fs.readFileSync(filePath).toString('base64');
      const res = await fetch(`${apiUrl}/v1/traces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          project_id: projectId,
          run_id: runId,
          test_filename: testFilename,
          file_base64: fileBase64,
        }),
      });

      if (!res.ok) {
        core.warning(`Trace upload failed for ${testFilename}: ${res.status} ${res.statusText}`);
      } else {
        core.info(`  ✅ Uploaded ${testFilename}`);
      }
    } catch (err) {
      core.warning(`Trace upload error for ${testFilename}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
