import {
  ChangedFile,
  ChangeContext,
  RouteChange,
  ComponentChange,
  APIEndpointChange,
} from './types';
import { parseFileDiff } from './diff-parser';

const ROUTE_PATTERNS = [
  // Next.js app router
  /app\/(.+?)\/page\.(tsx?|jsx?)$/,
  // Next.js pages router
  /pages\/(.+?)\.(tsx?|jsx?)$/,
  // React Router / generic route files
  /routes?\//i,
];

const COMPONENT_PATTERNS = [
  /components?\//i,
  /src\/.*\.(tsx|jsx)$/,
];

const API_PATTERNS = [
  // Next.js API routes
  /app\/api\/(.+?)\/route\.(ts|js)$/,
  /pages\/api\/(.+?)\.(ts|js)$/,
  // Express-style
  /routes?\/.+\.(ts|js)$/,
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function buildChangeContext(files: ChangedFile[]): ChangeContext {
  const routes = extractRoutes(files);
  const components = extractComponents(files);
  const apiEndpoints = extractAPIEndpoints(files);
  const summary = buildSummary(files, routes, components, apiEndpoints);

  return {
    routes,
    components,
    apiEndpoints,
    modifiedFiles: files,
    summary,
  };
}

export function extractRoutes(files: ChangedFile[]): RouteChange[] {
  const routes: RouteChange[] = [];

  for (const file of files) {
    for (const pattern of ROUTE_PATTERNS) {
      const match = file.filename.match(pattern);
      if (match) {
        let routePath = match[1] || file.filename;
        // Convert file path to route path
        routePath = '/' + routePath
          .replace(/\/page$/, '')
          .replace(/\/index$/, '')
          .replace(/\[(.+?)\]/g, ':$1');

        routes.push({
          path: routePath,
          file: file.filename,
          isNew: file.status === 'added',
        });
        break;
      }
    }
  }

  return routes;
}

export function extractComponents(files: ChangedFile[]): ComponentChange[] {
  const components: ComponentChange[] = [];

  for (const file of files) {
    const isComponent = COMPONENT_PATTERNS.some((p) => p.test(file.filename));
    if (!isComponent) continue;
    // Skip files that are routes or API endpoints
    if (API_PATTERNS.some((p) => p.test(file.filename))) continue;
    if (file.filename.match(/page\.(tsx?|jsx?)$/)) continue;

    const name = extractComponentName(file.filename, file.patch);
    const props = file.patch ? extractProps(file.patch) : [];

    components.push({
      name,
      file: file.filename,
      isNew: file.status === 'added',
      props: props.length > 0 ? props : undefined,
    });
  }

  return components;
}

export function extractAPIEndpoints(files: ChangedFile[]): APIEndpointChange[] {
  const endpoints: APIEndpointChange[] = [];

  for (const file of files) {
    // Next.js app router API routes
    const appApiMatch = file.filename.match(/app\/api\/(.+?)\/route\.(ts|js)$/);
    if (appApiMatch) {
      const methods = file.patch ? extractHTTPMethods(file.patch) : ['GET'];
      for (const method of methods) {
        endpoints.push({
          path: '/api/' + appApiMatch[1],
          method,
          file: file.filename,
          isNew: file.status === 'added',
        });
      }
      continue;
    }

    // Next.js pages API routes
    const pagesApiMatch = file.filename.match(/pages\/api\/(.+?)\.(ts|js)$/);
    if (pagesApiMatch) {
      endpoints.push({
        path: '/api/' + pagesApiMatch[1],
        method: 'ALL',
        file: file.filename,
        isNew: file.status === 'added',
      });
      continue;
    }
  }

  return endpoints;
}

function extractComponentName(filename: string, patch?: string): string {
  // Try to extract from patch (export default function ComponentName)
  if (patch) {
    const exportMatch = patch.match(
      /export\s+(?:default\s+)?(?:function|const|class)\s+([A-Z][a-zA-Z0-9]*)/
    );
    if (exportMatch) return exportMatch[1];
  }

  // Fall back to filename
  const basename = filename.split('/').pop() || '';
  const name = basename.replace(/\.(tsx?|jsx?)$/, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function extractProps(patch: string): string[] {
  const props: string[] = [];
  const { added } = parseFileDiff(patch);
  const addedCode = added.join('\n');

  // Match interface/type Props patterns
  const propsMatch = addedCode.match(/(?:interface|type)\s+\w*Props\w*\s*(?:=\s*)?{([^}]+)}/);
  if (propsMatch) {
    const propsBlock = propsMatch[1];
    const propNames = propsBlock.match(/(\w+)\s*[?:]?\s*:/g);
    if (propNames) {
      for (const p of propNames) {
        props.push(p.replace(/\s*[?:]?\s*:/, '').trim());
      }
    }
  }

  return props;
}

function extractHTTPMethods(patch: string): string[] {
  const methods: string[] = [];
  const { added } = parseFileDiff(patch);
  const addedCode = added.join('\n');

  for (const method of HTTP_METHODS) {
    // Match: export async function GET, export function POST, etc.
    const pattern = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`, 'i');
    if (pattern.test(addedCode)) {
      methods.push(method.toUpperCase());
    }
  }

  return methods.length > 0 ? methods : ['GET'];
}

function buildSummary(
  files: ChangedFile[],
  routes: RouteChange[],
  components: ComponentChange[],
  apiEndpoints: APIEndpointChange[]
): string {
  const parts: string[] = [];

  parts.push(`${files.length} file(s) changed`);

  const newFiles = files.filter((f) => f.status === 'added').length;
  const modifiedFiles = files.filter((f) => f.status === 'modified').length;
  const deletedFiles = files.filter((f) => f.status === 'removed').length;

  if (newFiles > 0) parts.push(`${newFiles} added`);
  if (modifiedFiles > 0) parts.push(`${modifiedFiles} modified`);
  if (deletedFiles > 0) parts.push(`${deletedFiles} deleted`);

  if (routes.length > 0) {
    const newRoutes = routes.filter((r) => r.isNew);
    parts.push(
      `${routes.length} route(s) affected${newRoutes.length > 0 ? ` (${newRoutes.length} new)` : ''}`
    );
  }

  if (components.length > 0) {
    parts.push(`${components.length} component(s) changed`);
  }

  if (apiEndpoints.length > 0) {
    parts.push(`${apiEndpoints.length} API endpoint(s) affected`);
  }

  return parts.join(', ');
}
