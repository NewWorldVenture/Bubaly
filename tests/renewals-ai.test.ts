import { describe, expect, it } from 'vitest';
import {
  analyzeRenewals,
  buildRenewalsPrompt,
  parseRenewalsResponse,
  type RenewalEntryLike,
} from '@/lib/renewals/renewals-ai';

function renewal(overrides: Partial<RenewalEntryLike> = {}): RenewalEntryLike {
  return { title: 'Passport', category: 'passport', expires_at: '2099-06-15', cost: null, status: 'active', ...overrides };
}

describe('analyzeRenewals', () => {
  it('summarizes renewals', () => {
    const r = analyzeRenewals([
      renewal({ title: 'Passport', cost: 150 }),
      renewal({ title: 'License', expires_at: '2000-01-01', cost: 25 }),
      renewal({ title: 'Done', status: 'renewed' }),
    ]);
    expect(r.totalRenewals).toBe(3);
    expect(r.activeCount).toBe(2);
    expect(r.expiredCount).toBe(1);
    expect(r.totalCost).toBe(175);
  });

  it('detects expiring soon', () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 15);
    const r = analyzeRenewals([renewal({ expires_at: soon.toISOString().slice(0, 10) })]);
    expect(r.expiringSoonCount).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzeRenewals([]);
    expect(r.totalRenewals).toBe(0);
    expect(r.totalCost).toBe(0);
  });
});

describe('buildRenewalsPrompt', () => {
  it('builds prompt with renewal info', () => {
    const { system, user } = buildRenewalsPrompt([renewal({ title: 'Car Registration', category: 'registration' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Car Registration');
    expect(user).toContain('registration');
  });
});

describe('parseRenewalsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseRenewalsResponse('{"suggestions":["set reminders"],"priorityItems":["passport expires soon"],"organizationTip":"use a spreadsheet"}');
    expect(r.suggestions).toEqual(['set reminders']);
    expect(r.priorityItems).toEqual(['passport expires soon']);
    expect(r.organizationTip).toBe('use a spreadsheet');
  });

  it('handles malformed input', () => {
    const r = parseRenewalsResponse('nope');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseRenewalsResponse('```json\n{"suggestions":["x"],"priorityItems":["y"],"organizationTip":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
