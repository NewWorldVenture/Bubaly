import { describe, it, expect } from 'vitest';
import { classifyMoment, buildMomentPrep, momentWhen, type MomentEvent } from '@/lib/moments/prep';

const base: MomentEvent = {
  id: 'e1', title: '', category: null, location: null, all_day: false,
  starts_at: '2026-07-04T15:00:00.000Z', description: null,
};

describe('classifyMoment', () => {
  it('detects sports from the title even when DB category is general', () => {
    expect(classifyMoment({ ...base, title: 'Soccer tournament', category: 'general' })).toBe('sports');
  });
  it('detects appointments and celebrations by keyword', () => {
    expect(classifyMoment({ ...base, title: 'Dentist checkup' })).toBe('appointment');
    expect(classifyMoment({ ...base, title: "Mia's birthday party" })).toBe('celebration');
  });
  it('falls back to the DB category, then general', () => {
    expect(classifyMoment({ ...base, title: 'Reading', category: 'school' })).toBe('school');
    expect(classifyMoment({ ...base, title: 'Something', category: 'other' })).toBe('general');
  });
});

describe('buildMomentPrep', () => {
  it('computes a leave-by time from the travel buffer for a located, timed sports moment', () => {
    const prep = buildMomentPrep({ ...base, title: 'Soccer game', location: 'City Fields' });
    expect(prep.category).toBe('sports');
    expect(prep.travelBufferMins).toBe(35);
    // 15:00 − 35 min = 14:25
    expect(prep.leaveByISO).toBe('2026-07-04T14:25:00.000Z');
    const ids = prep.items.map((i) => i.id);
    expect(ids).toContain('leave-by');
    expect(ids).toContain('weather');   // sports is weather-sensitive
    expect(ids).toContain('shop');      // team snacks
    expect(ids).toContain('photo');
    // The shopping step carries concrete, addable items (one-tap → grocery list).
    const shop = prep.items.find((i) => i.id === 'shop');
    expect(shop?.groceryItems?.length).toBeGreaterThan(0);
    expect(shop?.groceryItems).toContain('Water bottles');
  });

  it('emits no leave-by for an all-day event and no packing for a bare appointment', () => {
    const allDay = buildMomentPrep({ ...base, title: 'Holiday', category: 'holiday', all_day: true });
    expect(allDay.leaveByISO).toBeNull();

    const appt = buildMomentPrep({ ...base, title: 'Doctor appointment', location: 'Clinic' });
    expect(appt.category).toBe('appointment');
    expect(appt.items.find((i) => i.id === 'records')).toBeTruthy(); // bring records
    expect(appt.items.find((i) => i.id === 'pack')).toBeUndefined(); // no packing list
    expect(appt.weatherSensitive).toBe(false);
  });

  it('gives trips a budget step and a bigger buffer', () => {
    const trip = buildMomentPrep({ ...base, title: 'Road trip to the lake', location: 'Lake House' });
    expect(trip.category).toBe('trip');
    expect(trip.travelBufferMins).toBe(45);
    expect(trip.items.find((i) => i.id === 'budget')).toBeTruthy();
  });

  it('never emits a leave-by when there is no location', () => {
    const prep = buildMomentPrep({ ...base, title: 'Soccer practice' });
    expect(prep.leaveByISO).toBeNull();
    expect(prep.items.find((i) => i.id === 'leave-by')).toBeUndefined();
  });
});

describe('momentWhen', () => {
  const now = new Date('2026-07-04T13:00:00.000Z');
  it('uses relative minutes/hours for soon, day labels for later', () => {
    expect(momentWhen('2026-07-04T13:30:00.000Z', false, now)).toBe('in 30 min');
    expect(momentWhen('2026-07-04T16:00:00.000Z', false, now)).toBe('in 3 hours');
    expect(momentWhen('2026-07-05T09:00:00.000Z', false, now)).toContain('Tomorrow');
  });
});

describe('buildMomentPrep with a composed departure (M8 schedule intelligence)', () => {
  const departure = { leaveByISO: '2026-07-04T14:30:00.000Z', travelMinutes: 30 };

  it('uses the real drive time instead of the category buffer for a located, timed moment', () => {
    const prep = buildMomentPrep({ ...base, title: 'Soccer game', location: 'City Fields' }, { departure });
    expect(prep.leaveByISO).toBe('2026-07-04T14:30:00.000Z');
    expect(prep.travelBufferMins).toBe(30);
    expect(prep.leaveBySource).toBe('drive_time');
    const leave = prep.items.find((i) => i.id === 'leave-by');
    expect(leave?.hint).toBe('30 min drive to City Fields');
    expect(leave?.reminderTitle).toBe('Leave for Soccer game');
  });

  it('labels the static buffer as such when no departure is composed', () => {
    const prep = buildMomentPrep({ ...base, title: 'Soccer game', location: 'City Fields' });
    expect(prep.leaveBySource).toBe('category_buffer');
    expect(prep.items.find((i) => i.id === 'leave-by')?.hint).toBe('35 min to City Fields');
    expect(buildMomentPrep({ ...base, title: 'Soccer practice' }).leaveBySource).toBeNull();
  });

  it('ignores a departure for an unlocated, all-day, or unparseable case and keeps the buffer', () => {
    const noPlace = buildMomentPrep({ ...base, title: 'Soccer practice' }, { departure });
    expect(noPlace.leaveByISO).toBeNull();
    expect(noPlace.leaveBySource).toBeNull();
    const allDay = buildMomentPrep({ ...base, title: 'County fair', location: 'Fairgrounds', all_day: true }, { departure });
    expect(allDay.leaveByISO).toBeNull();
    const bad = buildMomentPrep({ ...base, title: 'Soccer game', location: 'City Fields' }, { departure: { leaveByISO: 'not a time', travelMinutes: 30 } });
    expect(bad.leaveBySource).toBe('category_buffer');
    expect(bad.leaveByISO).toBe('2026-07-04T14:25:00.000Z');
  });
});
