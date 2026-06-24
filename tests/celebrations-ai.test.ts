import { describe, expect, it } from 'vitest';
import {
  analyzeCelebrations,
  buildCelebrationsPrompt,
  parseCelebrationsResponse,
  type CelebrationEntryLike,
} from '@/lib/celebrations/celebrations-ai';

function celebration(overrides: Partial<CelebrationEntryLike> = {}): CelebrationEntryLike {
  return { title: 'Birthday', kind: 'birthday', event_date: '2026-07-15', ...overrides };
}

describe('analyzeCelebrations', () => {
  it('summarizes celebrations', () => {
    const r = analyzeCelebrations([
      celebration({ kind: 'birthday' }),
      celebration({ title: 'Anniversary', kind: 'anniversary', event_date: '2026-12-01' }),
      celebration({ title: 'Christmas', kind: 'holiday', event_date: '2026-12-25' }),
    ]);
    expect(r.totalDates).toBe(3);
    expect(r.kindCounts['birthday']).toBe(1);
    expect(r.kindCounts['anniversary']).toBe(1);
    expect(r.summary).toContain('3 dates');
  });

  it('counts upcoming within 30 days', () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 10);
    const r = analyzeCelebrations([
      celebration({ event_date: soon.toISOString().slice(0, 10) }),
    ]);
    expect(r.upcomingCount).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzeCelebrations([]);
    expect(r.totalDates).toBe(0);
    expect(r.summary).toContain('0 dates');
  });
});

describe('buildCelebrationsPrompt', () => {
  it('builds prompt with date info', () => {
    const { system, user } = buildCelebrationsPrompt([celebration({ title: 'Mom Birthday' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Mom Birthday');
  });
});

describe('parseCelebrationsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseCelebrationsResponse('{"suggestions":["plan early"],"giftIdeas":["photo book"],"planningTip":"set reminders"}');
    expect(r.suggestions).toEqual(['plan early']);
    expect(r.giftIdeas).toEqual(['photo book']);
    expect(r.planningTip).toBe('set reminders');
  });

  it('handles malformed input', () => {
    const r = parseCelebrationsResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseCelebrationsResponse('```json\n{"suggestions":["x"],"giftIdeas":["y"],"planningTip":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
