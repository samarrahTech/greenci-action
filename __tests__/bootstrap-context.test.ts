import * as core from '@actions/core';
import { parseJourneys, collectPaths, sanitizeHtml, fetchPages } from '../src/bootstrap-context';

jest.mock('@actions/core');

describe('parseJourneys', () => {
  it('splits lines and strips list markers', () => {
    const input = `- Sign in with email and password
1. Post a job at /jobs/new and reach payment
* Search for dental hygienist jobs

`;
    expect(parseJourneys(input)).toEqual([
      'Sign in with email and password',
      'Post a job at /jobs/new and reach payment',
      'Search for dental hygienist jobs',
    ]);
  });
});

describe('collectPaths', () => {
  it('always includes the root and extracts mentioned paths', () => {
    const paths = collectPaths(['Sign in at /login with a password', 'Post a job at /jobs/new, then pay']);
    expect(paths).toContain('/');
    expect(paths).toContain('/login');
    expect(paths).toContain('/jobs/new');
  });

  it('caps the number of pages', () => {
    const journeys = Array.from({ length: 20 }, (_, i) => `Visit /page-${i}`);
    expect(collectPaths(journeys).length).toBeLessThanOrEqual(6);
  });
});

describe('sanitizeHtml', () => {
  it('strips scripts, styles, and comments and collapses whitespace', () => {
    const html = `<html><head><style>.a{color:red}</style></head>
      <body>  <script>alert(1)</script> <!-- note -->
      <button>  Post   Job </button></body></html>`;
    const out = sanitizeHtml(html);
    expect(out).not.toContain('alert');
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('note');
    expect(out).toContain('<button> Post Job </button>');
  });

  it('caps output length', () => {
    expect(sanitizeHtml('x'.repeat(100_000)).length).toBeLessThanOrEqual(50_000);
  });
});

describe('fetchPages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('fetches root plus mentioned paths and skips failures', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, text: async () => '<body>home</body>' })
      .mockResolvedValueOnce({ ok: false, status: 404 });

    const pages = await fetchPages('http://localhost:3000', ['Log in at /login']);
    expect(pages).toHaveLength(1);
    expect(pages[0].url).toBe('/');
    expect(pages[0].html).toContain('home');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('404'));
  });

  it('survives network errors', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    const pages = await fetchPages('http://localhost:3000', ['Visit the homepage']);
    expect(pages).toEqual([]);
  });
});
