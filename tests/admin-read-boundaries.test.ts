import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const reports = readFileSync('app/(app)/admin/marketplace/reports/page.tsx', 'utf8');
const supportTickets = readFileSync('app/(app)/admin/support-tickets/page.tsx', 'utf8');
const support = readFileSync('app/(app)/admin/support/page.tsx', 'utf8');

describe('privileged admin read boundaries', () => {
  it('does not turn marketplace report read failures into an empty queue', () => {
    expect(reports).toContain('error: reportsError');
    expect(reports).toContain('if (reportsError)');
    expect(reports).toContain('listingsError');
    expect(reports).toContain('familiesError');
    expect(reports).toContain('<AdminReadError />');
  });

  it('does not turn the primary ticket queue read failure into no tickets', () => {
    expect(supportTickets).toContain('error: ticketsError');
    expect(supportTickets).toContain("console.error('[admin-support-tickets] ticket read failed'");
    expect(supportTickets).toContain('Could not load support tickets. Refresh and try again.');
    expect(supportTickets).toContain('Refresh tickets');
  });

  it('does not turn the legacy support view read failure into no tickets', () => {
    expect(support).toContain('error: ticketsError');
    expect(support).toContain("console.error('[admin-support] ticket read failed'");
    expect(support).toContain('Could not load support tickets. Refresh and try again.');
    expect(support).toContain('Refresh tickets');
  });
});
