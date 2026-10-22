import { describe, expect, it } from 'vitest';
import {
  renewalStatus, daysUntil, vehicleLabel, buildRenewals, dueSoonCount,
} from '@/lib/auto/renewals';

const isoInDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();
// The family's day the statuses are counted from — here Greenwich's, the same
// clock `isoInDays` above writes in.
const TODAY = new Date().toISOString().slice(0, 10);

describe('renewalStatus', () => {
  it('flags expired', () => {
    const s = renewalStatus(isoInDays(-3), TODAY);
    expect(s.tone).toBe('danger');
    expect(s.expired).toBe(true);
  });
  it('warns within 30 days', () => {
    expect(renewalStatus(isoInDays(15), TODAY).tone).toBe('warning');
  });
  it('is healthy when far out', () => {
    expect(renewalStatus(isoInDays(200), TODAY).tone).toBe('success');
  });
  it('handles missing date', () => {
    expect(renewalStatus(null, TODAY).tone).toBe('neutral');
    expect(daysUntil(undefined, TODAY)).toBeNull();
  });
});

describe('vehicleLabel', () => {
  it('prefers nickname', () => {
    expect(vehicleLabel({ nickname: "Mom's car", year: 2020, make: 'Honda', model: 'CRV' })).toBe("Mom's car");
  });
  it('falls back to year make model', () => {
    expect(vehicleLabel({ year: 2021, make: 'Toyota', model: 'RAV4' })).toBe('2021 Toyota RAV4');
  });
  it('defaults to Vehicle', () => {
    expect(vehicleLabel({})).toBe('Vehicle');
  });
});

describe('buildRenewals', () => {
  const vehicleName = (id: string | null) => (id === 'v1' ? 'Car One' : null);

  it('aggregates and sorts soonest first', () => {
    const items = buildRenewals({
      licenses: [{ id: 'l1', holder_name: 'Pat', expires_on: isoInDays(50) }],
      registrations: [{ id: 'r1', vehicle_id: 'v1', expires_on: isoInDays(10) }],
      inspections: [{ id: 'i1', vehicle_id: 'v1', expires_on: isoInDays(100), inspection_type: 'safety' }],
      policies: [{ id: 'p1', provider: 'GEICO', vehicle_id: 'v1', expires_on: isoInDays(30) }],
      vehicleName, todayKey: TODAY,
    });
    expect(items.map((i) => i.kind)).toEqual(['registration', 'insurance', 'license', 'inspection']);
    expect(items[0].subject).toBe('Car One');
  });

  it('skips records without an expiry date', () => {
    const items = buildRenewals({
      licenses: [{ id: 'l1', holder_name: 'Pat', expires_on: null }],
      registrations: [], inspections: [], policies: [], vehicleName, todayKey: TODAY,
    });
    expect(items).toHaveLength(0);
  });

  it('counts due-soon within window', () => {
    const items = buildRenewals({
      licenses: [], registrations: [{ id: 'r1', vehicle_id: 'v1', expires_on: isoInDays(5) }],
      inspections: [{ id: 'i1', vehicle_id: 'v1', expires_on: isoInDays(200), inspection_type: 'safety' }],
      policies: [], vehicleName, todayKey: TODAY,
    });
    expect(dueSoonCount(items, 30)).toBe(1);
  });
});
