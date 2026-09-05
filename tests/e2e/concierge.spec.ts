// Ask Bubaly → run page, against the isolated Supabase with the scripted
// model (map §5 Phase 2, spec §45 "a request survives a refresh").
//
// Runs only when E2E_AUTHENTICATED=1 (the CI job that starts a local Supabase)
// AND the server was started with the provider stub (AI_PROVIDER_STUB=1 plus
// E2E_PROVIDER_STUB=1, because `next start` runs with NODE_ENV=production and
// the stub refuses to load there without the explicit e2e opt-in). The stub
// answers "Plan our week" from tests/ai-eval/scripts/plan_week.json, so the
// plan — and therefore the page — is the same on every run.
//
// The account is separate from authenticated.spec.ts (plus-addressed from the
// same E2E_AUTH_EMAIL) because the two specs run in parallel workers and each
// deletes and recreates its own user.
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

const enabled = process.env.E2E_AUTHENTICATED === '1' && process.env.AI_PROVIDER_STUB === '1';
const baseEmail = process.env.E2E_AUTH_EMAIL ?? '';
const email = process.env.E2E_CONCIERGE_EMAIL ?? (baseEmail ? baseEmail.replace('@', '+concierge@') : '');
const password = process.env.E2E_AUTH_PASSWORD ?? '';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const RUN_PAGE = /\/dashboard\/concierge\/runs\/[0-9a-f-]{36}$/;
/** The objective the scripted plan carries — the run page's H1. */
const PLAN_OBJECTIVE = 'Plan the week: conflicts, meals, prep, priorities and reminders.';

let admin: SupabaseClient | null = null;
let testUser: User | null = null;

function requireSafeEnvironment(): SupabaseClient {
  if (!email || !password || !supabaseUrl || !serviceRoleKey) {
    throw new Error('The concierge E2E requires E2E_AUTH_EMAIL, E2E_AUTH_PASSWORD, and Supabase credentials.');
  }
  const hostname = new URL(supabaseUrl).hostname;
  const local = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (!local && process.env.E2E_ALLOW_REMOTE_SUPABASE !== '1') {
    throw new Error(`Refusing to create E2E data in remote Supabase host ${hostname}.`);
  }
  return createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function findUser(client: SupabaseClient): Promise<User | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const found = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 100) break;
  }
  return null;
}

async function removeTestAccount(client: SupabaseClient): Promise<void> {
  const user = testUser ?? await findUser(client);
  if (!user) return;
  const { data: memberships, error: membershipError } = await client
    .from('family_members').select('family_id').eq('user_id', user.id);
  if (membershipError) throw membershipError;
  for (const familyId of [...new Set((memberships ?? []).map((row) => String(row.family_id)))]) {
    const { error } = await client.from('families').delete().eq('id', familyId);
    if (error) throw error;
  }
  const { error } = await client.auth.admin.deleteUser(user.id);
  if (error) throw error;
  testUser = null;
}

