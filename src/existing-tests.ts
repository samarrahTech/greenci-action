import * as fs from 'fs';
import * as path from 'path';

const MAX_FILE_SIZE = 50 * 1024; // 50KB

export interface ExistingTest {
  filename: string;
  code: string;
}

/**
 * Reads existing test files from the test directory.
 * Skips files larger than 50KB to avoid token bloat.
 */
export function readExistingTests(workDir: string, testDir: string): ExistingTest[] {
  const fullPath = path.join(workDir, testDir);

  if (!fs.existsSync(fullPath)) {
    return [];
  }

  const results: ExistingTest[] = [];
  scanDirectory(fullPath, fullPath, results);
  return results;
}

function scanDirectory(dir: string, rootDir: string, results: ExistingTest[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      scanDirectory(fullPath, rootDir, results);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!/\.(spec|test)\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;

    try {
      const stats = fs.statSync(fullPath);
      if (stats.size > MAX_FILE_SIZE) continue;

      const code = fs.readFileSync(fullPath, 'utf-8');
      const relativePath = path.relative(rootDir, fullPath);
      results.push({ filename: relativePath, code });
    } catch {
      // Skip unreadable files
    }
  }
}

/**
 * Formats existing tests for the API's existingTests field.
 * Each string = "// filename: login.spec.ts\n{code}"
 */
export function formatExistingTestsForAPI(tests: ExistingTest[]): string[] {
  return tests.map((t) => `// filename: ${t.filename}\n${t.code}`);
}
