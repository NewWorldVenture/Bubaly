import { afterEach, describe, expect, it, vi } from 'vitest';
import { billSchedulePatch, BillScheduleConfirmationRequired, type BillScheduleChoice } from '@/lib/finance/bill-schedule';
import { saveBillSchedule } from '@/lib/finance/bills';
import { buildCashflowTimeline } from '@/lib/finance/timeline';
import { isDueDayNotKept } from '@/lib/finance/recurring';
import { bill, store } from './helpers/recurring-bill-store';

const ui = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, action: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => { const index = ui.cursor++; if (!(index in ui.slots)) ui.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [ui.slots[index], (value: unknown) => { ui.slots[index] = typeof value === 'function' ? value(ui.slots[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = ui.cursor++; return ui.slots[index] ??= { current: initial }; },
  // Deliberately delay passive cleanup: scope validity must work BEFORE it runs.
  useEffect: () => {},
}));
vi.mock('@/app/(app)/dashboard/billing/actions', () => ({ confirmBillScheduleAction: ui.action }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: ui.success, error: ui.error }) }));
import { BillScheduleModal } from '@/components/finance/bill-schedule-modal';
afterEach(() => vi.unstubAllGlobals());

describe('explicit schedule-only bill repair', () => {
  it('recovers the forecast while keeping the unpaid current occurrence and original snapshot fields', async () => {
    const row = bill({ due_date: '2026-03-28', due_day: null, status: 'overdue' }), db = store(row);
    const forecast = (value: typeof row) => buildCashflowTimeline({ bills: [value], goals: [], events: [], startingBalance: 1000, now: new Date('2026-03-01T12:00:00Z'), horizonWeeks: 20 });
    expect(() => forecast(row)).toThrow(BillScheduleConfirmationRequired);
    const result = await saveBillSchedule(db.client, row.family_id, row, { cadence: 'monthly', dueDay: 31 });
    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ id: row.id }]);
    expect(db.current()).toMatchObject({ ...row, due_day: 31, updated_at: '2026-02-01T00:00:00Z' });
    expect(db.requests[0].patch).toEqual({ due_date: '2026-03-28', recurrence: 'monthly', due_day: 31 });
    expect(db.requests[0].patch).not.toHaveProperty('status');
    expect(forecast(db.current()).weeks.flatMap(week => week.moments).slice(0, 4).map(moment => moment.date)).toEqual(['2026-03-28', '2026-04-30', '2026-05-31', '2026-06-30']);
    for (const key of ['updated_at', 'due_date', 'status', 'is_recurring', 'recurrence', 'due_day']) expect(db.requests[0].url.searchParams.has(key)).toBe(true);
  });
  it.each(['monthly', 'quarterly', 'yearly'] as const)('requires an explicit day for unknown %s schedules', cadence => {
    const row = bill({ due_date: '2026-02-28', recurrence: null });
    for (const dueDay of [undefined, 0, 32, 2.5, NaN]) expect(billSchedulePatch(row, { cadence, dueDay })).toBeNull();
    expect(billSchedulePatch(row, { cadence, dueDay: 31 })).toEqual({ due_date: row.due_date, recurrence: cadence, due_day: 31 });
  });
  it.each(['weekly', 'biweekly'] as const)('confirms %s explicitly and clears obsolete monthly anchor without changing status/date', async cadence => {
    const row = bill({ due_day: 31 }), db = store(row);
    expect((await saveBillSchedule(db.client, row.family_id, row, { cadence })).error).toBeNull();
    expect(db.current()).toMatchObject({ due_date: row.due_date, status: row.status, recurrence: cadence, due_day: null });
    expect(billSchedulePatch(row, { cadence, dueDay: 31 })).toBeNull();
  });
  it.each(['2026-02-28', '2026-04-30', '2026-03-28'])('refuses to hide a selected 31st in an old-schema date %s', async due_date => {
    const row = bill({ due_date }), db = store(row, true);
    const result = await saveBillSchedule(db.client, row.family_id, row, { cadence: 'monthly', dueDay: 31 });
    expect(isDueDayNotKept(result.error)).toBe(true);
    expect(db.requests).toHaveLength(1);
    expect(db.current()).toEqual(row);
  });
  it.each([15, 31])('old-schema safe retry retains proven current day %s with identical snapshot predicates', async dueDay => {
    const row = bill({ due_date: `2026-03-${dueDay}` }), db = store(row, true);
    expect((await saveBillSchedule(db.client, row.family_id, row, { cadence: 'monthly', dueDay })).error).toBeNull();
    expect(db.requests).toHaveLength(2);
    expect(db.requests[1].patch).not.toHaveProperty('due_day');
    expect(db.requests[1].url.search).toBe(db.requests[0].url.search);
    expect(db.current()).toMatchObject({ due_date: row.due_date, status: row.status });
  });
  it.each([
    { amount: 200, updated_at: '2026-01-02T00:00:00Z' },
    { due_date: '2026-02-28', updated_at: '2026-01-02T00:00:00Z' },
    { status: 'paid' as const, updated_at: '2026-01-02T00:00:00Z' },
    { recurrence: 'weekly', updated_at: '2026-01-02T00:00:00Z' },
    { due_day: 30, updated_at: '2026-01-02T00:00:00Z' },
  ])('a competing edit refuses CAS without altering the new row %j', async change => {
    const row = bill(), changed = bill(change), db = store(changed);
    expect((await saveBillSchedule(db.client, row.family_id, row, { cadence: 'monthly', dueDay: 31 })).data).toEqual([]);
    expect(db.current()).toEqual(changed);
  });
  it('only one of two simultaneous confirmations can change the snapshot', async () => {
    const row = bill(), db = store(row);
    const results = await Promise.all([31, 30].map(dueDay => saveBillSchedule(db.client, row.family_id, row, { cadence: 'monthly', dueDay })));
    expect(results.filter(result => Array.isArray(result.data) && result.data.length === 1)).toHaveLength(1);
    expect(db.current().due_date).toBe(row.due_date);
    expect(db.current().status).toBe(row.status);
  });
  it.each([
    { family_id: 'other-family' }, { updated_at: '' }, { is_recurring: false }, { due_date: '2026-02-30' },
  ])('refuses invalid or foreign snapshots before SDK writes %j', async over => {
    const row = bill(over), db = store(row);
    expect((await saveBillSchedule(db.client, 'synthetic-family', row, { cadence: 'monthly', dueDay: 31 })).data).toBeNull();
    expect(db.requests).toEqual([]);
  });
  it('does not guess missing or forged choices and does not downgrade authorization failures', async () => {
    const row = bill();
    for (const choice of [undefined, {}, { cadence: 'semimonthly', dueDay: 31 }]) expect(billSchedulePatch(row, choice as BillScheduleChoice)).toBeNull();
    const refusal = { code: '42501', message: 'synthetic policy refusal' }, db = store(row, false, refusal);
    expect((await saveBillSchedule(db.client, row.family_id, row, { cadence: 'monthly', dueDay: 31 })).error).toEqual(refusal);
    expect(db.requests).toHaveLength(1);
    expect(db.current()).toEqual(row);
  });
});

