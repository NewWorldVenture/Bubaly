import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

const enabled = process.env.E2E_AUTHENTICATED === '1';
const email = process.env.E2E_AUTH_EMAIL ?? '';
const password = process.env.E2E_AUTH_PASSWORD ?? '';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

let admin: SupabaseClient | null = null;
let testUser: User | null = null;

function requireSafeEnvironment(): SupabaseClient {
  if (!email || !password || !supabaseUrl || !serviceRoleKey) {
    throw new Error('Authenticated E2E requires E2E_AUTH_EMAIL, E2E_AUTH_PASSWORD, and Supabase credentials.');
  }

  const hostname = new URL(supabaseUrl).hostname;
  const local = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (!local && process.env.E2E_ALLOW_REMOTE_SUPABASE !== '1') {
    throw new Error(`Refusing to create E2E data in remote Supabase host ${hostname}.`);
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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
    .from('family_members')
    .select('family_id')
    .eq('user_id', user.id);
  if (membershipError) throw membershipError;

  const familyIds = [...new Set((memberships ?? []).map((row) => String(row.family_id)))];
  for (const familyId of familyIds) {
    const { error } = await client.from('families').delete().eq('id', familyId);
    if (error) throw error;
  }

  const { error } = await client.auth.admin.deleteUser(user.id);
  if (error) throw error;
  testUser = null;
}

test.describe('authenticated first-value journey', () => {
  test.skip(!enabled, 'Set E2E_AUTHENTICATED=1 to run the isolated Supabase journey.');
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async () => {
    admin = requireSafeEnvironment();
    await removeTestAccount(admin);
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'Casey Rivera' },
    });
    if (error) throw error;
    testUser = data.user;
  });

  test.afterEach(async () => {
    if (admin) await removeTestAccount(admin);
    admin = null;
  });

  test('signs in, completes onboarding, and persists a first task', async ({ page }) => {
    await page.goto('/login?redirect=/onboarding');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole('heading', { name: 'Create your profile' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Name your family' })).toBeVisible();
    await page.getByLabel('Family name').fill('Rivera E2E Family');
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

    await page.getByRole('button', { name: 'Quick capture' }).click();
    await page.getByLabel('Task').fill('Pack lunches for tomorrow');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Task saved')).toBeVisible();

    if (!admin || !testUser) throw new Error('E2E account was not initialized.');
    const { data: membership, error: membershipError } = await admin
      .from('family_members')
      .select('family_id, id')
      .eq('user_id', testUser.id)
      .single();
    if (membershipError) throw membershipError;

    await expect.poll(async () => {
      const { count, error } = await admin!
        .from('todo_items')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', membership.family_id)
        .eq('title', 'Pack lunches for tomorrow');
      if (error) throw error;
      return count;
    }).toBe(1);

    await test.step('database rejects forged AI execution and approval authority', async () => {
      const service = admin!;
      const user = testUser!;
      const publicKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
      if (!publicKey) throw new Error('The isolated RLS checks require a public Supabase key.');
      const member = createClient(supabaseUrl, publicKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: signInError } = await member.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      const familyId = membership.family_id;
      const { data: plan, error: planError } = await service.from('ai_plans')
        .insert({ family_id: familyId, objective: 'Isolated permission probe' }).select('id').single();
      if (planError) throw planError;
      const run = { family_id: familyId, trigger_type: 'plan_accepted', created_by: user.id, summary: 'Isolated permission probe' };
      const approval = { family_id: familyId, domain: 'calendar', title: 'Isolated permission probe' };
      const request = { family_id: familyId, requested_by: user.id, requested_by_member_id: membership.id };
      const forbidden: Array<[string, Record<string, unknown>]> = [
        ['family_automation_runs', { ...run, state: 'ready', status: 'approved' }],
        ['family_automation_runs', { ...run, state: 'queued', plan_id: plan.id }],
        ['family_automation_runs', { ...run, state: 'queued', requested_by_member_id: membership.id }],
        ['approval_requests', { ...approval, status: 'approved' }],
        ['approval_requests', { ...approval, approvals: [{ member_id: membership.id, decision: 'approved' }] }],
        ['parent_approvals', { family_id: familyId, kind: 'allowance_request', requested_by: user.id, status: 'approved' }],
        ['ai_requests', { ...request, status: 'completed' }],
        ['ai_requests', { ...request, prompt_tokens: -100 }],
      ];
      for (const [table, row] of forbidden) {
        const { error } = await member.from(table).insert(row);
        expect(error?.code, `${table} must reject forged authority`).toBe('42501');
      }

      const allowed: Array<[string, Record<string, unknown>]> = [
        ['family_automation_runs', { ...run, status: 'pending' }],
        ['family_automation_runs', { ...run, status: 'executed' }],
        ['approval_requests', approval],
        ['parent_approvals', { family_id: familyId, kind: 'allowance_request', requested_by: user.id }],
        ['ai_requests', request],
      ];
      for (const [table, row] of allowed) {
        const { error } = await member.from(table).insert(row);
        expect(error, `${table} must preserve ordinary request creation`).toBeNull();
      }

      // The trusted executor may persist runtime-linked work. Leave it paused
      // so this isolated test never schedules or executes any household action.
      const { error: trustedError } = await service.from('family_automation_runs')
        .insert({ ...run, plan_id: plan.id, requested_by_member_id: membership.id, state: 'paused' });
      expect(trustedError).toBeNull();
    });
  });
});
