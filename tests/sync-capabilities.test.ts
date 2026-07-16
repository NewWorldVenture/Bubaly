import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES, getCapability, supportsTwoWay, isSupported, allowedDirections,
} from '@/lib/sync/capabilities';

// These tests lock in the HONEST capability matrix. They intentionally assert the
// known limitations so a future "upgrade" that fakes support for a non-existent
// API breaks the build instead of shipping a lie to users.
describe('honest provider capabilities', () => {
  it('Google Keep has no API — google notes unsupported', () => {
    expect(isSupported('google', 'note')).toBe(false);
    expect(getCapability('google', 'note').mechanism).toBe('none');
  });

  it('Apple Notes has no API — apple notes unsupported', () => {
    expect(isSupported('apple', 'note')).toBe(false);
  });

  it('Amazon/Alexa is export-only for calendars (ICS), no read-back', () => {
    const c = getCapability('amazon', 'calendar');
    expect(c.write).toBe(true);
    expect(c.read).toBe(false);
    expect(c.mechanism).toBe('ics');
  });

  it('Amazon reminder writes are not supported without a custom Skill', () => {
    expect(isSupported('amazon', 'reminder')).toBe(false);
  });

  it('Google + Microsoft support two-way calendar & reminder sync', () => {
    for (const p of ['google', 'microsoft'] as const) {
      expect(supportsTwoWay(p, 'calendar')).toBe(true);
      expect(supportsTwoWay(p, 'reminder')).toBe(true);
    }
  });

  it('Microsoft supports two-way notes (OneNote)', () => {
    expect(supportsTwoWay('microsoft', 'note')).toBe(true);
  });

  it('Apple calendar is CalDAV-based while Reminders remain unsupported', () => {
    expect(getCapability('apple', 'calendar').mechanism).toBe('caldav');
    expect(isSupported('apple', 'reminder')).toBe(false);
    expect(getCapability('apple', 'reminder').mechanism).toBe('none');
  });

  it('internal provider supports everything two-way', () => {
    for (const k of ['calendar', 'reminder', 'note'] as const) {
      expect(supportsTwoWay('internal', k)).toBe(true);
    }
  });

  it('allowedDirections offers two_way only when read AND write exist', () => {
    expect(allowedDirections('google', 'calendar')).toContain('two_way');
    expect(allowedDirections('amazon', 'calendar')).not.toContain('two_way');
    expect(allowedDirections('amazon', 'calendar')).toContain('export');
    expect(allowedDirections('google', 'note')).toEqual(['disabled']);
  });

  it('every provider declares all three item kinds', () => {
    for (const p of Object.keys(CAPABILITIES) as Array<keyof typeof CAPABILITIES>) {
      for (const k of ['calendar', 'reminder', 'note'] as const) {
        expect(CAPABILITIES[p][k]).toBeDefined();
      }
    }
  });

  it('limitations are present wherever a kind is not fully two-way', () => {
    for (const p of ['google', 'microsoft', 'apple', 'amazon'] as const) {
      for (const k of ['calendar', 'reminder', 'note'] as const) {
        const c = CAPABILITIES[p][k];
        if (!(c.read && c.write)) {
          expect(c.limitation, `${p}.${k} should explain its limitation`).toBeTruthy();
        }
      }
    }
  });
});
