// The marketing surveys' three server actions
// (app/(app)/admin/marketing/surveys/actions.ts), called as every kind of
// caller with valid input.
//
// THE POLICY. A survey is shown to the public once it is active, and running
// one is a site-admin tool: each action opens with requireMarketingAdmin
// (lib/marketing/admin.ts:76-87), which refuses a signed-out caller (401),
// anyone who is not a super admin (403) and a super admin who still owes their
// two-step code (403). No household role is a platform admin. `surveys` is
// site-wide, not family data, so there is no "other family" id to reach.
//
// WHAT IS ASSERTED: a super admin's create writes one draft with the type's
// defaults and sends them to it, a status change writes that status, a delete
// soft-deletes and returns them to the list, each with one audit row; every
// other caller is refused by the gate, is not redirected, and nothing changes.
// The scale is not pinned: the page's form (surveys/page.tsx:96-117) sends no
// scale_min/scale_max, and the action's n() reads Number(null) as 0, so a new
// NPS survey is written 0..0 instead of the type's 0..10. Reported as a defect
// in the audit PR, not pinned here.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN } from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn(), redirect: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { h.redirect(to); throw new Error(`NEXT_REDIRECT:${to}`); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

const { createSurveyAction, setSurveyStatusAction, deleteSurveyAction } = await import('@/app/(app)/admin/marketing/surveys/actions');

const CREATE = 'ACTION-5A26CD60D3B6';
const STATUS = 'ACTION-D65DABB27735';
const DELETE = 'ACTION-98E650226197';

const SURVEY_ID = 'c0000000-0000-4000-8000-0000000000c1';

let db: InMemorySupabase;

beforeEach(() => {
  h.revalidatePath.mockReset();
  h.redirect.mockReset();
  db = newAdminWorld();
  db.seed('surveys', [{
    id: SURVEY_ID, slug: 'onboarding-abc123', name: 'Onboarding', type: 'csat', question: 'How was setup?',
    scale_min: 1, scale_max: 5, status: 'draft', deleted_at: null,
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function createForm(): FormData {
  const fd = new FormData();
  fd.set('type', 'nps');
  fd.set('name', 'Spring NPS');
  return fd;
}

describe(`${CREATE} createSurveyAction`, () => {
  it(`${CREATE} a super admin creates a draft NPS survey and is sent to it`, async () => {
    signInAs({ kind: 'super_admin' });
    await expect(createSurveyAction(createForm())).rejects.toThrow(/^NEXT_REDIRECT:\/admin\/marketing\/surveys\//);
    const created = db.table('surveys').filter((row) => row.id !== SURVEY_ID);
    expect(created).toEqual([expect.objectContaining({
      name: 'Spring NPS', type: 'nps', status: 'draft', low_label: 'Not at all likely', high_label: 'Extremely likely',
      question: 'How likely are you to recommend Bubaly to a friend or colleague?', created_by: SUPER_ADMIN.id,
      slug: expect.stringMatching(/^spring-nps-[a-z0-9]+$/),
    })]);
    expect(h.redirect).toHaveBeenCalledWith(`/admin/marketing/surveys/${String(created[0].id)}`);
    expect(db.table('marketing_audit_logs').map((a) => [a.action, a.actor_id, a.resource_id])).toEqual([
      ['create', SUPER_ADMIN.id, created[0].id],
    ]);
  });

  it.each(REFUSED_CALLERS)(`${CREATE} $label is refused and no survey is created`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(createSurveyAction(createForm())).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('surveys')).toHaveLength(1);
    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe(`${STATUS} setSurveyStatusAction`, () => {
  it(`${STATUS} a super admin opens, then closes, a survey`, async () => {
    signInAs({ kind: 'super_admin' });
    await setSurveyStatusAction(SURVEY_ID, 'active');
    expect(db.table('surveys')[0].status).toBe('active');
    await setSurveyStatusAction(SURVEY_ID, 'closed');
    expect(db.table('surveys')[0].status).toBe('closed');
    expect(db.table('marketing_audit_logs').map((a) => [a.action, a.actor_id, a.metadata])).toEqual([
      ['update', SUPER_ADMIN.id, { status: 'active' }],
      ['update', SUPER_ADMIN.id, { status: 'closed' }],
    ]);
  });

  it.each(REFUSED_CALLERS)(`${STATUS} $label is refused and the survey stays a draft`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(setSurveyStatusAction(SURVEY_ID, 'active')).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('surveys')[0].status).toBe('draft');
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe(`${DELETE} deleteSurveyAction`, () => {
  it(`${DELETE} a super admin soft-deletes a survey and is returned to the list`, async () => {
    signInAs({ kind: 'super_admin' });
    await expect(deleteSurveyAction(SURVEY_ID)).rejects.toThrow('NEXT_REDIRECT:/admin/marketing/surveys');
    expect(db.table('surveys')).toEqual([expect.objectContaining({ id: SURVEY_ID, deleted_at: expect.any(String) })]);
    expect(db.table('marketing_audit_logs').map((a) => [a.action, a.actor_id, a.resource_id])).toEqual([
      ['delete', SUPER_ADMIN.id, SURVEY_ID],
    ]);
  });

  it.each(REFUSED_CALLERS)(`${DELETE} $label is refused and the survey stays`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(deleteSurveyAction(SURVEY_ID)).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('surveys')[0].deleted_at).toBeNull();
    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
