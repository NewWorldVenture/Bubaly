import { describe, it, expect } from 'vitest';
import {
  planWriteBacks, availableWriteBackKinds, reminderLeadAt, writeBackTitle,
} from '@/lib/concierge/apply';

const NOW = new Date('2026-07-10T12:00:00.000Z');

describe('planWriteBacks', () => {
  it('offers reminder + task always, calendar only with a date', () => {
    const withDate = planWriteBacks({ title: 'Beach day', planned_for: '2026-08-01' });
    expect(withDate.find((o) => o.kind === 'calendar')!.available).toBe(true);
    expect(withDate.find((o) => o.kind === 'reminder')!.available).toBe(true);
    expect(withDate.find((o) => o.kind === 'task')!.available).toBe(true);

    const noDate = planWriteBacks({ title: 'Someday trip', planned_for: null });
    expect(noDate.find((o) => o.kind === 'calendar')!.available).toBe(false);
    expect(noDate.find((o) => o.kind === 'calendar')!.reason).toBe('No date yet');
    expect(noDate.find((o) => o.kind === 'reminder')!.available).toBe(true);
  });

  it('availableWriteBackKinds filters to the doable set', () => {
    expect(availableWriteBackKinds({ title: 'x', planned_for: null })).toEqual(['reminder', 'task']);
    expect(availableWriteBackKinds({ title: 'x', planned_for: '2026-08-01' })).toEqual(['calendar', 'reminder', 'task']);
  });
});

describe('reminderLeadAt', () => {
  it('reminds 2 days before a future planned date', () => {
    expect(reminderLeadAt('2026-08-01', NOW)).toBe('2026-07-30T09:00:00.000Z');
  });

  it('never schedules a reminder in the past (clamps to just after now)', () => {
    // planned tomorrow → 2 days before is yesterday → clamp forward
    const at = reminderLeadAt('2026-07-11', NOW);
    expect(new Date(at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('defaults to 2 days out when there is no date', () => {
    expect(reminderLeadAt(null, NOW)).toBe('2026-07-12T12:00:00.000Z');
  });
});

describe('writeBackTitle', () => {
  it('prefixes prep/follow-up per kind', () => {
    expect(writeBackTitle('task', 'Emma birthday')).toBe('Prep: Emma birthday');
    expect(writeBackTitle('reminder', 'Emma birthday')).toBe('Follow up: Emma birthday');
    expect(writeBackTitle('calendar', 'Emma birthday')).toBe('Emma birthday');
  });
  it('falls back for a blank title', () => {
    expect(writeBackTitle('reminder', '  ')).toBe('Follow up: Concierge plan');
  });
});