test.describe('Ask Bubaly concierge loop', () => {
  test.skip(!enabled, 'Set E2E_AUTHENTICATED=1 and AI_PROVIDER_STUB=1 to run the concierge journey against the isolated Supabase.');
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async () => {
    admin = requireSafeEnvironment();
    await removeTestAccount(admin);
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: 'Casey Rivera' },
    });
    if (error) throw error;
    testUser = data.user;
  });

  test.afterEach(async () => {
    if (admin) await removeTestAccount(admin);
    admin = null;
  });

  test('"Plan our week" lands on a run page that survives a reload', async ({ page }) => {
    test.setTimeout(120_000);
    // Sign in and take the fresh family through onboarding to the dashboard,
    // the same path authenticated.spec.ts pins. A new family is on its trial,
    // which is what grants the Basic-tier `ai-requests` feature.
    await page.goto('/login?redirect=/onboarding');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole('heading', { name: 'Create your profile' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Name your family' })).toBeVisible();
    await page.getByLabel('Family name').fill('Rivera Concierge Family');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'See your week come together' })).toBeVisible();
    await page.getByRole('button', { name: /Skip/ }).click();
    await expect(page.getByRole('heading', { name: 'About your family' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('heading', { name: 'Add your family' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('heading', { name: 'Protect your profile' })).toBeVisible();
    await page.getByRole('button', { name: /Skip/ }).click();
    await expect(page.getByRole('heading', { name: /all set, Casey/i })).toBeVisible();
    await page.getByRole('button', { name: 'Start exploring' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    // The scripted plan assigns a to-do to "Maya" — the same child the
    // in-memory loop test seeds. Onboarding skipped "Add your family", so add
    // her here; without her `tasks.createTodo` fails ("nobody called Maya")
    // and the run settles partially_completed.
    if (!admin || !testUser) throw new Error('E2E account was not initialized.');
    const { data: membership, error: membershipError } = await admin
      .from('family_members').select('family_id').eq('user_id', testUser.id).single();
    if (membershipError) throw membershipError;
    const familyId = String(membership.family_id);
    const { error: childError } = await admin.from('family_members').insert({
      family_id: familyId, user_id: null, display_name: 'Maya', role: 'child', is_active: true, birthday: '2016-03-02',
    });
    if (childError) throw childError;

    // The hero Ask bar on the dashboard files the request; the 202 carries the
    // run page to navigate to.
    const ask = page.getByRole('textbox', { name: 'How can I help your family?' });
    await expect(ask).toBeVisible();
    await ask.fill('Plan our week');
    await page.getByRole('button', { name: 'Ask Bubaly' }).click();

    await expect(page).toHaveURL(RUN_PAGE, { timeout: 30_000 });
    const runUrl = page.url();
    await expect(page.getByRole('heading', { level: 1, name: PLAN_OBJECTIVE })).toBeVisible();
    await expect(page.getByText('You asked: “Plan our week”')).toBeVisible();

    // The run is persisted, not held in client state: a full reload shows the
    // same page, and the rows behind it are under the family.
    await page.reload();
    await expect(page).toHaveURL(runUrl);
    await expect(page.getByRole('heading', { level: 1, name: PLAN_OBJECTIVE })).toBeVisible();
    await expect(page.getByText('You asked: “Plan our week”')).toBeVisible();

    const runId = runUrl.slice(runUrl.lastIndexOf('/') + 1);

    const { data: run, error: runError } = await admin
      .from('family_automation_runs').select('id, family_id, plan_id, request_id, state').eq('id', runId).single();
    if (runError) throw runError;
    expect(run.family_id).toBe(familyId);
    expect(run.plan_id).toBeTruthy();
    expect(run.request_id).toBeTruthy();

    const { count: stepCount, error: stepError } = await admin
      .from('ai_plan_steps').select('id', { count: 'exact', head: true }).eq('plan_id', run.plan_id).eq('family_id', familyId);
    if (stepError) throw stepError;
    expect(stepCount).toBeGreaterThanOrEqual(9);

    // The continuation runs after the response, on the server. Wait for the
    // executor to settle the run — the scripted plan ends in a mid-week
    // follow-up, so `scheduled_followup` is its finished state — and check the
    // household rows it leaves: three planned dinners.
    const TERMINAL = ['scheduled_followup', 'completed', 'partially_completed', 'failed', 'blocked', 'cancelled'];
    const deadline = Date.now() + 90_000;
    let state = '';
    while (Date.now() < deadline) {
      const { data, error } = await admin!.from('family_automation_runs').select('state').eq('id', runId).single();
      if (error) throw error;
      state = data.state;
      if (TERMINAL.includes(state)) break;
      await page.waitForTimeout(1_500);
    }
    if (!/^(scheduled_followup|completed)$/.test(state)) {
      // Say what went wrong, not just that it did: the failing step's tool and
      // error are the whole diagnosis when this only reproduces in CI.
      const { data: steps } = await admin!.from('ai_plan_steps').select('sequence, tool_name, status, error').eq('plan_id', run.plan_id).order('sequence');
      const { data: events } = await admin!.from('ai_run_events').select('event_type, message').eq('run_id', runId).order('created_at');
      throw new Error(`run ${runId} settled in "${state}"\nsteps: ${JSON.stringify(steps)}\nevents: ${JSON.stringify(events)}`);
    }

    await expect.poll(async () => {
      const { count, error } = await admin!
        .from('meal_plans').select('id', { count: 'exact', head: true }).eq('family_id', familyId);
      if (error) throw error;
      return count;
    }).toBe(3);

    // And the page reflects the finished run after one more reload.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: PLAN_OBJECTIVE })).toBeVisible();
    await expect(page.getByText(/\d+ of \d+ steps completed/).first()).toBeVisible();
  });
});
