import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://ltcxlbipiihclxwioyqj.supabase.co',
  'sb_secret_BfCiburaPbck_7uXGgWOPA_glwQ5GkV',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const FAMILY_ID = 'a0cba6bd-88f7-48a9-926d-b27e5cf671dc';
const CB        = 'df41e924-9bea-4980-98d4-f9d78df05e49'; // auth.users.id

const uuid = () => crypto.randomUUID();

const { data: mems, error: memErr } = await sb.from('family_members').select('id,display_name,role').eq('family_id', FAMILY_ID);
if (memErr) { console.error('❌ could not load members:', memErr.message); process.exit(1); }
const m = Object.fromEntries(mems.map((x) => [x.display_name, x.id]));
const DANIEL = m['Daniel'], SARAH = m['Sarah'], EMMA = m['Emma'], JACKSON = m['Jackson'], LILY = m['Lily'];

async function ins(table, rows) {
  const { data, error } = await sb.from(table).insert(rows).select('id');
  if (error) { console.error(`❌ ${table}:`, error.message); return null; }
  console.log(`  ✓ ${table}: +${rows.length}`);
  return data;
}

// Wipe prior medical/dental seed for idempotency
for (const t of ['health_providers', 'insurance_policies', 'medical_profiles']) {
  const { error } = await sb.from(t).delete().eq('family_id', FAMILY_ID);
  if (error && !/does not exist/i.test(error.message)) console.error(`  (cleanup ${t}: ${error.message})`);
}

// ── Providers ──────────────────────────────────────────────
console.log('\n── Providers ──');
const providers = [
  // Medical
  { member_id: null,    kind: 'medical', name: 'Dr. James Peterson', specialty: 'Family Medicine', practice_name: 'Westfield Family Medicine', phone: '(555) 201-3000', fax: '(555) 201-3001', address: '410 Oak Ave, Suite 100', is_primary: true, notes: 'Whole-family PCP. Portal: westfieldfm.com' },
  { member_id: LILY,    kind: 'medical', name: 'Dr. Sarah Patel',    specialty: 'Pediatrics',      practice_name: 'Sunshine Pediatrics', phone: '(555) 234-5678', fax: '(555) 234-5679', address: '88 Maple Dr', is_primary: true, notes: 'Lily & younger kids.' },
  { member_id: JACKSON, kind: 'medical', name: 'Dr. Sarah Patel',    specialty: 'Pediatrics',      practice_name: 'Sunshine Pediatrics', phone: '(555) 234-5678', is_primary: true, notes: null },
  { member_id: JACKSON, kind: 'medical', name: 'Dr. Nina Gupta',     specialty: 'Allergy & Asthma', practice_name: 'AllergyCare Specialists', phone: '(555) 660-1200', is_primary: false, notes: 'Manages asthma + seasonal allergies.' },
  { member_id: EMMA,    kind: 'medical', name: 'Dr. Rebecca Chen',   specialty: 'Adolescent Medicine', practice_name: "Children's Health Clinic", phone: '(555) 445-7788', is_primary: true, notes: null },
  { member_id: EMMA,    kind: 'medical', name: 'Dr. Amanda Ross',    specialty: 'Therapy / Counseling', practice_name: 'Mindwell Counseling', phone: '(555) 778-2200', is_primary: false, notes: 'Biweekly sessions.' },
  { member_id: DANIEL,  kind: 'medical', name: 'Dr. Robert Stone',   specialty: 'Cardiology',      practice_name: 'Heart Health Associates', phone: '(555) 889-4321', is_primary: false, notes: null },
  { member_id: SARAH,   kind: 'medical', name: 'Dr. Alicia Torres',  specialty: 'OB-GYN',          practice_name: "Women's Health Associates", phone: '(555) 332-9090', is_primary: true, notes: null },
  // Dental
  { member_id: null,    kind: 'dental',  name: 'Dr. Mark Williams',  specialty: 'General Dentistry', practice_name: 'Bright Smiles Dental', phone: '(555) 556-1010', fax: '(555) 556-1011', address: '220 Birch Rd', is_primary: true, notes: 'Whole-family dentist. 6-month cleanings.' },
  { member_id: EMMA,    kind: 'dental',  name: 'Dr. Kevin Park',     specialty: 'Orthodontics',    practice_name: 'Straight Smiles Ortho', phone: '(555) 991-2323', is_primary: true, notes: 'Emma in braces — adjustments every 6 wks.' },
  { member_id: JACKSON, kind: 'dental',  name: 'Dr. Mark Williams',  specialty: 'General Dentistry', practice_name: 'Bright Smiles Dental', phone: '(555) 556-1010', is_primary: true, notes: null },
];
await ins('health_providers', providers.map((p) => ({ id: uuid(), family_id: FAMILY_ID, created_by: CB, ...p })));

