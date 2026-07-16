import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const syncHub = readFileSync('app/(app)/dashboard/sync/page.tsx', 'utf8');
const accounts = readFileSync('app/(app)/dashboard/sync/accounts/page.tsx', 'utf8');
const provider = readFileSync('app/(app)/dashboard/sync/accounts/[provider]/page.tsx', 'utf8');

describe('sync connectable surface', () => {
  it('only exposes providers registered with real account adapters', () => {
    expect(syncHub).toContain("['google', 'microsoft', 'apple']");
    expect(accounts).toContain("['google', 'microsoft', 'apple']");
    expect(provider).toContain("['google', 'microsoft', 'apple']");
    expect(accounts).not.toContain("'amazon'");
    expect(provider).not.toContain("'amazon'");
  });

  it('does not promise Alexa account sync in the hub copy', () => {
    expect(syncHub).toContain('sync your calendars and reminders');
    expect(syncHub).not.toContain('and Alexa to two-way sync');
  });
});
