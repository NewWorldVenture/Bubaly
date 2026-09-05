#!/usr/bin/env node
// Four people who can actually sign in, for the §46 scenario walkthroughs.
//
// The e2e specs create their own throwaway account; this script exists for the
// other half of the spec — the persona scenarios a person runs by hand, and
// the Playwright scenarios that need a household with a parent, a second
// parent, a teen and a child rather than one adult alone.
//
// SAFETY, two layers, because this script holds a service-role key and creates
// logins: `requireSeedScope()` (scripts/seed-client.mjs) demands an explicitly
// confirmed non-production target, and `assertLocal` additionally refuses a
// remote Supabase host unless E2E_ALLOW_REMOTE_SUPABASE=1 says so. Creating a
// family in a real household's database is not a mistake a script can undo.
import { createSeedClient, requireSeedScope } from './seed-client.mjs';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const password = process.env.E2E_PERSONA_PASSWORD ?? process.env.E2E_AUTH_PASSWORD ?? '';
const domain = process.env.E2E_PERSONA_DOMAIN ?? 'example.test';

/** The §46 cast. `login: false` is a managed profile — a child with no account. */
export const PERSONAS = [
  { key: 'parent1', name: 'Casey Rivera', role: 'parent', login: true },
  { key: 'parent2', name: 'Sam Rivera', role: 'parent', login: true },
  { key: 'teen', name: 'Ari Rivera', role: 'teen', login: true, birthday: '2010-04-11' },
  { key: 'child', name: 'Maya Rivera', role: 'child', login: false, birthday: '2016-03-02' },
];

export function personaEmail(key, familySlug = 'bubaly-personas') {
  return `${familySlug}+${key}@${domain}`;
}

export function assertLocal(rawUrl, env = process.env) {
  if (!rawUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required.');
  const host = new URL(rawUrl).hostname;
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!local && env.E2E_ALLOW_REMOTE_SUPABASE !== '1') {
    throw new Error(`Refusing to seed personas into remote Supabase host ${host}.`);
  }
  return true;
}

async function findUser(admin, email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 100) break;
  }
  return null;
}

/**
 * Idempotent: running twice leaves the same one family and the same four
 * people. A seed script that doubles its own household on the second run is a
 * seed script nobody trusts in CI.
 */
export async function seedPersonas({ admin, familyName = 'The Riveras', familyId: wantedFamilyId = null }) {
  const owner = PERSONAS[0];
  const ownerEmail = personaEmail(owner.key);
  let ownerUser = await findUser(admin, ownerEmail);
  if (!ownerUser) {
    const { data, error } = await admin.auth.admin.createUser({
      email: ownerEmail, password, email_confirm: true, user_metadata: { full_name: owner.name },
    });
    if (error) throw error;
    ownerUser = data.user;
  }

  const { data: existing, error: membershipError } = await admin
    .from('family_members').select('family_id').eq('user_id', ownerUser.id).limit(1);
  if (membershipError) throw membershipError;

  let familyId = existing?.[0]?.family_id ?? null;
  if (!familyId) {
    // The id comes from SEED_FAMILY_ID when the operator named one, so the
    // household this script touches is the household they confirmed twice.
    const row = { name: familyName, created_by: ownerUser.id };
    if (wantedFamilyId) row.id = wantedFamilyId;
    const { data: family, error } = await admin.from('families').insert(row).select('id').single();
    if (error) throw error;
    familyId = family.id;
    // handle_new_family() adds the creator as a parent; nothing to do here.
  }

  const created = [];
  for (const persona of PERSONAS) {
    let userId = null;
    if (persona.login) {
      const email = personaEmail(persona.key);
      const user = await findUser(admin, email) ?? (await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: persona.name },
      })).data?.user;
      userId = user?.id ?? null;
    }
    const { data: match } = await admin
      .from('family_members').select('id').eq('family_id', familyId).eq('display_name', persona.name).limit(1);
    if (match?.[0]?.id) { created.push({ ...persona, memberId: match[0].id, userId }); continue; }

    const { data: member, error } = await admin.from('family_members').insert({
      family_id: familyId, user_id: userId, role: persona.role,
      display_name: persona.name, birthday: persona.birthday ?? null, is_active: true,
    }).select('id').single();
    if (error) throw error;
    created.push({ ...persona, memberId: member.id, userId });
  }
  return { familyId, members: created };
}

async function main() {
  const scope = requireSeedScope();
  assertLocal(url);
  if (!password) throw new Error('E2E_PERSONA_PASSWORD or E2E_AUTH_PASSWORD is required.');
  const admin = createSeedClient();
  const { familyId, members } = await seedPersonas({ admin, familyId: scope.familyId });
  console.log(`Seeded family ${familyId} (${scope.environment}): ${members.map((m) => `${m.name} (${m.role}${m.userId ? '' : ', managed'})`).join(', ')}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
