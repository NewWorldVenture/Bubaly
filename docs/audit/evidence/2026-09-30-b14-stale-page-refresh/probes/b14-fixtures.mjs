// Local-only synthetic fixtures for the B14 stale-page refresh. Service-role
// client against the LOCAL Supabase stack (NEXT_PUBLIC_SUPABASE_URL must be
// 127.0.0.1). Writes credentials to $B14_CREDS (mode 0600); prints no secrets.
import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/127\.0\.0\.1:/.test(url ?? '')) throw new Error('refusing: not a local stack');
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const [familyId, parentAccountFile, adminEmail] = process.argv.slice(2);
const parent = JSON.parse(readFileSync(parentAccountFile, 'utf8'));
const must = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };

// Parent persona: a plain parent, not a super administrator.
must(await admin.from('super_admins').delete().ilike('email', parent.email), 'drop parent super_admin row');

// Super administrator persona: an existing local super admin; fresh random password.
const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
const adminUser = users.users.find(u => u.email?.toLowerCase() === adminEmail.toLowerCase());
if (!adminUser) throw new Error('super admin user not found');
must(await admin.from('super_admins').select('email').ilike('email', adminEmail).single(), 'admin is super admin');
const adminPassword = randomBytes(18).toString('base64url');
must(await admin.auth.admin.updateUserById(adminUser.id, { password: adminPassword }), 'set admin password');

// /kid-login child: the household's child login; PIN set exactly as the app's reset does.
const login = must(await admin.from('child_logins').select('username, user_id, member_id').eq('family_id', familyId).single(), 'child login');
const pin = String(randomInt(0, 10000)).padStart(4, '0');
const derived = createHash('sha256').update(`${process.env.CHILD_LOGIN_SECRET}::${login.username}::${pin}`).digest('hex');
must(await admin.auth.admin.updateUserById(login.user_id, { password: derived }), 'set child PIN');
must(await admin.from('child_login_throttle').delete().eq('username', login.username), 'clear throttle');

// Records the id routes need, owned by the child.
const chore = must(await admin.from('chores').insert({ family_id: familyId, title: 'B14 synthetic chore', proof_required: 'photo' }).select('id').single(), 'chore');
const assignment = must(await admin.from('chore_assignments').insert({ family_id: familyId, chore_id: chore.id, member_id: login.member_id }).select('id').single(), 'assignment');
const listing = must(await admin.from('marketplace_listings').insert({ family_id: familyId, member_id: login.member_id, created_by: login.user_id, title: 'B14 synthetic listing', description: 'Synthetic local fixture.', kind: 'sell', category: 'other', price_cents: 500 }).select('id').single(), 'listing');
const store = must(await admin.from('marketplace_stores').select('id').eq('family_id', familyId).eq('member_id', login.member_id).eq('is_active', true).single(), 'store');
const wallet = must(await admin.from('child_wallets').select('id').eq('family_id', familyId).eq('member_id', login.member_id).eq('is_active', true).single(), 'wallet');

writeFileSync(process.env.B14_CREDS, JSON.stringify({ parent: { email: parent.email, password: parent.password }, admin: { email: adminEmail, password: adminPassword }, child: { username: login.username, pin } }), { mode: 0o600 });
const ids = { assignmentId: assignment.id, creatorId: store.id, itemId: listing.id, childWalletId: wallet.id, childMemberId: login.member_id };
writeFileSync(process.env.B14_IDS, JSON.stringify(ids, null, 2));
console.log(JSON.stringify(ids));
