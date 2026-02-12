import {
  buildChangeContext,
  extractRoutes,
  extractComponents,
  extractAPIEndpoints,
} from '../src/context-builder';
import { ChangedFile } from '../src/types';

const makeFile = (
  filename: string,
  status: 'added' | 'modified' = 'modified',
  patch?: string
): ChangedFile => ({
  filename,
  status,
  additions: 10,
  deletions: 5,
  patch,
});

describe('extractRoutes', () => {
  it('should detect Next.js app router pages', () => {
    const files = [
      makeFile('app/dashboard/page.tsx', 'added'),
      makeFile('app/settings/page.tsx', 'modified'),
    ];
    const routes = extractRoutes(files);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toEqual({
      path: '/dashboard',
      file: 'app/dashboard/page.tsx',
      isNew: true,
    });
    expect(routes[1]).toEqual({
      path: '/settings',
      file: 'app/settings/page.tsx',
      isNew: false,
    });
  });

  it('should detect Next.js pages router', () => {
    const files = [makeFile('pages/about.tsx', 'added')];
    const routes = extractRoutes(files);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/about');
  });

  it('should handle dynamic routes', () => {
    const files = [makeFile('app/users/[id]/page.tsx', 'added')];
    const routes = extractRoutes(files);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/users/:id');
  });

  it('should handle nested dynamic routes', () => {
    const files = [makeFile('app/blog/[slug]/comments/[commentId]/page.tsx', 'added')];
    const routes = extractRoutes(files);
    expect(routes[0].path).toBe('/blog/:slug/comments/:commentId');
  });

  it('should return empty for non-route files', () => {
    const files = [
      makeFile('src/utils/helpers.ts'),
      makeFile('src/components/Button.tsx'),
    ];
    expect(extractRoutes(files)).toHaveLength(0);
  });
});

describe('extractComponents', () => {
  it('should detect component files', () => {
    const files = [
      makeFile('src/components/Button.tsx', 'added', `+export default function Button({ label }: { label: string }) {`),
    ];
    const components = extractComponents(files);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('Button');
    expect(components[0].isNew).toBe(true);
  });

  it('should extract component names from export statements', () => {
    const files = [
      makeFile(
        'src/components/Modal.tsx',
        'added',
        `+export const Modal = () => {}` // won't match our pattern (needs function/class)
      ),
    ];
    // Falls back to filename-based name
    const components = extractComponents(files);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('Modal');
  });

  it('should extract props from interface', () => {
    const patch = `@@ -0,0 +1,10 @@
+interface ButtonProps {
+  label: string;
+  onClick: () => void;
+  disabled?: boolean;
+}
+
+export default function Button(props: ButtonProps) {
+  return <button>{props.label}</button>;
+}`;
    const files = [makeFile('src/components/Button.tsx', 'added', patch)];
    const components = extractComponents(files);
    expect(components[0].props).toEqual(['label', 'onClick', 'disabled']);
  });

  it('should not classify API routes as components', () => {
    const files = [makeFile('app/api/users/route.ts', 'added')];
    const components = extractComponents(files);
    expect(components).toHaveLength(0);
  });

  it('should not classify page files as components', () => {
    const files = [makeFile('app/dashboard/page.tsx', 'added')];
    const components = extractComponents(files);
    expect(components).toHaveLength(0);
  });
});

describe('extractAPIEndpoints', () => {
  it('should detect Next.js app router API routes', () => {
    const patch = `@@ -0,0 +1,10 @@
+export async function GET() {
+  return Response.json({ ok: true });
+}
+
+export async function POST(request: Request) {
+  return Response.json({ created: true });
+}`;
    const files = [makeFile('app/api/users/route.ts', 'added', patch)];
    const endpoints = extractAPIEndpoints(files);
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]).toEqual({
      path: '/api/users',
      method: 'GET',
      file: 'app/api/users/route.ts',
      isNew: true,
    });
    expect(endpoints[1].method).toBe('POST');
  });

  it('should detect Next.js pages API routes', () => {
    const files = [makeFile('pages/api/auth/login.ts', 'added')];
    const endpoints = extractAPIEndpoints(files);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].path).toBe('/api/auth/login');
    expect(endpoints[0].method).toBe('ALL');
  });

  it('should default to GET when no methods found in patch', () => {
    const files = [makeFile('app/api/health/route.ts', 'added')];
    const endpoints = extractAPIEndpoints(files);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].method).toBe('GET');
  });
});

describe('buildChangeContext', () => {
  it('should build a complete context with summary', () => {
    const files = [
      makeFile('app/dashboard/page.tsx', 'added'),
      makeFile('src/components/Chart.tsx', 'added'),
      makeFile('app/api/metrics/route.ts', 'added', `+export async function GET() {}`),
      makeFile('src/utils/format.ts', 'modified'),
    ];

    const context = buildChangeContext(files);
    expect(context.routes).toHaveLength(1);
    expect(context.components).toHaveLength(1);
    expect(context.apiEndpoints).toHaveLength(1);
    expect(context.modifiedFiles).toHaveLength(4);
    expect(context.summary).toContain('4 file(s) changed');
    expect(context.summary).toContain('3 added');
    expect(context.summary).toContain('1 modified');
    expect(context.summary).toContain('1 route(s) affected');
    expect(context.summary).toContain('1 component(s) changed');
    expect(context.summary).toContain('1 API endpoint(s) affected');
  });

  it('should handle empty file list', () => {
    const context = buildChangeContext([]);
    expect(context.routes).toHaveLength(0);
    expect(context.components).toHaveLength(0);
    expect(context.apiEndpoints).toHaveLength(0);
    expect(context.summary).toContain('0 file(s) changed');
  });
});
