import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const reports = readFileSync('app/(app)/admin/marketplace/reports/page.tsx', 'utf8');
const supportTickets = readFileSync('app/(app)/admin/support-tickets/page.tsx', 'utf8');
const support = readFileSync('app/(app)/admin/support/page.tsx', 'utf8');
// The failure notice and its retry link are translated now, so the pages hold
// KEYS where they used to hold the English. Both halves are still asserted —
// the key, so a page cannot lose the notice, and the catalogue value, so the
// notice cannot quietly become different words.
const messages = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

/** A translated string, asserted at both ends: used HERE, and saying THIS. */
function expectSays(source: string, key: string, english: string) {
  expect(source, `should render ${key}`).toContain(key);
  expect(messages[key], `${key} should still say "${english}"`).toBe(english);
}

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
    expectSays(supportTickets, 'supportTickets.couldNotLoadSupportTickets', 'Could not load support tickets. Refresh and try again.');
    expectSays(supportTickets, 'supportTickets.refreshTickets', 'Refresh tickets');
  });

  it('does not turn the legacy support view read failure into no tickets', () => {
    expect(support).toContain('error: ticketsError');
    expect(support).toContain("console.error('[admin-support] ticket read failed'");
    expectSays(support, 'support.couldNotLoadSupportTickets', 'Could not load support tickets. Refresh and try again.');
    expectSays(support, 'support.refreshTickets', 'Refresh tickets');
  });
});
