#!/usr/bin/env node
// Page audit — make a signed-in browser session to crawl the app with.
//
// Creates (or re-creates) a confirmed account through the Supabase admin API,
// signs in through the REAL login form, walks onboarding the way a person does,
// and saves the Playwright storageState for scripts/page-audit-crawl.mjs.
// Refuses anything but a local Supabase: the account it creates and deletes is
// disposable, and this must never point at production.
//
//   node scripts/page-audit-session.mjs --base http://localhost:3107 \
//     --email page-audit-parent@example.test --out parent.json

import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:3107');
const email = arg('email', 'page-audit-parent@example.test');
const password = arg('password', 'Page-Audit-2026!');
const out = arg('out', 'page-audit-parent.json');
const familyName = arg('family', 'Page Audit Family');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) {
  console.error(`Refusing: NEXT_PUBLIC_SUPABASE_URL (${url || 'unset'}) is not a local Supabase.`);
  process.exit(1);
}

const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });

async function recreateUser() {
  const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw listError;
  const old = list.users.find((u) => u.email === email);
  if (old) {
    const { data: members } = await admin.from('family_members').select('family_id').eq('user_id', old.id);
    for (const m of members ?? []) await admin.from('families').delete().eq('id', m.family_id);
    await admin.auth.admin.deleteUser(old.id);
  }
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: 'Casey Rivera' },
  });
  if (error) throw error;
  return data.user;
}

async function clickIf(page, role, name) {
  const target = page.getByRole(role, { name });
  if (await target.first().isVisible().catch(() => false)) { await target.first().click(); return true; }
  return false;
}

async function main() {
  const user = await recreateUser();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/login?redirect=/onboarding`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/onboarding|\/dashboard|\/home/, { timeout: 60_000 });

  // Onboarding, as tests/e2e/authenticated.spec.ts walks it. Each step is
  // tolerated if absent so a reordered flow does not stop the audit — but a
  // family must exist at the end, which is checked below rather than assumed.
  for (let step = 0; step < 12 && /\/onboarding/.test(page.url()); step++) {
    const familyField = page.getByLabel('Family name');
    if (await familyField.isVisible().catch(() => false)) await familyField.fill(familyName);
    if (await clickIf(page, 'button', 'Start exploring')) break;
    if (await clickIf(page, 'button', 'Continue')) { await page.waitForTimeout(600); continue; }
    if (await clickIf(page, 'button', /Skip/)) { await page.waitForTimeout(600); continue; }
    await page.waitForTimeout(800);
  }
  await page.goto(`${base}/dashboard`);
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

  const { data: members, error } = await admin.from('family_members').select('family_id, id, role').eq('user_id', user.id);
  if (error) throw error;
  if (!members?.length) throw new Error('Signed in, but no family was provisioned — the crawl would not be a real session.');
  await context.storageState({ path: out });
  await browser.close();
  writeFileSync(out.replace(/\.json$/, '.meta.json'), JSON.stringify({ email, userId: user.id, familyId: members[0].family_id, memberId: members[0].id, role: members[0].role }, null, 2));
  console.log(`Signed in as ${email} (${members[0].role}) in family ${members[0].family_id}; state → ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
