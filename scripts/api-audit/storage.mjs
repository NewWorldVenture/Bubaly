#!/usr/bin/env node
// Storage audit — every bucket, through the real Storage API, as four callers:
// signed out, a parent (the owner), that parent's child, and a parent of
// another family. Local Supabase ONLY: the accounts, families and objects it
// creates are disposable and removed at the end.
//
// The boundary probes under docs/audit/ read storage.objects policies in SQL.
// This drives the HTTP API a browser uses, so it also sees what SQL cannot:
// the bucket's `public` flag (served without RLS), its MIME allow-list and the
// LIST endpoint.
//
//   set -a; . ./api-sweep.env; set +a
//   node scripts/api-audit/storage.mjs            # prints a table, exits 1 on a FAIL
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) {
  console.error(`Refusing: NEXT_PUBLIC_SUPABASE_URL (${url || 'unset'}) is not a local Supabase.`);
  process.exit(1);
}
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(url, serviceKey, opts);
const tag = randomUUID().slice(0, 8);
const password = `Storage-audit-${randomUUID()}`;

async function user(label) {
  const email = `storage-audit-${label}-${tag}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(url, anonKey, opts);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, client, label };
}

async function family(owner, name) {
  const { data, error } = await admin.from('families').insert({ name, created_by: owner.id }).select('id').single();
  if (error) throw error;
  // handle_new_family makes the creator a parent; upsert states it anyway.
  const { error: memberError } = await admin.from('family_members')
    .upsert({ family_id: data.id, user_id: owner.id, display_name: owner.label, role: 'parent', is_active: true }, { onConflict: 'family_id,user_id' });
  if (memberError) throw memberError;
  return data.id;
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const results = [];
function record(bucket, check, caller, expected, actual, detail = '') {
  const pass = expected === actual;
  results.push({ bucket, check, caller, expected, actual, verdict: pass ? 'OK' : 'FAIL', detail });
}
const allowed = (r) => (r.error ? 'refused' : 'allowed');

async function upload(client, bucket, path, body = png, contentType = 'image/png') {
  return client.storage.from(bucket).upload(path, body, { contentType, upsert: false });
}
async function listed(client, bucket, folder) {
  const { data, error } = await client.storage.from(bucket).list(folder);
  if (error) return 'refused';
  return (data ?? []).filter((o) => o.name !== '.emptyFolderPlaceholder').length > 0 ? 'listed' : 'empty';
}
async function publicGet(bucket, path) {
  const res = await fetch(`${url}/storage/v1/object/public/${bucket}/${path}`);
  return res.status === 200 ? 'served' : 'not served';
}

const created = { users: [], families: [], objects: [] };
let exitCode = 0;
try {
  const parentA = await user('parent-a');
  const childA = await user('child-a');
  const parentB = await user('parent-b');
  created.users.push(parentA, childA, parentB);
  const famA = await family(parentA, `Storage audit A ${tag}`);
  const famB = await family(parentB, `Storage audit B ${tag}`);
  created.families.push(famA, famB);
  const { error: childError } = await admin.from('family_members')
    .insert({ family_id: famA, user_id: childA.id, display_name: 'Child A', role: 'child', is_active: true });
  if (childError) throw childError;
  const anon = { client: createClient(url, anonKey, opts), label: 'signed out' };

  // ── user-folder buckets: <user id>/<name> ────────────────────────────────
  for (const bucket of ['avatars', 'feedback-attachments', 'marketplace-photos']) {
    const name = `${randomUUID()}.png`;
    const own = `${parentA.id}/${name}`;
    const isPublic = bucket !== 'feedback-attachments';
    record(bucket, 'upload into own folder', 'owner', 'allowed', allowed(await upload(parentA.client, bucket, own)));
    created.objects.push([bucket, own]);
    record(bucket, "upload into another user's folder", 'other family', 'refused', allowed(await upload(parentB.client, bucket, `${parentA.id}/${randomUUID()}.png`)));
    record(bucket, "upload into another user's folder", 'child of the owner', 'refused', allowed(await upload(childA.client, bucket, `${parentA.id}/${randomUUID()}.png`)));
    record(bucket, 'upload', 'signed out', 'refused', allowed(await upload(anon.client, bucket, `${parentA.id}/${randomUUID()}.png`)));
    record(bucket, 'upload an HTML file into own folder', 'owner', 'refused',
      allowed(await upload(parentA.client, bucket, `${parentA.id}/${randomUUID()}.html`, Buffer.from('<script>alert(1)</script>'), 'text/html')));
    record(bucket, 'list own folder', 'owner', 'listed', await listed(parentA.client, bucket, parentA.id));
    record(bucket, "list the owner's folder", 'other family', 'empty', await listed(parentB.client, bucket, parentA.id));
    record(bucket, "list the owner's folder", 'signed out', 'empty', await listed(anon.client, bucket, parentA.id));
    // A public bucket serves every object without consulting RLS, through the
    // API exactly as through the public URL, so this is the declared exposure,
    // not a second one. For a private bucket it must be refused.
    record(bucket, 'download through the API', 'other family', isPublic ? 'allowed' : 'refused',
      allowed(await parentB.client.storage.from(bucket).download(own)), isPublic ? 'public bucket: same exposure as the public URL' : '');
    record(bucket, 'overwrite (upsert) the object', 'other family', 'refused',
      allowed(await parentB.client.storage.from(bucket).upload(own, png, { contentType: 'image/png', upsert: true })));
    record(bucket, 'delete the object', 'other family', 'refused',
      (await parentB.client.storage.from(bucket).remove([own])).data?.length ? 'allowed' : 'refused');
    record(bucket, 'GET the public URL', 'signed out', isPublic ? 'served' : 'not served', await publicGet(bucket, own),
      isPublic ? 'declared public in bucket-visibility-is-declared-check.sql; the name is 122 random bits' : '');
  }

  // ── documents: <family id>/<name>, family-scoped ─────────────────────────
  {
    const bucket = 'documents';
    const own = `${famA}/${randomUUID()}.pdf`;
    const pdf = Buffer.from('%PDF-1.4\n%storage audit\n');
    record(bucket, "upload into the family's folder", 'owner', 'allowed', allowed(await upload(parentA.client, bucket, own, pdf, 'application/pdf')));
    created.objects.push([bucket, own]);
    record(bucket, "upload into another family's folder", 'other family', 'refused',
      allowed(await upload(parentB.client, bucket, `${famA}/${randomUUID()}.pdf`, pdf, 'application/pdf')));
    record(bucket, 'upload', 'signed out', 'refused', allowed(await upload(anon.client, bucket, `${famA}/${randomUUID()}.pdf`, pdf, 'application/pdf')));
    record(bucket, "list the family's folder", 'child of the owner', 'listed', await listed(childA.client, bucket, famA),
      'a non-sensitive document is the family\'s; sensitive ones are held by document-bytes-boundary-check.sql');
    record(bucket, "list the family's folder", 'other family', 'empty', await listed(parentB.client, bucket, famA));
    record(bucket, "list the family's folder", 'signed out', 'empty', await listed(anon.client, bucket, famA));
    record(bucket, 'download through the API', 'other family', 'refused', allowed(await parentB.client.storage.from(bucket).download(own)));
    record(bucket, 'download through the API', 'signed out', 'refused', allowed(await anon.client.storage.from(bucket).download(own)));
    record(bucket, 'delete the object', 'other family', 'refused',
      (await parentB.client.storage.from(bucket).remove([own])).data?.length ? 'allowed' : 'refused');
    record(bucket, 'GET the public URL', 'signed out', 'not served', await publicGet(bucket, own));
  }

  // ── marketing-assets: the server's alone ─────────────────────────────────
  {
    const bucket = 'marketing-assets';
    const own = `audit/${randomUUID()}.png`;
    const { error } = await admin.storage.from(bucket).upload(own, png, { contentType: 'image/png' });
    record(bucket, 'upload', 'service role (control)', 'allowed', error ? 'refused' : 'allowed');
    created.objects.push([bucket, own]);
    for (const caller of [parentA, anon]) {
      const who = caller === anon ? 'signed out' : 'owner';
      record(bucket, 'upload', who, 'refused', allowed(await upload(caller.client, bucket, `audit/${randomUUID()}.png`)));
      record(bucket, 'list', who, 'empty', await listed(caller.client, bucket, 'audit'));
      record(bucket, 'download through the API', who, 'refused', allowed(await caller.client.storage.from(bucket).download(own)));
    }
    record(bucket, 'GET the public URL', 'signed out', 'not served', await publicGet(bucket, own));
  }
} catch (error) {
  console.error('storage audit could not run:', error?.message ?? error);
  exitCode = 2;
} finally {
  for (const [bucket, path] of created.objects) await admin.storage.from(bucket).remove([path]);
  // Objects any FAIL row wrote: sweep each audit user's folders too.
  for (const u of created.users) {
    for (const bucket of ['avatars', 'feedback-attachments', 'marketplace-photos']) {
      const { data } = await admin.storage.from(bucket).list(u.id);
      if (data?.length) await admin.storage.from(bucket).remove(data.map((o) => `${u.id}/${o.name}`));
    }
  }
  for (const f of created.families) {
    const { data } = await admin.storage.from('documents').list(f);
    if (data?.length) await admin.storage.from('documents').remove(data.map((o) => `${f}/${o.name}`));
    await admin.from('families').delete().eq('id', f);
  }
  for (const u of created.users) await admin.auth.admin.deleteUser(u.id);
}

const width = (k) => Math.max(k.length, ...results.map((r) => String(r[k]).length));
const cols = ['verdict', 'bucket', 'check', 'caller', 'expected', 'actual'];
console.log(cols.map((c) => c.padEnd(width(c))).join('  '));
for (const r of results) console.log(cols.map((c) => String(r[c]).padEnd(width(c))).join('  ') + (r.detail ? `  (${r.detail})` : ''));
const failed = results.filter((r) => r.verdict === 'FAIL').length;
console.log(`\n== storage: ${results.length - failed} OK, ${failed} FAIL, over ${new Set(results.map((r) => r.bucket)).size} buckets ==`);
process.exit(exitCode || (failed ? 1 : 0));