// ── Insurance ──────────────────────────────────────────────
console.log('\n── Insurance ──');
const policies = [
  { member_id: null, kind: 'medical', insurer: 'Blue Cross Blue Shield', plan_name: 'PPO Family', plan_type: 'PPO', policy_number: 'XYZ123456789', group_number: 'GRP-00428', rx_bin: '003858', rx_pcn: 'A4', rx_group: 'BCBSRX01', customer_service_phone: '(800) 555-1000', effective_date: '2026-01-01', is_primary: true, notes: 'Covers the whole family. $30 PCP copay, $50 specialist.' },
  { member_id: null, kind: 'dental',  insurer: 'Delta Dental',          plan_name: 'PPO Plus Premier', plan_type: 'PPO', policy_number: 'DD-558810042', group_number: 'DGRP-7781', rx_bin: null, rx_pcn: null, rx_group: null, customer_service_phone: '(800) 555-3400', effective_date: '2026-01-01', is_primary: true, notes: '2 cleanings/yr covered 100%. Ortho 50% to $2,000 lifetime.' },
];
await ins('insurance_policies', policies.map((p) => ({ id: uuid(), family_id: FAMILY_ID, created_by: CB, ...p })));

// ── Medical Profiles ───────────────────────────────────────
console.log('\n── Medical Profiles ──');
const GRANDMA = { name: 'Grandma Ruth', phone: '(555) 876-5432', rel: 'Grandmother' };
const profiles = [
  { member_id: DANIEL,  blood_type: 'O+',  allergies: 'None known', conditions: 'High blood pressure (controlled)', current_medications: 'Lisinopril 10mg daily; Fish Oil 1000mg', primary_physician: 'Dr. James Peterson', preferred_pharmacy: 'Walgreens — Oak St', pharmacy_phone: '(555) 222-3333', emergency_contact_name: 'Sarah Hughen', emergency_contact_phone: '(555) 100-2000', emergency_contact_relation: 'Spouse', immunizations: 'Up to date · Flu 2025 · Tdap 2022', dental_notes: 'Night guard for grinding.', notes: null },
  { member_id: SARAH,   blood_type: 'A+',  allergies: 'Sulfa drugs', conditions: 'None', current_medications: 'Vitamin D3 2000 IU; Magnesium Glycinate', primary_physician: 'Dr. Alicia Torres', preferred_pharmacy: 'Walgreens — Oak St', pharmacy_phone: '(555) 222-3333', emergency_contact_name: 'Daniel Hughen', emergency_contact_phone: '(555) 100-1000', emergency_contact_relation: 'Spouse', immunizations: 'Up to date · Flu 2025', dental_notes: null, notes: null },
  { member_id: EMMA,    blood_type: 'O+',  allergies: 'Penicillin', conditions: 'Anxiety (managed with therapy)', current_medications: 'Daily Multivitamin; Iron 325mg', primary_physician: 'Dr. Rebecca Chen', preferred_pharmacy: 'CVS — Main St', pharmacy_phone: '(555) 444-5555', emergency_contact_name: GRANDMA.name, emergency_contact_phone: GRANDMA.phone, emergency_contact_relation: GRANDMA.rel, immunizations: 'Up to date · HPV series complete · Flu 2025', dental_notes: 'Braces (upper & lower) — Dr. Park. Avoid hard candy.', notes: 'Sees Dr. Ross (counseling) biweekly.' },
  { member_id: JACKSON, blood_type: 'B+',  allergies: 'Pollen, dust mites', conditions: 'Asthma; seasonal allergies', current_medications: 'Zyrtec 10mg daily; Albuterol inhaler 2 puffs as needed', primary_physician: 'Dr. Sarah Patel', preferred_pharmacy: 'Walgreens — Oak St', pharmacy_phone: '(555) 222-3333', emergency_contact_name: GRANDMA.name, emergency_contact_phone: GRANDMA.phone, emergency_contact_relation: GRANDMA.rel, immunizations: 'Up to date · Flu 2025', dental_notes: 'Sealants on molars 2025.', notes: 'Carries rescue inhaler at school + soccer.' },
  { member_id: LILY,    blood_type: 'A+',  allergies: 'None known', conditions: 'None', current_medications: 'Fluoride supplement 0.5mg at bedtime', primary_physician: 'Dr. Sarah Patel', preferred_pharmacy: 'Walgreens — Oak St', pharmacy_phone: '(555) 222-3333', emergency_contact_name: GRANDMA.name, emergency_contact_phone: GRANDMA.phone, emergency_contact_relation: GRANDMA.rel, immunizations: 'Up to date · Kindergarten boosters complete', dental_notes: 'First full cleaning done. No cavities.', notes: 'Speech therapy weekly.' },
];
await ins('medical_profiles', profiles.map((p) => ({ id: uuid(), family_id: FAMILY_ID, updated_by: CB, ...p })));

// ── Counts ─────────────────────────────────────────────────
console.log('\n── Counts ──');
for (const t of ['health_providers', 'insurance_policies', 'medical_profiles']) {
  const { count } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('family_id', FAMILY_ID);
  console.log(`  ${t}: ${count ?? 0}`);
}
console.log('\n✅ Medical & dental seed complete!');
