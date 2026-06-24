import { describe, expect, it } from 'vitest';
import {
  latestByKind, monthlyTotalCents, trendForKind, deltaPct, usd,
  annualTotalCents, trailingAvgCents, spikePct, summarizeUtilities, deterministicSavingsFindings,
  type BillLike,
} from '@/lib/home/utilities';
import { maskValue, groupByCategory, binderCategoryLabel, type InfoLike } from '@/lib/home/binder';
import { severityMeta, sortEvents, summarizeSecurity, type EventLike } from '@/lib/home/security';
import { summarizeDevices, groupByRoom, integrationLabel, type DeviceLike } from '@/lib/home/devices';

describe('utilities', () => {
  const bills: BillLike[] = [
    { kind: 'electric', period_month: '2026-04-01', amount_cents: 9000 },
    { kind: 'electric', period_month: '2026-05-01', amount_cents: 12000 },
    { kind: 'water', period_month: '2026-05-01', amount_cents: 4000 },
  ];
  it('latestByKind + monthlyTotal', () => {
    expect(latestByKind(bills).get('electric')?.amount_cents).toBe(12000);
    expect(monthlyTotalCents(bills)).toBe(16000); // 12000 + 4000
  });
  it('trend + deltaPct', () => {
    expect(trendForKind(bills, 'electric').map((b) => b.amount_cents)).toEqual([9000, 12000]);
    expect(deltaPct(bills, 'electric')).toBe(33);
    expect(deltaPct(bills, 'water')).toBeNull();
  });
  it('usd', () => { expect(usd(12000)).toBe('$120.00'); });
});

describe('utility savings analysis', () => {
  // electric: 100, 105, 95 typical (avg 100), then a 160 spike; water flat-ish.
  const bills: BillLike[] = [
    { kind: 'electric', period_month: '2026-01-01', amount_cents: 10000 },
    { kind: 'electric', period_month: '2026-02-01', amount_cents: 10500 },
    { kind: 'electric', period_month: '2026-03-01', amount_cents: 9500 },
    { kind: 'electric', period_month: '2026-04-01', amount_cents: 16000 },
    { kind: 'water', period_month: '2026-03-01', amount_cents: 4000 },
    { kind: 'water', period_month: '2026-04-01', amount_cents: 4200 },
  ];

  it('annual run-rate is monthly total × 12', () => {
    // latest electric 16000 + latest water 4200 = 20200/mo
    expect(monthlyTotalCents(bills)).toBe(20200);
    expect(annualTotalCents(bills)).toBe(242400);
  });

  it('trailing average excludes the latest and needs ≥3 readings', () => {
    expect(trailingAvgCents(bills, 'electric')).toBe(10000); // (10000+10500+9500)/3
    expect(trailingAvgCents(bills, 'water')).toBeNull();      // only 2 readings
  });

  it('spikePct compares latest to trailing average, only when above', () => {
    expect(spikePct(bills, 'electric')).toBe(60); // 16000 vs 10000
    expect(spikePct(bills, 'water')).toBeNull();
  });

  it('summarizeUtilities ranks by cost and finds the biggest mover', () => {
    const s = summarizeUtilities(bills);
    expect(s.topCostKind).toBe('electric');
    expect(s.perKind[0].kind).toBe('electric');
    expect(s.biggestMover?.kind).toBe('electric');
    expect(s.monthlyTotalCents).toBe(20200);
  });

  it('deterministic findings flag a real spike as high severity, never fabricating', () => {
    const findings = deterministicSavingsFindings(bills);
    const elec = findings.find((f) => f.kind === 'electric')!;
    expect(elec.severity).toBe('high'); // 60% ≥ 40%
    expect(elec.title).toMatch(/60% above/);
    // water has no spike/jump and isn't the top cost → not flagged
    expect(findings.some((f) => f.kind === 'water')).toBe(false);
  });

  it('returns no findings for empty data', () => {
    expect(deterministicSavingsFindings([])).toEqual([]);
    expect(summarizeUtilities([]).topCostKind).toBeNull();
  });
});

describe('binder', () => {
  it('masks sensitive values', () => {
    expect(maskValue('supersecret', 2)).toBe('•••••••••et');
    expect(maskValue('ab', 2)).toBe('••');
    expect(maskValue('')).toBe('');
  });
  it('labels + groups by canonical category order', () => {
    expect(binderCategoryLabel('wifi')).toBe('Wi-Fi & Network');
    const items: InfoLike[] = [{ category: 'other', label: 'Z' }, { category: 'wifi', label: 'Router', sort: 1 }, { category: 'wifi', label: 'Guest', sort: 0 }];
    const g = groupByCategory(items);
    expect(g[0].category).toBe('wifi');
    expect(g[0].items.map((i) => i.label)).toEqual(['Guest', 'Router']);
    expect(g[g.length - 1].category).toBe('other');
  });
});

describe('security', () => {
  const events: EventLike[] = [
    { severity: 'critical', resolved: false, occurred_at: '2026-06-01T00:00:00Z' },
    { severity: 'warning', resolved: false, occurred_at: '2026-06-03T00:00:00Z' },
    { severity: 'info', resolved: true, occurred_at: '2026-06-05T00:00:00Z' },
  ];
  it('severity meta ranks', () => {
    expect(severityMeta('critical').rank).toBe(2);
    expect(severityMeta('info').tone).toBe('neutral');
  });
  it('open events sort first, newest first', () => {
    const s = sortEvents(events);
    expect(s[0].resolved).toBe(false);
    expect(s[2].resolved).toBe(true);
  });
  it('summarize', () => {
    expect(summarizeSecurity(events)).toEqual({ total: 3, open: 2, openCritical: 1, openWarning: 1, allClear: false });
  });
});

describe('devices', () => {
  const devices: DeviceLike[] = [
    { status: 'online', room: 'Kitchen' }, { status: 'offline', room: 'Kitchen' },
    { status: 'online', room: null }, { status: 'unknown', room: 'Garage' },
  ];
  it('summarize', () => {
    expect(summarizeDevices(devices)).toEqual({ total: 4, online: 2, offline: 1, unknown: 1 });
  });
  it('groups by room, Unassigned last', () => {
    const g = groupByRoom(devices);
    expect(g.map((x) => x.room)).toEqual(['Garage', 'Kitchen', 'Unassigned']);
  });
  it('integration label', () => { expect(integrationLabel('homekit')).toBe('Apple HomeKit'); });
});
