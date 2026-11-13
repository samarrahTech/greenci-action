import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

const MAX_TRACE_SIZE = 50 * 1024 * 1024; // keep in sync with greenci-api /v1/traces

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
  runId: string,
  /** The run's page-snapshot setting; false adds the notice below. */
  sendPageSnapshot = true,
): Promise<void> {
  const traceFiles = findZipFiles(testResultsDir);
  if (traceFiles.length === 0) {
    core.info('📦 No trace files found to upload.');
    return;
  }

  // page-snapshot: false stops the page going out with heal requests. A trace
  // archive holds the same page and more, so when one is about to be sent,
  // say so, rather than leave the opt-out looking wider than it is. Only
  // here, where there is a trace to send: a green run uploads nothing.
  if (!sendPageSnapshot) {
    core.warning(
      `page-snapshot is false, but project-id is set: ${traceFiles.length} Playwright trace archive(s) are still uploaded, ` +
        'and they contain DOM snapshots and screenshots of failing pages. Remove project-id to keep page content on the runner.',
    );
  }

  core.info(`📦 Uploading ${traceFiles.length} trace file(s) to GreenCI dashboard...`);

  for (const filePath of traceFiles) {
    const testFilename = path.relative(testResultsDir, filePath);
    try {
      // The API rejects traces over 50MB — skip early instead of base64-encoding them
      const { size } = fs.statSync(filePath);
      if (size > MAX_TRACE_SIZE) {
        core.warning(`Skipping ${testFilename}: ${(size / 1024 / 1024).toFixed(1)}MB exceeds the 50MB trace limit`);
        continue;
      }
      const fileBase64 = fs.readFileSync(filePath).toString('base64');
      const res = await fetch(`${apiUrl}/v1/traces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
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
