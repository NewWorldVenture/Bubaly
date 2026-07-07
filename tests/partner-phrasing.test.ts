import { describe, it, expect } from 'vitest';
import {
  notificationsLine, bellLabel, partnerStatus, badgeCount,
} from '@/lib/tone/partner-phrasing';

describe('notificationsLine', () => {
  it('reassures at zero', () => {
    expect(notificationsLine(0)).toBe("You're all caught up.");
  });
  it('singularizes one', () => {
    expect(notificationsLine(1)).toBe('One thing wants a quick look.');
  });
  it('frames a small pile as good shape', () => {
    expect(notificationsLine(3)).toContain('good shape');
    expect(notificationsLine(3)).toContain('3 quick things');
  });
  it('is gentle in the middle', () => {
    expect(notificationsLine(10)).toBe('10 updates waiting whenever you have a minute.');
  });
  it('offers to triage a full inbox', () => {
    expect(notificationsLine(24)).toContain('triage');
    expect(notificationsLine(24)).toContain('24');
  });
  it('never leads with a bare number for small counts', () => {
    expect(notificationsLine(2).match(/^\d/)).toBeNull();
  });
  it('clamps negatives / floors floats', () => {
    expect(notificationsLine(-4)).toBe("You're all caught up.");
    expect(notificationsLine(1.9)).toBe('One thing wants a quick look.');
  });
});

describe('bellLabel', () => {
  it('spoken-friendly at zero', () => {
    expect(bellLabel(0)).toBe('Notifications — all caught up');
  });
  it('counts updates', () => {
    expect(bellLabel(1)).toBe('Notifications — 1 update waiting');
    expect(bellLabel(5)).toBe('Notifications — 5 updates waiting');
  });
});

describe('partnerStatus', () => {
  it('is warm when nothing is pending', () => {
    expect(partnerStatus({})).toBe("Everything's handled. Go enjoy your day.");
  });
  it('surfaces overdue first (most pressing)', () => {
    const s = partnerStatus({ overdue: 2, approvals: 5, dueToday: 3, unread: 9 });
    expect(s).toContain('slipped past');
    expect(s).toContain('2 items');
  });
  it('conflicts outrank approvals', () => {
    const s = partnerStatus({ conflicts: 1, approvals: 4 });
    expect(s).toContain('schedule clash');
    expect(s).not.toContain('approval');
  });
  it('matches the partner example for approvals', () => {
    const s = partnerStatus({ approvals: 3 });
    expect(s).toContain("good shape");
    expect(s).toContain('3 quick approvals');
  });
  it('frames a calm day of tasks', () => {
    expect(partnerStatus({ dueToday: 4 })).toContain("today's plan");
  });
  it('falls back to notifications framing', () => {
    expect(partnerStatus({ unread: 1 })).toBe('One thing wants a quick look.');
  });
  it('singular approval', () => {
    expect(partnerStatus({ approvals: 1 })).toContain('1 quick approval and');
  });
});

describe('badgeCount', () => {
  it('caps at 9+ by default', () => {
    expect(badgeCount(12)).toBe('9+');
    expect(badgeCount(9)).toBe('9');
    expect(badgeCount(0)).toBe('0');
  });
  it('honors a custom cap', () => {
    expect(badgeCount(150, 99)).toBe('99+');
  });
});
