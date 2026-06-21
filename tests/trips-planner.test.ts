import { describe, it, expect } from 'vitest';
import {
  tripDurationDays, daysUntil, isUpcoming, checklistProgress, progressByKind,
  type TripLike, type TripItemLike,
} from '@/lib/trips/planner';

const trip = (over: Partial<TripLike>): TripLike => ({
  start_date: '2026-07-01', end_date: '2026-07-07', status: 'planning', ...over,
});
const item = (kind: TripItemLike['kind'], is_done: boolean): TripItemLike => ({ kind, is_done });

describe('tripDurationDays', () => {
  it('counts inclusive days', () => {
    expect(tripDurationDays(trip({ start_date: '2026-07-01', end_date: '2026-07-07' }))).toBe(7);
    expect(tripDurationDays(trip({ start_date: '2026-07-01', end_date: '2026-07-01' }))).toBe(1);
  });
  it('returns null on missing or inverted dates', () => {
    expect(tripDurationDays(trip({ end_date: null }))).toBeNull();
    expect(tripDurationDays(trip({ start_date: '2026-07-10', end_date: '2026-07-01' }))).toBeNull();
  });
});

describe('daysUntil', () => {
  it('is positive before, zero on the day, negative after', () => {
    expect(daysUntil(trip({ start_date: '2026-07-01' }), '2026-06-21')).toBe(10);
    expect(daysUntil(trip({ start_date: '2026-06-21' }), '2026-06-21')).toBe(0);
    expect(daysUntil(trip({ start_date: '2026-06-10' }), '2026-06-21')).toBe(-11);
  });
  it('null without a start date', () => {
    expect(daysUntil(trip({ start_date: null }), '2026-06-21')).toBeNull();
  });
});

describe('isUpcoming', () => {
  it('keeps active/planned trips ending today or later', () => {
    expect(isUpcoming(trip({ end_date: '2026-06-21' }), '2026-06-21')).toBe(true);
    expect(isUpcoming(trip({ end_date: '2026-06-20' }), '2026-06-21')).toBe(false);
  });
  it('excludes cancelled/completed', () => {
    expect(isUpcoming(trip({ status: 'cancelled' }), '2026-06-01')).toBe(false);
    expect(isUpcoming(trip({ status: 'completed' }), '2026-06-01')).toBe(false);
  });
  it('treats undated trips as still upcoming', () => {
    expect(isUpcoming(trip({ start_date: null, end_date: null }), '2026-06-21')).toBe(true);
  });
});

describe('checklistProgress', () => {
  it('computes done/total/percent and handles empty', () => {
    expect(checklistProgress([])).toEqual({ total: 0, done: 0, percent: 0 });
    expect(checklistProgress([item('packing', true), item('packing', false), item('todo', true)]))
      .toEqual({ total: 3, done: 2, percent: 67 });
  });
});

describe('progressByKind', () => {
  it('splits progress per kind', () => {
    const p = progressByKind([
      item('packing', true), item('packing', false),
      item('todo', true),
      item('reservation', false),
    ]);
    expect(p.packing).toEqual({ total: 2, done: 1, percent: 50 });
    expect(p.todo).toEqual({ total: 1, done: 1, percent: 100 });
    expect(p.reservation).toEqual({ total: 1, done: 0, percent: 0 });
    expect(p.document).toEqual({ total: 0, done: 0, percent: 0 });
  });
});
