import * as github from '@actions/github';
import { postReport } from '../src/pr-reporter';
import { PRContext, RunReport } from '../src/types';

jest.mock('@actions/github');

const mockOctokit = {
  rest: {
    issues: {
      listComments: jest.fn(),
      createComment: jest.fn(),
      updateComment: jest.fn(),
    },
  },
};

(github.getOctokit as jest.Mock).mockReturnValue(mockOctokit);

const prContext: PRContext = {
  owner: 'test-owner',
  repo: 'test-repo',
  prNumber: 42,
  baseSha: 'base',
  headSha: 'head',
  branch: 'feature',
};

const report: RunReport = {
  testsGenerated: 3,
  testsPassed: 2,
  testsFailed: 1,
  testsHealed: 1,
  filesChanged: ['src/app.ts'],
  duration: 10000,
  tests: [
    { filename: 'e2e/a.spec.ts', passed: true, duration: 3000 },
    { filename: 'e2e/b.spec.ts', passed: true, duration: 4000 },
    { filename: 'e2e/c.spec.ts', passed: false, duration: 3000, error: 'Timeout\nwaiting for selector' },
  ],
  committedFiles: ['e2e/a.spec.ts', 'e2e/b.spec.ts'],
};

describe('postReport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (github.getOctokit as jest.Mock).mockReturnValue(mockOctokit);
  });

  it('should create a new comment when none exists', async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    mockOctokit.rest.issues.createComment.mockResolvedValue({ data: { html_url: 'https://github.com/comment/1' } });

    const url = await postReport('mock-token', prContext, report);
    expect(url).toBe('https://github.com/comment/1');
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42 })
    );
  });

  it('should update existing comment with marker', async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({
      data: [{ id: 99, body: '<!-- greenci-report -->\nold report' }],
    });
    mockOctokit.rest.issues.updateComment.mockResolvedValue({ data: { html_url: 'https://github.com/comment/99' } });

    const url = await postReport('mock-token', prContext, report);
    expect(url).toBe('https://github.com/comment/99');
    expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 99 })
    );
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('should include test results in report body', async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    mockOctokit.rest.issues.createComment.mockResolvedValue({ data: { html_url: 'url' } });

    await postReport('mock-token', prContext, report);
    const body = mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('Tests Generated | 3');
    expect(body).toContain('Tests Passed | ✅ 2');
    expect(body).toContain('Self-Healed | 🔧 1');
    expect(body).toContain('e2e/a.spec.ts');
    expect(body).toContain('Committed Files');
    expect(body).toContain('Files Analyzed');
    expect(body).toContain('<!-- greenci-report -->');
  });

  it('should handle report with all tests passing', async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    mockOctokit.rest.issues.createComment.mockResolvedValue({ data: { html_url: 'url' } });

    const passingReport: RunReport = {
      ...report,
      testsFailed: 0,
      testsHealed: 0,
      tests: [{ filename: 'e2e/a.spec.ts', passed: true, duration: 1000 }],
    };
    await postReport('mock-token', prContext, passingReport);
    const body = mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('## ✅');
  });
});
