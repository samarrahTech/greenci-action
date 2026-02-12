import { filterTestableFiles, parseFileDiff } from '../src/diff-parser';
import { ChangedFile } from '../src/types';

describe('filterTestableFiles', () => {
  const makeFile = (filename: string, status: 'added' | 'modified' | 'removed' = 'modified'): ChangedFile => ({
    filename,
    status,
    additions: 10,
    deletions: 5,
  });

  it('should include TypeScript and JavaScript files', () => {
    const files = [
      makeFile('src/components/Button.tsx'),
      makeFile('src/utils/helpers.ts'),
      makeFile('src/pages/Home.jsx'),
      makeFile('lib/format.js'),
    ];
    expect(filterTestableFiles(files)).toHaveLength(4);
  });

  it('should exclude non-code files', () => {
    const files = [
      makeFile('README.md'),
      makeFile('package.json'),
      makeFile('styles/main.css'),
      makeFile('public/image.png'),
      makeFile('.env.example'),
    ];
    expect(filterTestableFiles(files)).toHaveLength(0);
  });

  it('should exclude deleted files', () => {
    const files = [
      makeFile('src/old-component.tsx', 'removed'),
      makeFile('src/new-component.tsx', 'added'),
    ];
    const result = filterTestableFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('src/new-component.tsx');
  });

  it('should exclude test files', () => {
    const files = [
      makeFile('src/utils.ts'),
      makeFile('__tests__/utils.test.ts'),
      makeFile('src/components/Button.spec.tsx'),
    ];
    const result = filterTestableFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('src/utils.ts');
  });

  it('should exclude node_modules, dist, and build directories', () => {
    const files = [
      makeFile('node_modules/lodash/index.js'),
      makeFile('dist/bundle.js'),
      makeFile('build/output.js'),
      makeFile('src/app.ts'),
    ];
    const result = filterTestableFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('src/app.ts');
  });

  it('should exclude config files', () => {
    const files = [
      makeFile('.eslintrc.js'),
      makeFile('.prettierrc.js'),
      makeFile('src/real-code.ts'),
    ];
    const result = filterTestableFiles(files);
    expect(result).toHaveLength(1);
  });

  it('should exclude lock files', () => {
    const files = [
      makeFile('package-lock.json'),
      makeFile('yarn.lock'),
      makeFile('pnpm-lock.yaml'),
    ];
    expect(filterTestableFiles(files)).toHaveLength(0);
  });

  it('should handle renamed files', () => {
    const files: ChangedFile[] = [
      {
        filename: 'src/components/NewButton.tsx',
        status: 'renamed',
        additions: 2,
        deletions: 0,
        previousFilename: 'src/components/OldButton.tsx',
      },
    ];
    const result = filterTestableFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('src/components/NewButton.tsx');
  });

  it('should handle Vue and Svelte files', () => {
    const files = [
      makeFile('src/components/Modal.vue'),
      makeFile('src/routes/Home.svelte'),
    ];
    expect(filterTestableFiles(files)).toHaveLength(2);
  });
});

describe('parseFileDiff', () => {
  it('should parse added and removed lines', () => {
    const patch = `@@ -1,5 +1,6 @@
 import React from 'react';
-const old = true;
+const new1 = true;
+const new2 = false;
 
 export default function App() {`;

    const result = parseFileDiff(patch);
    expect(result.added).toEqual(['const new1 = true;', 'const new2 = false;']);
    expect(result.removed).toEqual(['const old = true;']);
  });

  it('should handle empty patch', () => {
    expect(parseFileDiff('')).toEqual({ added: [], removed: [] });
  });

  it('should ignore diff headers', () => {
    const patch = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
-old line
+new line`;

    const result = parseFileDiff(patch);
    expect(result.added).toEqual(['new line']);
    expect(result.removed).toEqual(['old line']);
  });

  it('should handle a realistic Next.js route diff', () => {
    const patch = `@@ -0,0 +1,25 @@
+import { NextResponse } from 'next/server';
+
+export async function GET() {
+  const data = await fetch('https://api.example.com/items');
+  const items = await data.json();
+  return NextResponse.json(items);
+}
+
+export async function POST(request: Request) {
+  const body = await request.json();
+  return NextResponse.json({ created: true }, { status: 201 });
+}`;

    const result = parseFileDiff(patch);
    expect(result.added).toHaveLength(12);
    expect(result.removed).toHaveLength(0);
    expect(result.added[0]).toContain("import { NextResponse }");
  });
});
