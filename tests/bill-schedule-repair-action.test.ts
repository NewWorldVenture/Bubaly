import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bill, store } from './helpers/recurring-bill-store';
import { createClient } from '@supabase/supabase-js';
import { renderToStaticMarkup } from 'react-dom/server';
import { BillScheduleConfirmationRequired } from '@/lib/finance/bill-schedule';
const h = vi.hoisted(() => ({ role: 'parent', familyId: 'synthetic-family', db: null as unknown, auth: true, stepUp: false, revalidated: [] as string[], clientReads: 0, forecastError: null as unknown }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => h.revalidated.push(path) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' } }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/finance/timeline-load', () => ({ loadMoneyTimeline: async () => { throw h.forecastError; } }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => {
  if (!h.auth) throw new Error('synthetic unauthenticated redirect');
  return { user: { id: 'synthetic-user' }, active: { familyId: h.familyId, role: h.role, member: { id: 'synthetic-member' }, family: { timezone: 'UTC' } } };
} }));
vi.mock('@/lib/auth/require-aal2', () => ({ requireAal2: async () => {}, aal2Verdict: async () => h.stepUp ? { action: 'step_up', to: '/auth/step-up?next=%2Fdashboard%2Fbilling', reason: 'needs_code' } : { action: 'allow' } }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => { h.clientReads++; return h.db; } }));
vi.mock('@/lib/services/finances', () => ({
  contributeToSavingsGoal() { throw new Error('Unexpected savings write'); }, createSavingsGoal() { throw new Error('Unexpected savings write'); },
  createTransaction() { throw new Error('Unexpected transaction write'); }, deleteBudget() { throw new Error('Unexpected budget write'); },
  deleteSavingsGoal() { throw new Error('Unexpected savings write'); }, deleteTransaction() { throw new Error('Unexpected transaction write'); }, updateBudget() { throw new Error('Unexpected budget write'); },
}));
import { confirmBillScheduleAction } from '@/app/(app)/dashboard/billing/actions';
import MoneyTimelinePage from '@/app/(app)/dashboard/money-timeline/page';
beforeEach(() => { h.role = 'parent'; h.familyId = 'synthetic-family'; h.auth = true; h.stepUp = false; h.revalidated = []; h.clientReads = 0; });
describe('schedule repair server action authorization and receipt', () => {
  it.each(['parent', 'adult'])('allows %s explicit confirmation and revalidates all three bill/forecast surfaces', async role => {
    h.role = role;
    const row = bill({ due_date: '2026-03-28', due_day: null }), db = store(row); h.db = db.client;
    expect(await confirmBillScheduleAction(row, { cadence: 'monthly', dueDay: 31 })).toEqual({ ok: true, id: row.id });
    expect(db.current()).toMatchObject({ due_date: row.due_date, status: row.status, due_day: 31 });
    expect(db.requests[0].url.searchParams.get('family_id')).toBe(`eq.${h.familyId}`);
    expect(h.revalidated).toEqual(['/dashboard/bills', '/dashboard/billing', '/dashboard/money-timeline']);
  });
  it.each(['teen', 'child', 'caregiver', 'guest', 'system', 'owner', ''])('refuses non-manager %s without a bill SDK request', async role => {
    h.role = role; const row = bill(), db = store(row); h.db = db.client;
    expect(await confirmBillScheduleAction(row, { cadence: 'monthly', dueDay: 31 })).toEqual({ ok: false, error: 'bills.scheduleManagersOnly' });
    expect(db.requests).toEqual([]); expect(h.revalidated).toEqual([]);
  });
  it('requires the server money step-up before any client creation/write', async () => {
    h.stepUp = true;
    const row = bill(), db = store(row); h.db = db.client;
    expect(await confirmBillScheduleAction(row, { cadence: 'monthly', dueDay: 31 })).toMatchObject({ ok: false, stepUp: expect.stringContaining('/auth/step-up') });
    expect(h.clientReads).toBe(0); expect(db.requests).toEqual([]); expect(h.revalidated).toEqual([]);
  });
  it('keeps unauthenticated redirects outside the generic save failure', async () => {
    h.auth = false;
    await expect(confirmBillScheduleAction(bill(), { cadence: 'monthly', dueDay: 31 })).rejects.toThrow('synthetic unauthenticated redirect');
    expect(h.clientReads).toBe(0); expect(h.revalidated).toEqual([]);
  });
  it('server active family defeats a forged snapshot even with a real ID/stamp', async () => {
    const row = bill(), db = store(row); h.db = db.client; h.familyId = 'other-family';
    expect(await confirmBillScheduleAction(row, { cadence: 'monthly', dueDay: 31 })).toEqual({ ok: false, error: 'bills.scheduleNotSaved' });
    expect(db.requests).toEqual([]); expect(db.current()).toEqual(row); expect(h.revalidated).toEqual([]);
  });
  it('forged family match cannot write a foreign stored row through the active-family predicate', async () => {
    const row = bill(), db = store({ ...row, family_id: 'other-family' }); h.db = db.client;
    expect(await confirmBillScheduleAction(row, { cadence: 'monthly', dueDay: 31 })).toEqual({ ok: false, error: 'bills.scheduleChanged' });
    expect(db.current().family_id).toBe('other-family'); expect(db.requests).toHaveLength(1); expect(h.revalidated).toEqual([]);
  });
  it('a stale timestamp refuses confirmation and revalidation', async () => {
    const row = bill(), changed = bill({ amount: 200, updated_at: '2026-01-02T00:00:00Z' }), db = store(changed); h.db = db.client;
    expect(await confirmBillScheduleAction(row, { cadence: 'monthly', dueDay: 31 })).toEqual({ ok: false, error: 'bills.scheduleChanged' });
    expect(db.current()).toEqual(changed); expect(h.revalidated).toEqual([]);
  });
  it('old-schema ambiguity has a translated refusal and no guessed date/payment', async () => {
    const row = bill({ due_date: '2026-02-28' }), db = store(row, true); h.db = db.client;
    expect(await confirmBillScheduleAction(row, { cadence: 'monthly', dueDay: 31 })).toEqual({ ok: false, error: 'bills.scheduleUnavailable' });
    expect(db.current()).toEqual(row); expect(db.requests).toHaveLength(1); expect(h.revalidated).toEqual([]);
  });
  it.each([null, {}, { recurrence: 'monthly' }, { cadence: 'monthly' }, { cadence: 'monthly', dueDay: 0 }])('invalid confirmation %j produces no update', async input => {
    const row = bill(), db = store(row); h.db = db.client;
    const result = await confirmBillScheduleAction(row, input as Parameters<typeof confirmBillScheduleAction>[1]);
    expect(result.ok).toBe(false); expect(db.requests).toEqual([]); expect(h.revalidated).toEqual([]);
  });
  it.each([null, {}, { id: 'synthetic-bill' }, [], [{ id: 'wrong' }], [{ id: 'synthetic-bill' }, { id: 'synthetic-bill' }]])('refuses unconfirmed SDK update receipts %j', async body => {
    h.db = createClient('https://synthetic.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async () => Response.json(body) } });
    expect(await confirmBillScheduleAction(bill(), { cadence: 'monthly', dueDay: 31 })).toEqual({ ok: false, error: 'bills.scheduleChanged' });
    expect(h.revalidated).toEqual([]);
  });
  it('the actual forecast page offers a bill-manager recovery link for schedule confirmation only', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      h.forecastError = new BillScheduleConfirmationRequired();
      const repair = renderToStaticMarkup(await MoneyTimelinePage());
      expect(repair).toContain('href="/dashboard/bills"');
      expect(repair).toContain('bills.scheduleForecastNeedsConfirmation');
      h.forecastError = new Error('synthetic transport error');
      const outage = renderToStaticMarkup(await MoneyTimelinePage());
      expect(outage).not.toContain('href="/dashboard/bills"');
      expect(outage).toContain('moneyTimeline.couldNotLoadYourMoney');
    } finally { spy.mockRestore(); }
  });
});
