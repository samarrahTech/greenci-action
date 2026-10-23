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

export interface RenamedTest {
  from: string;
  to: string;
}

/**
 * Bootstrap must never rewrite a test the customer already has. The model is
 * shown the existing suite and told to add, not replace — but it still reuses
 * a committed filename often enough (TME-web PR #25 rewrote auth-login.spec.ts)
 * that the guarantee has to live here: a generated file whose name is already
 * in the repo is written under `<stem>-bootstrap.spec.ts` instead, and the PR
 * says so, so the owner can diff the two and keep one.
 */
export function avoidOverwritingExisting<T extends { filename: string }>(
  tests: T[],
  existing: ExistingTest[],
  testDir: string,
): { tests: T[]; renamed: RenamedTest[] } {
  const taken = new Set(existing.map((e) => normalise(e.filename, testDir)));
  const renamed: RenamedTest[] = [];
  const out = tests.map((t) => {
    const rel = normalise(t.filename, testDir);
    if (!taken.has(rel)) {
      taken.add(rel);
      return t;
    }
    const m = rel.match(/^(.*?)(\.(?:spec|test)\.(?:ts|js|mjs))$/);
    const stem = m ? m[1] : rel.replace(/\.[^.]+$/, '');
    const ext = m ? m[2] : rel.slice(stem.length);
    let candidate = `${stem}-bootstrap${ext}`;
    for (let n = 2; taken.has(candidate); n++) candidate = `${stem}-bootstrap-${n}${ext}`;
    taken.add(candidate);
    renamed.push({ from: rel, to: candidate });
    return { ...t, filename: candidate };
  });
  return { tests: out, renamed };
}

function normalise(filename: string, testDir: string): string {
  let f = filename.replace(/\\/g, '/').replace(/^\.\//, '');
  const prefix = testDir.replace(/\\/g, '/').replace(/\/$/, '') + '/';
  if (f.startsWith(prefix)) f = f.slice(prefix.length);
  return f;
}
