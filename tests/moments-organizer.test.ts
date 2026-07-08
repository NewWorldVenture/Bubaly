import { describe, it, expect } from 'vitest';
import { activeMoments, MOMENT_DEFS, type MomentSignals } from '@/lib/moments/organizer';

function sig(o: Partial<MomentSignals>): MomentSignals {
  return { hour: 12, dow: 3, ...o }; // Wed noon default
}

describe('activeMoments', () => {
  it('surfaces the weekday morning rhythm', () => {
    const ms = activeMoments(sig({ hour: 7, dow: 2 }));
    const keys = ms.map((m) => m.key);
    expect(keys).toContain('morning');
    expect(keys).toContain('school');
  });

  it('surfaces dinner + bedtime in the evening', () => {
    const ms = activeMoments(sig({ hour: 19, dow: 2 }));
    const keys = ms.map((m) => m.key);
    expect(keys).toContain('dinner');
    expect(keys).toContain('bedtime');
  });

  it('surfaces the weekend moment on Saturday, not the school moment', () => {
    const ms = activeMoments(sig({ hour: 11, dow: 6 }));
    const keys = ms.map((m) => m.key);
    expect(keys).toContain('weekend');
    expect(keys).not.toContain('school');
  });

  it('ranks an imminent trip above the daily rhythm', () => {
    const ms = activeMoments(sig({ hour: 18, dow: 3, tripInDays: 3, tripLabel: 'Beach week' }));
    expect(ms[0].key).toBe('vacation');
    expect(ms[0].reason).toContain('Beach week');
    // Sooner trips outrank later ones.
    const later = activeMoments(sig({ hour: 18, dow: 3, tripInDays: 18, tripLabel: 'Ski' }));
    expect(ms[0].priority).toBeGreaterThan(later[0].priority);
  });

  it('prioritizes homework-due-tomorrow in the evening', () => {
    const ms = activeMoments(sig({ hour: 18, dow: 2, homeworkDueTomorrow: 2 }));
    expect(ms.find((m) => m.key === 'homework')).toBeTruthy();
    // Homework (urgent) outranks the dinner rhythm.
    const hw = ms.findIndex((m) => m.key === 'homework');
    const dn = ms.findIndex((m) => m.key === 'dinner');
    expect(hw).toBeLessThan(dn);
  });

  it('does not flag a far-off birthday but flags a near one', () => {
    expect(activeMoments(sig({ birthdayInDays: 60 })).some((m) => m.key === 'birthday')).toBe(false);
    const near = activeMoments(sig({ birthdayInDays: 5, birthdayName: 'Mia' }));
    const bd = near.find((m) => m.key === 'birthday');
    expect(bd?.reason).toContain('Mia');
  });

  it('always includes emergency at the lowest priority', () => {
    const ms = activeMoments(sig({ hour: 7, dow: 2 }));
    const em = ms.find((m) => m.key === 'emergency');
    expect(em).toBeTruthy();
    expect(ms[ms.length - 1].key).toBe('emergency');
  });

  it('every moment carries deep-linked capabilities', () => {
    for (const m of activeMoments(sig({ hour: 18, dow: 6, tripInDays: 2, birthdayInDays: 3 }))) {
      expect(MOMENT_DEFS[m.key].capabilities.length).toBeGreaterThan(0);
      expect(m.capabilities.every((c) => c.href.startsWith('/'))).toBe(true);
    }
  });

  it('de-dupes a moment that matches twice, keeping the highest priority', () => {
    const ms = activeMoments(sig({ hour: 18, dow: 3 }));
    const keys = ms.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
