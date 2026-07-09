import * as core from '@actions/core';

export interface BootstrapPage {
  url: string;
  html: string;
}

const MAX_PAGES = 6;
const MAX_HTML_PER_PAGE = 50_000;

/** Parse the multiline `journeys` input into individual journey descriptions. */
export function parseJourneys(input: string): string[] {
  return input
    .split('\n')
    .map((line) => line.replace(/^\s*[-*\d.)]+\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Collect the URL paths to fetch for grounding: the app root plus any
 * absolute paths mentioned in the journey text (e.g. "/jobs/new").
 */
export function collectPaths(journeys: string[]): string[] {
  const paths = new Set<string>(['/']);
  const pathRegex = /(?:^|\s|\(|"|')(\/[a-zA-Z0-9\-_./?=&]*)/g;
  for (const journey of journeys) {
    let match: RegExpExecArray | null;
    while ((match = pathRegex.exec(journey)) !== null) {
      const p = match[1].replace(/[.,)]+$/, '');
      if (p.length > 1) paths.add(p);
    }
  }
  return [...paths].slice(0, MAX_PAGES);
}

/** Strip scripts/styles/svg/comments and collapse whitespace so real DOM structure fits the prompt. */
export function sanitizeHtml(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '<svg/>')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, MAX_HTML_PER_PAGE);
}

/**
 * Fetch the rendered HTML of the app's key pages so generated selectors are
 * grounded in the real DOM. Non-fatal per page: a 404 path just gets skipped.
 */
export async function fetchPages(baseUrl: string, journeys: string[]): Promise<BootstrapPage[]> {
  const pages: BootstrapPage[] = [];
  for (const path of collectPaths(journeys)) {
    const url = new URL(path, baseUrl).toString();
    try {
      const res = await fetch(url, { headers: { Accept: 'text/html' }, redirect: 'follow' });
      if (!res.ok) {
        core.warning(`Skipping ${url}: HTTP ${res.status}`);
        continue;
      }
      const html = sanitizeHtml(await res.text());
      if (html) {
        pages.push({ url: path, html });
        core.info(`📄 Captured ${url} (${html.length} chars)`);
      }
    } catch (err) {
      core.warning(`Could not fetch ${url}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return pages;
}
