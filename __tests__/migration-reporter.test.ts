import { buildMigrationReportBody } from '../src/migration-reporter';
import { MigrationReport } from '../src/types';

describe('buildMigrationReportBody', () => {
  const baseReport: MigrationReport = {
    totalFiles: 3,
    converted: 2,
    needsReview: 1,
    failed: 0,
    files: [
      { source: 'cypress/login.cy.ts', target: 'e2e/login.spec.ts', code: '', status: 'converted', notes: [], confidence: 0.95 },
      { source: 'cypress/nav.cy.ts', target: 'e2e/nav.spec.ts', code: '', status: 'converted', notes: ['Clean conversion'], confidence: 0.9 },
      { source: 'cypress/form.cy.ts', target: 'e2e/form.spec.ts', code: '', status: 'needs-review', notes: ['TODO: custom command', 'Check selectors'], confidence: 0.4 },
    ],
    duration: 5500,
  };

  it('should include comment marker', () => {
    const body = buildMigrationReportBody(baseReport);
    expect(body).toContain('<!-- greenci-migration-report -->');
  });

  it('should show success emoji when no failures', () => {
    const body = buildMigrationReportBody(baseReport);
    expect(body).toContain('## ✅');
  });

  it('should show warning emoji when there are failures', () => {
    const report = { ...baseReport, failed: 1 };
    const body = buildMigrationReportBody(report);
    expect(body).toContain('## ⚠️');
  });

  it('should include summary table', () => {
    const body = buildMigrationReportBody(baseReport);
    expect(body).toContain('Total Files | 3');
    expect(body).toContain('Converted | ✅ 2');
    expect(body).toContain('5.5s');
  });

  it('should include file details', () => {
    const body = buildMigrationReportBody(baseReport);
    expect(body).toContain('`cypress/login.cy.ts`');
    expect(body).toContain('95%');
  });

  it('should include needs-review section', () => {
    const body = buildMigrationReportBody(baseReport);
    expect(body).toContain('Items Needing Manual Review');
    expect(body).toContain('TODO: custom command');
  });

  it('should include failed section when there are failures', () => {
    const report: MigrationReport = {
      ...baseReport,
      failed: 1,
      files: [
        ...baseReport.files,
        { source: 'cypress/broken.cy.ts', target: 'e2e/broken.spec.ts', code: '', status: 'failed', notes: ['Parse error'], confidence: 0 },
      ],
    };
    const body = buildMigrationReportBody(report);
    expect(body).toContain('Failed Conversions');
    expect(body).toContain('Parse error');
  });

  it('should include next steps', () => {
    const body = buildMigrationReportBody(baseReport);
    expect(body).toContain('Next Steps');
    expect(body).toContain('playwright.config.ts');
  });

  it('should handle empty report', () => {
    const empty: MigrationReport = { totalFiles: 0, converted: 0, needsReview: 0, failed: 0, files: [], duration: 100 };
    const body = buildMigrationReportBody(empty);
    expect(body).toContain('Total Files | 0');
    expect(body).not.toContain('File Details');
  });
});
