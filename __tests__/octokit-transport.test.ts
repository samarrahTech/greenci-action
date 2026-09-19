import * as http from 'http';
import type { AddressInfo } from 'net';

/**
 * A real request through the real Octokit stack, with no mocks.
 *
 * Every other test that touches @actions/github mocks it, so the entire
 * transport was uncovered — which mattered when undici was pinned to ^6 via an
 * npm override while @actions/http-client still declares ^5. The unit suite
 * stayed green throughout because none of it ever opened a socket.
 *
 * @actions/github wires `fetch: getProxyFetch(baseUrl)` into the Octokit
 * defaults at module load (node_modules/@actions/github/lib/utils.js), and that
 * fetch comes from undici. So undici is the transport for every GitHub API call
 * this action makes — src/git-ops.ts, src/pr-reporter.ts and src/index.ts all
 * go through it. This test exercises that path against a local server.
 */
describe('Octokit transport (undici, unmocked)', () => {
  let server: http.Server;
  let baseUrl: string;
  const seen: Array<{ method: string; url: string; auth?: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });

      if (req.url?.startsWith('/repos/o/r/issues/1/comments') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, body: 'hello', html_url: 'https://example.test/c/1' }]));
        return;
      }
      if (req.url?.startsWith('/repos/o/r/issues/1/comments') && req.method === 'POST') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 2, html_url: 'https://example.test/c/2' }));
        return;
      }
      if (req.url?.startsWith('/boom')) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Unprocessable' }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client() {
    // Required lazily: jest.mock('@actions/github') in sibling suites must not
    // apply here, and this file deliberately uses the real module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const github = require('@actions/github');
    return github.getOctokit('t0ken', { baseUrl });
  }

  it('completes a GET through the real undici transport', async () => {
    const octokit = client();
    const { data } = await octokit.rest.issues.listComments({
      owner: 'o',
      repo: 'r',
      issue_number: 1,
    });
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].body).toBe('hello');
  });

  it('completes a POST and sends the auth header', async () => {
    const octokit = client();
    const { data } = await octokit.rest.issues.createComment({
      owner: 'o',
      repo: 'r',
      issue_number: 1,
      body: 'from the test',
    });
    expect(data.html_url).toBe('https://example.test/c/2');
    const post = seen.find((r) => r.method === 'POST');
    expect(post?.auth).toContain('t0ken');
  });

  it('surfaces a non-2xx as an HttpError rather than hanging or resolving', async () => {
    const octokit = client();
    await expect(octokit.request(`GET ${baseUrl}/boom`)).rejects.toMatchObject({ status: 422 });
  });
});
