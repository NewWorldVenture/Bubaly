import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import { readFileSync } from 'node:fs';

const syncHub = readUiSource('app/(app)/dashboard/sync/page.tsx');
const accounts = readUiSource('app/(app)/dashboard/sync/accounts/page.tsx');
const provider = readUiSource('app/(app)/dashboard/sync/accounts/[provider]/page.tsx');

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
