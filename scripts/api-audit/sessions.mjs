#!/usr/bin/env node
// API audit — make the four callers the sweep uses: signed out, a child, a
// parent, and a parent who is also a super admin. Local Supabase ONLY: the
// accounts it creates and deletes are disposable.
//
// Parents come from scripts/page-audit-session.mjs (the real sign-in form and
// the real onboarding), so their families are provisioned the way a person's
// is. The child is a `child` member of the parent's family with its own auth
// user, signed in with supabase-js and turned into the same SSR cookies the
// app sets, through @supabase/ssr itself.
//
//   node scripts/api-audit/sessions.mjs --base http://localhost:3107 --out api-sessions.json

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:3107');
const out = arg('out', 'api-sessions.json');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) {
  console.error(`Refusing: NEXT_PUBLIC_SUPABASE_URL (${url || 'unset'}) is not a local Supabase.`);
  process.exit(1);
}
const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });
const dir = mkdtempSync(path.join(tmpdir(), 'api-audit-'));

function cookieHeaderFromState(file) {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  return state.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function parent(email, family) {
  const state = path.join(dir, `${email}.json`);
  execFileSync(process.execPath, ['scripts/page-audit-session.mjs', '--base', base, '--email', email, '--family', family, '--out', state], { stdio: 'inherit', env: process.env });
  const meta = JSON.parse(readFileSync(state.replace(/\.json$/, '.meta.json'), 'utf8'));
  return { ...meta, cookie: cookieHeaderFromState(state) };
}

/** The SSR cookies @supabase/ssr writes for a session, as one Cookie header. */
async function cookieFor(session) {
  const jar = new Map();
  const ssr = createServerClient(url, anon, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => { for (const { name, value } of list) value ? jar.set(name, value) : jar.delete(name); },
    },
  });
  const { error } = await ssr.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (error) throw error;
  return [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
}

async function child(familyId) {
  const email = 'api-audit-child@example.test';
  const password = 'Api-Audit-Child-2026!';
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const old = list?.users.find((u) => u.email === email);
  if (old) await admin.auth.admin.deleteUser(old.id);
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'Robin Rivera' } });
  if (error) throw error;
  const { data: member, error: memberError } = await admin.from('family_members')
    .insert({ family_id: familyId, user_id: created.user.id, role: 'child', display_name: 'Robin', is_active: true })
    .select('id').single();
  if (memberError) throw memberError;
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { email, userId: created.user.id, familyId, memberId: member.id, role: 'child', cookie: await cookieFor(signedIn.session) };
}

const p = parent('api-audit-parent@example.test', 'API Audit Family');
const a = parent('api-audit-admin@example.test', 'API Audit Admin Family');
const { error: superError } = await admin.from('super_admins').upsert({ email: a.email });
if (superError) throw superError;
const c = await child(p.familyId);
writeFileSync(out, JSON.stringify({ base, callers: { anon: { cookie: '' }, child: c, parent: p, admin: { ...a, superAdmin: true } } }, null, 2));
console.log(`Callers written to ${out}: child ${c.userId}, parent ${p.userId}, super admin ${a.userId}`);
