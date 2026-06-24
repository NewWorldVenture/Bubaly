import { describe, expect, it } from 'vitest';
import { analyzeSignups, buildSignupsPrompt, parseSignupsResponse, type SignupEntryLike } from '@/lib/opportunities/signups-ai';

function signup(overrides: Partial<SignupEntryLike> = {}): SignupEntryLike {
  return { title: 'Soccer camp', category: 'camp', deadline: '2099-07-01', cost: null, status: 'interested', ...overrides };
}

describe('analyzeSignups', () => {
  it('summarizes signups', () => {
    const r = analyzeSignups([signup(), signup({ status: 'missed', cost: 200 }), signup({ cost: 150 })]);
    expect(r.totalSignups).toBe(3);
    expect(r.openCount).toBe(2);
    expect(r.missedCount).toBe(1);
    expect(r.totalCost).toBe(350);
  });

  it('detects closing soon', () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const r = analyzeSignups([signup({ deadline: soon.toISOString().slice(0, 10) })]);
    expect(r.closingSoonCount).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzeSignups([]);
    expect(r.totalSignups).toBe(0);
  });
});

describe('buildSignupsPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildSignupsPrompt([signup({ title: 'Swim lessons' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Swim lessons');
  });
});

describe('parseSignupsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseSignupsResponse('{"suggestions":["register early"],"deadlineAlerts":["camp closes Friday"],"planningTip":"calendar reminders"}');
    expect(r.suggestions).toEqual(['register early']);
    expect(r.planningTip).toBe('calendar reminders');
  });

  it('handles malformed input', () => {
    expect(parseSignupsResponse('bad').suggestions).toEqual([]);
  });
});
