import { describe, it, expect } from 'vitest';
import {
  buildContactTimeline, touchCadenceDays, contactHealth,
  type LoggedInteraction, type CommunicationLike,
} from '@/lib/contacts/timeline';

const NOW = new Date('2026-06-15T12:00:00Z');

const li = (id: string, occurred_on: string, kind: LoggedInteraction['kind'] = 'call'): LoggedInteraction =>
  ({ id, kind, occurred_on, title: `${kind} ${id}`, note: null, amount: null });

const comm = (id: string, received_at: string): CommunicationLike =>
  ({ id, channel: 'text', direction: 'outbound', subject: null, summary: 'quick check-in', received_at });

describe('buildContactTimeline', () => {
  it('merges interactions, communications and a passed birthday, newest first', () => {
    const t = buildContactTimeline({
      interactions: [li('a', '2026-06-01', 'visit')],
      communications: [comm('c1', '2026-06-10T15:00:00Z')],
      birthdayMonth: 3, birthdayDay: 14,
      now: NOW,
    });
    expect(t.map((e) => e.kind)).toEqual(['communication', 'visit', 'birthday']);
    expect(t[0].date).toBe('2026-06-10');
    expect(t[2].date).toBe('2026-03-14');
  });

  it('omits a birthday that has not happened yet this year', () => {
    const t = buildContactTimeline({
      interactions: [], communications: [], birthdayMonth: 12, birthdayDay: 25, now: NOW,
    });
    expect(t).toHaveLength(0);
  });

  it('titles inbound vs outbound communications naturally', () => {
    const t = buildContactTimeline({
      interactions: [],
      communications: [{ id: 'x', channel: 'call', direction: 'inbound', subject: null, summary: null, received_at: '2026-06-01T10:00:00Z' }],
      now: NOW,
    });
    expect(t[0].title).toContain('Heard from them');
  });
});

describe('touchCadenceDays', () => {
  it('returns the median gap with ≥3 touches, null otherwise', () => {
    const t = buildContactTimeline({
      interactions: [li('1', '2026-05-01'), li('2', '2026-05-11'), li('3', '2026-05-31')],
      communications: [], now: NOW,
    });
    expect(touchCadenceDays(t)).toBe(15); // gaps 10, 20 → median 15
    const t2 = buildContactTimeline({ interactions: [li('1', '2026-05-01')], communications: [], now: NOW });
    expect(touchCadenceDays(t2)).toBeNull();
  });
});

describe('contactHealth', () => {
  it('reports no_history with a starter suggestion', () => {
    const h = contactHealth([], 'Grandma June', NOW);
    expect(h.status).toBe('no_history');
    expect(h.suggestion).toContain('Grandma June');
  });

  it('is fresh right after a touch', () => {
    const t = buildContactTimeline({
      interactions: [li('1', '2026-06-14'), li('2', '2026-06-01'), li('3', '2026-05-20')],
      communications: [], now: NOW,
    });
    expect(contactHealth(t, 'Aunt Meg', NOW).status).toBe('fresh');
  });

  it('flags overdue when the gap dwarfs the cadence', () => {
    // Weekly rhythm… then 60 days of silence.
    const t = buildContactTimeline({
      interactions: [li('1', '2026-04-02'), li('2', '2026-04-09'), li('3', '2026-04-16')],
      communications: [], now: NOW,
    });
    const h = contactHealth(t, 'Coach Dana', NOW);
    expect(h.status).toBe('overdue');
    expect(h.daysSince).toBe(61); // Apr 16 00:00Z → Jun 15 12:00Z = 60.5d, rounded
    expect(h.suggestion).toContain('61 days');
  });

  it('uses gentle defaults without a cadence baseline (due at 30d)', () => {
    const t = buildContactTimeline({ interactions: [li('1', '2026-05-10')], communications: [], now: NOW });
    expect(contactHealth(t, 'Dr. Patel', NOW).status).toBe('due'); // 36 days
  });
});