describe('actual modal retained-handler lifecycle before passive cleanup', () => {
  type Element = { props: { children: Element[] | Element | ((id: string) => Element); onSubmit: (event: { preventDefault(): void }) => Promise<void>; onChange: (event: { target: { value: string } }) => void } };
  function mount() {
    ui.slots = []; ui.action.mockReset(); ui.success.mockReset(); ui.error.mockReset();
    const state = { current: true }, done = vi.fn(), close = vi.fn();
    function render() {
      ui.cursor = 0;
      const modal = BillScheduleModal({ bill: bill({ due_date: '2026-03-28' }), isCurrent: () => state.current, onDone: done, onClose: close }) as unknown as Element;
      return modal.props.children as Element;
    }
    const initial = render(), day = (initial.props.children as Element[])[4];
    (day.props.children as (id: string) => Element)('synthetic-day').props.onChange({ target: { value: '31' } });
    const form = render();
    return { state, done, close, submit: () => form.props.onSubmit({ preventDefault() {} }) };
  }
  function pending() { let resolve!: (value: unknown) => void; const promise = new Promise(resolveValue => { resolve = resolveValue; }); return { promise, resolve }; }
  it('retained submit refuses a revoked owner ticket synchronously without invoking the server', async () => {
    const host = mount(); host.state.current = false;
    await host.submit(); expect(ui.action).not.toHaveBeenCalled(); expect(host.close).not.toHaveBeenCalled();
  });
  it('two submits before rerender invoke the server once and retain normal success', async () => {
    const host = mount(), reply = pending(); ui.action.mockReturnValue(reply.promise);
    const one = host.submit(), two = host.submit(); expect(ui.action).toHaveBeenCalledTimes(1);
    reply.resolve({ ok: true, id: 'synthetic-bill' }); await Promise.all([one, two]);
    expect(ui.success).toHaveBeenCalledTimes(1); expect(host.done).toHaveBeenCalledTimes(1); expect(host.close).toHaveBeenCalledTimes(1);
  });
  it.each([{ ok: true, id: 'synthetic-bill' }, { ok: false, error: 'needs code', stepUp: '/auth/step-up' }])('a revoked ticket blocks late effects before cleanup: %j', async result => {
    const host = mount(), reply = pending(), assign = vi.fn(); ui.action.mockReturnValue(reply.promise);
    vi.stubGlobal('window', { location: { assign, pathname: '/dashboard/bills', search: '' } });
    const work = host.submit(); host.state.current = false; reply.resolve(result); await work;
    expect(ui.success).not.toHaveBeenCalled(); expect(ui.error).not.toHaveBeenCalled(); expect(assign).not.toHaveBeenCalled();
    expect(host.done).not.toHaveBeenCalled(); expect(host.close).not.toHaveBeenCalled();
  });
});
