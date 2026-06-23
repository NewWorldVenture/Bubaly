import { describe, it, expect } from 'vitest';
import { daysUntil, tripNights, dateRange, countdownLabel, isActive } from '@/lib/vacations/dates';
import { summarizeBudget, overruns } from '@/lib/vacations/budget';
import { weatherCodeMeta, cToF, dayAdvice, tripWeatherAdvice } from '@/lib/vacations/weather';
import { suggestPacking } from '@/lib/vacations/packing';
import { computeReadiness, type ReadinessInput } from '@/lib/vacations/readiness';
import { detectConflicts, type ItemLike } from '@/lib/vacations/conflicts';

const today = new Date('2026-06-23T12:00:00');

describe('dates', () => {
  it('daysUntil / countdown / active', () => {
    expect(daysUntil('2026-06-30', today)).toBe(7);
    expect(daysUntil('2026-06-23', today)).toBe(0);
    expect(daysUntil(null, today)).toBeNull();
    expect(countdownLabel('2026-06-24', today)).toBe('Tomorrow');
    expect(countdownLabel('2026-06-23', today)).toBe('Today');
    expect(countdownLabel('2026-06-20', today)).toBe('3 days ago');
    expect(isActive('2026-06-20', '2026-06-25', today)).toBe(true);
    expect(isActive('2026-07-01', '2026-07-05', today)).toBe(false);
  });
  it('tripNights and dateRange', () => {
    expect(tripNights('2026-08-01', '2026-08-08')).toBe(7);
    expect(tripNights('2026-08-01', null)).toBeNull();
    expect(dateRange('2026-08-01', '2026-08-03')).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(dateRange('2026-08-03', '2026-08-01')).toEqual([]);
  });
});

describe('budget', () => {
  it('rolls up planned vs spent per category and overall', () => {
    const s = summarizeBudget(
      [{ category: 'lodging', planned_cents: 100000 }, { category: 'food', planned_cents: 50000 }],
      [{ category: 'lodging', amount_cents: 120000 }, { category: 'food', amount_cents: 20000 }],
    );
    expect(s.planned_cents).toBe(150000);
    expect(s.spent_cents).toBe(140000);
    expect(s.remaining_cents).toBe(10000);
    const lodging = s.categories.find((c) => c.category === 'lodging')!;
    expect(lodging.over).toBe(true);
    expect(overruns(s).map((c) => c.category)).toEqual(['lodging']);
  });
  it('handles spend with no plan', () => {
    const s = summarizeBudget([], [{ category: 'misc', amount_cents: 5000 }]);
    expect(s.pct).toBe(999);
    expect(s.over).toBe(false); // no planned baseline => not flagged as over
  });
});

describe('weather', () => {
  it('decodes WMO codes and converts temps', () => {
    expect(weatherCodeMeta(0).label).toBe('Clear');
    expect(weatherCodeMeta(95).label).toBe('Thunderstorm');
    expect(weatherCodeMeta(null).label).toBe('Unknown');
    expect(cToF(0)).toBe(32);
    expect(cToF(100)).toBe(212);
  });
  it('derives advice and dedupes worst-severity across trip', () => {
    const storm = dayAdvice({ forecast_date: '2026-08-01', temp_high_c: 38, temp_low_c: 20, precip_prob: 80, weather_code: 96 });
    expect(storm.some((a) => a.severity === 3)).toBe(true);
    const trip = tripWeatherAdvice([
      { forecast_date: '2026-08-01', temp_high_c: 31, temp_low_c: 20, precip_prob: 40, weather_code: 61 },
      { forecast_date: '2026-08-02', temp_high_c: 36, temp_low_c: 22, precip_prob: 10, weather_code: 0 },
    ]);
    expect(trip[0].severity).toBe(3); // extreme heat ranks first
  });
});

describe('packing', () => {
  it('scales with nights and adapts to context', () => {
    const list = suggestPacking({
      kind: 'theme_park', nights: 5, hasChildren: true, hasBaby: false, isInternational: true,
      maxTempC: 32, minTempC: 18, rainy: true, activities: ['Water park', 'Hiking'],
    });
    const names = list.map((x) => x.name.toLowerCase());
    expect(names).toContain('passport');
    expect(names).toContain('sunscreen');
    expect(names).toContain('umbrella');
    expect(names).toContain('swimsuit');
    expect(names).toContain('hiking boots');
    expect(names).toContain('kids snacks');
    // deduped: swimsuit appears once
    expect(names.filter((n) => n === 'swimsuit').length).toBe(1);
  });
});

describe('readiness', () => {
  const blank: ReadinessInput = {
    hasDates: false, membersCount: 0, lodgingTotal: 0, lodgingBooked: 0,
    transportTotal: 0, transportBooked: 0, activitiesTotal: 0, activitiesBooked: 0,
    reservationsTotal: 0, reservationsBooked: 0, packingTotal: 0, packingPacked: 0,
    documentsCount: 0, emergencyContactsCount: 0, budgetPlannedCents: 0,
    itineraryDays: 0, tripDays: 0, isInternational: false,
  };
  it('empty trip scores 0 / not_started with recommendations', () => {
    const r = computeReadiness(blank);
    expect(r.score).toBe(0);
    expect(r.level).toBe('not_started');
    expect(r.recommendations.length).toBeGreaterThan(3);
  });
  it('fully prepared trip scores ready', () => {
    const r = computeReadiness({
      hasDates: true, membersCount: 4, lodgingTotal: 1, lodgingBooked: 1,
      transportTotal: 2, transportBooked: 2, activitiesTotal: 3, activitiesBooked: 3,
      reservationsTotal: 2, reservationsBooked: 2, packingTotal: 20, packingPacked: 20,
      documentsCount: 4, emergencyContactsCount: 3, budgetPlannedCents: 500000,
      itineraryDays: 5, tripDays: 5, isInternational: true,
    });
    expect(r.score).toBeGreaterThanOrEqual(95);
    expect(r.level).toBe('ready');
    expect(r.recommendations.length).toBe(0);
  });
});

describe('conflicts', () => {
  const mk = (o: Partial<ItemLike>): ItemLike => ({
    id: Math.random().toString(36).slice(2), day_id: 'd1', day_date: '2026-08-01',
    kind: 'activity', day_part: 'morning', title: 'X', start_time: null, end_time: null, ...o,
  });
  it('flags overlapping timed items', () => {
    const c = detectConflicts([
      mk({ id: 'a', title: 'Museum', start_time: '10:00', end_time: '12:00' }),
      mk({ id: 'b', title: 'Lunch tour', start_time: '11:00', end_time: '13:00' }),
    ]);
    expect(c.some((x) => x.kind === 'overlap')).toBe(true);
  });
  it('flags overbooked days and missing meals; kid-aware checks', () => {
    const many = Array.from({ length: 8 }, (_, i) => mk({ id: 'x' + i, title: 'Plan ' + i }));
    const c = detectConflicts(many, { hasYoungChildren: true });
    expect(c.some((x) => x.kind === 'overbooked')).toBe(true);
    expect(c.some((x) => x.kind === 'no_meals')).toBe(true);
    const late = detectConflicts([mk({ id: 'L', title: 'Show', start_time: '21:30', end_time: '23:00' })], { hasYoungChildren: true });
    expect(late.some((x) => x.kind === 'late_night')).toBe(true);
  });
});
