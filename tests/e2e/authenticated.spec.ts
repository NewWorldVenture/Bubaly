import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const enabled = process.env.E2E_AUTHENTICATED === '1';
const baseEmail = process.env.E2E_AUTH_EMAIL ?? '';
const password = process.env.E2E_AUTH_PASSWORD ?? '';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

let admin: SupabaseClient | null = null;
let testUser: User | null = null;
let email = '';

// Projects/workers/retries may overlap. Never clean up the shared base email
// or reuse another attempt's account while its requests are still in flight.
function allocateFixtureEmail(project: string, parallelIndex: number): string {
  const match = /^([^@\s]+)@([^@\s]+)$/.exec(baseEmail);
  if (!match) throw new Error('Authenticated E2E requires a valid E2E_AUTH_EMAIL.');
  const identity = createHash('sha256').update(JSON.stringify([baseEmail, project, parallelIndex, randomUUID()])).digest('hex').slice(0, 40);
  return `e2e-auth-${identity}@${match[2]}`;
}

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
  if (!email) return;
  const user = testUser ?? await findUser(client);
  if (!user) return;
  if (user.email?.toLowerCase() !== email.toLowerCase()) throw new Error('Refusing to delete an account outside this E2E fixture');

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

  test.beforeEach(async ({}, testInfo) => {
    email = allocateFixtureEmail(testInfo.project.name, testInfo.parallelIndex);
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
    try { if (admin) await removeTestAccount(admin); }
    finally { admin = null; testUser = null; email = ''; }
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
    // Exact: the Ask Bubaly chips now include "Help us save money", whose
    // accessible name would otherwise match a substring search for Save.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
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
      const anonymous = createClient(supabaseUrl, publicKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      for (const client of [anonymous, member]) {
        const { error } = await client.rpc('claim_ai_runs', { p_limit: 1, p_lease_seconds: 30 });
        expect(error?.code, 'Only the server worker may claim AI jobs').toBe('42501');
      }
      const familyId = membership.family_id;
      const { data: plan, error: planError } = await service.from('ai_plans')
        .insert({ family_id: familyId, objective: 'Isolated permission probe' }).select('id').single();
      if (planError) throw planError;
      const run = { family_id: familyId, trigger_type: 'plan_accepted', created_by: user.id, summary: 'Isolated permission probe' };
      const { data: otherMember, error: otherMemberError } = await service.from('family_members')
        .insert({ family_id: familyId, user_id: null, display_name: 'Probe child', role: 'child' }).select('id').single();
      if (otherMemberError) throw otherMemberError;
      const otherMemberId = otherMember.id;
      const approval = { family_id: familyId, domain: 'calendar', title: 'Isolated permission probe' };
      const request = { family_id: familyId, requested_by: user.id, requested_by_member_id: membership.id };
      const forbidden: Array<[string, Record<string, unknown>]> = [
        ['family_automation_runs', { ...run, state: 'ready', status: 'approved' }],
        ['family_automation_runs', { ...run, state: 'queued', plan_id: plan.id }],
        ['family_automation_runs', { ...run, state: 'queued', requested_by_member_id: membership.id }],
        ['family_automation_runs', { ...run, created_by: null }],
        ['approval_requests', { ...approval, status: 'approved' }],
        ['approval_requests', { ...approval, approvals: [{ member_id: membership.id, decision: 'approved' }] }],
        // 0255: a member cannot file a request as Bubaly (the column default),
        // about somebody else, or one that carries the fields decide() executes.
        ['approval_requests', approval],
        ['approval_requests', { ...approval, requested_by_kind: 'member', requested_by_member_id: otherMemberId }],
        ['approval_requests', { ...approval, requested_by_kind: 'member', run_id: null, plan_step_ids: [plan.id] }],
        ['approval_requests', { ...approval, requested_by_kind: 'member', payload_kind: 'tool' }],
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
        ['approval_requests', { ...approval, requested_by_kind: 'member', requested_by_member_id: membership.id }],
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

      await test.step('wallet money writes require a manager even when legacy policies existed', async () => {
        if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(supabaseUrl).hostname)) {
          throw new Error('Wallet role probes are restricted to isolated local Supabase.');
        }
        const credit = {
          family_id: familyId, type: 'adjustment', direction: 'credit', status: 'completed',
          amount_cents: 100, created_by: user.id, description: 'Isolated permission probe',
        };
        const { data: transaction, error: createError } = await member.from('wallet_transactions')
          .insert(credit).select('id').single();
        if (createError) throw createError;
        const { error: childRoleError } = await service.from('family_members')
          .update({ role: 'child' }).eq('id', membership.id);
        if (childRoleError) throw childRoleError;
        try {
          const { error: mintError } = await member.from('wallet_transactions').insert(credit);
          expect(mintError?.code, 'Children cannot mint completed wallet credits').toBe('42501');
          const { data: changed, error: changeError } = await member.from('wallet_transactions')
            .update({ amount_cents: 9999 }).eq('id', transaction.id).select('id');
          expect(changeError).toBeNull();
          expect(changed).toEqual([]);
          const { data: deleted, error: deleteError } = await member.from('wallet_transactions')
            .delete().eq('id', transaction.id).select('id');
          expect(deleteError).toBeNull();
          expect(deleted).toEqual([]);
          const { data: visible, error: readError } = await member.from('wallet_transactions')
            .select('amount_cents').eq('id', transaction.id).single();
          expect(readError).toBeNull();
          expect(Number(visible?.amount_cents)).toBe(100);
          const { error: serverCreditError } = await service.from('wallet_transactions')
            .insert({ ...credit, amount_cents: 75 });
          expect(serverCreditError).toBeNull();
        } finally {
          const { error: restoreError } = await service.from('family_members')
            .update({ role: 'parent' }).eq('id', membership.id);
          if (restoreError) throw restoreError;
        }
        const { data: managerChange, error: managerError } = await member.from('wallet_transactions')
          .update({ amount_cents: 125 }).eq('id', transaction.id).select('amount_cents').single();
        expect(managerError).toBeNull();
        expect(Number(managerChange?.amount_cents)).toBe(125);
      });
    });
  });
});
