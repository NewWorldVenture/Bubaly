/**
 * seed-core-platform.mjs
 * Seeds tables from 0014_core_platform.sql and 0015_todos.sql
 * Run: node scripts/seed-core-platform.mjs
 *
 * Tables:
 *   family_conversations  (10 conversations)
 *   family_messages       (200 messages across conversations)
 *   family_albums         (15 albums)
 *   family_photos         (200 photo metadata records)
 *   family_contacts       (200 contacts)
 *   family_reminders      (200 reminders)
 *   family_recipes        (200 recipes)
 *   todo_lists            (10 lists)
 *   todo_items            (200 items across lists)
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://ltcxlbipiihclxwioyqj.supabase.co',
  'sb_secret_BfCiburaPbck_7uXGgWOPA_glwQ5GkV',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const FAMILY_ID      = 'a0cba6bd-88f7-48a9-926d-b27e5cf671dc';
const DANIEL_USER_ID = 'df41e924-9bea-4980-98d4-f9d78df05e49'; // auth.users.id
const DANIEL_MID     = '1dfe994e-75c8-4cb6-920e-20984fae5651'; // family_members.id
const CB             = DANIEL_USER_ID;

// ── Resolve live member IDs ────────────────────────────────────────────────
const { data: mems } = await sb.from('family_members').select('id, display_name, user_id').eq('family_id', FAMILY_ID);
console.log('Members:', mems?.map(m => `${m.display_name}:${m.id.slice(0,8)}`));

const memByName = new Map(mems?.map(m => [m.display_name, m]) ?? []);
const gm = (name) => memByName.get(name) ?? { id: DANIEL_MID, user_id: DANIEL_USER_ID };

const DANIEL  = gm('Daniel');
const SARAH   = gm('Sarah');
const EMMA    = gm('Emma');
const JACKSON = gm('Jackson');
const LILY    = gm('Lily');

const ALL_MEM  = [DANIEL, SARAH, EMMA, JACKSON, LILY];
const ALL_MIDS = ALL_MEM.map(m => m.id);
const ALL_UIDS = ALL_MEM.map(m => m.user_id ?? DANIEL_USER_ID);

// ── Helpers ───────────────────────────────────────────────────────────────
const uuid    = () => crypto.randomUUID();
const pick    = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pickN   = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
const rand    = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const today   = new Date('2026-06-20');
const daysAgo  = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString(); };
const daysFrom = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString(); };
const dateStr  = (n) => (n >= 0 ? daysFrom(n) : daysAgo(-n)).slice(0, 10);
const minsAgo  = (n) => new Date(today.getTime() - n * 60000).toISOString();

async function ins(table, rows) {
  if (!rows.length) { console.log(`  – ${table}: 0 rows, skip`); return []; }
  const { data, error } = await sb.from(table).insert(rows).select('id');
  if (error) { console.error(`❌ ${table}:`, error.message); return []; }
  console.log(`  ✓ ${table}: +${rows.length}`);
  return data ?? [];
}

// ══════════════════════════════════════════════════════════════════════════
// 1. FAMILY CONVERSATIONS (10)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Family Conversations ──');

const convDefs = [
  { name: 'Hughen Family',        kind: 'group',  emoji: '🏠', members: ALL_MIDS },
  { name: 'Parents Only',         kind: 'group',  emoji: '❤️',  members: [DANIEL.id, SARAH.id] },
  { name: 'Kids Squad',           kind: 'group',  emoji: '🎮', members: [EMMA.id, JACKSON.id, LILY.id] },
  { name: 'Summer Plans',         kind: 'group',  emoji: '☀️',  members: ALL_MIDS },
  { name: 'School Updates',       kind: 'group',  emoji: '📚', members: [DANIEL.id, SARAH.id, EMMA.id, JACKSON.id, LILY.id] },
  { name: 'Sports & Activities',  kind: 'group',  emoji: '⚽', members: [DANIEL.id, SARAH.id, JACKSON.id, EMMA.id] },
  { name: null,                   kind: 'direct', emoji: '💬', members: [DANIEL.id, SARAH.id] },
  { name: null,                   kind: 'direct', emoji: '💬', members: [DANIEL.id, EMMA.id] },
  { name: null,                   kind: 'direct', emoji: '💬', members: [SARAH.id, EMMA.id] },
  { name: 'Emergency Channel',    kind: 'group',  emoji: '🚨', members: ALL_MIDS },
];

const convRows = convDefs.map(c => ({
  id: uuid(), family_id: FAMILY_ID, name: c.name, kind: c.kind,
  avatar_emoji: c.emoji, member_ids: c.members,
  created_by: CB, last_message_at: daysAgo(rand(0, 14)),
}));
const insertedConvs = await ins('family_conversations', convRows);
const convIds = insertedConvs.map(r => r.id);

// ══════════════════════════════════════════════════════════════════════════
// 2. FAMILY MESSAGES (200)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Family Messages ──');

const FAMILY_MSGS = [
  "Don't forget Jackson has soccer at 4pm today!",
  "I'll pick up Emma from piano after work.",
  "Can someone grab milk on the way home?",
  "Lily's show-and-tell is tomorrow — she's bringing Mr. Bunny 🐰",
  "Emma got an A on her history paper!! 🎉",
  "Jackson needs new cleats before Saturday's game",
  "Who's making dinner tonight?",
  "I'm thinking tacos 🌮",
  "Yes! Taco Tuesday!!! 🙌",
  "Reminder: Grandma Ruth's birthday is in 2 weeks",
  "Already ordered her flowers ❤️",
  "Pool chemicals are running low, picking some up today",
  "Jackson left his lunch at home again 🤦",
  "Did everyone see the recital schedule? Lily's on at 2pm!",
  "I can't make it until 2:30 — save me a seat!",
  "Doctor confirmed Jackson's allergy tests came back normal 🙏",
  "That's such great news!!",
  "Who used the last of the shampoo and didn't replace it 😤",
  "Sorry Mom, I'll get it tomorrow",
  "The HOA meeting is on the 17th — are we going?",
  "I can go, you stay home with the kids",
  "Deal! I'll put it on the calendar",
  "Emma's orthodontist appointment is confirmed for the 21st at 3pm",
  "I'll drop her off on my way back from the office",
  "Jackson scored twice in today's game!!! ⚽⚽",
  "GO JACKSON!!! 🏆",
  "That's our boy!! 💪",
  "Camping trip confirmed — July 30th. Pack by the 29th",
  "Can I bring my friend Alex to camping?",
  "We'll talk about it 😄",
  "Dinner's ready! Come downstairs everyone",
  "5 minutes mom!",
  "NOW, not 5 minutes 😂",
  "The AC filter needs to be changed — it's been 2 months",
  "I'll order one on Amazon tonight",
  "Lily had a meltdown at Target lol, she's fine now",
  "Oh no 😅 what happened",
  "She wanted the giant stuffed unicorn. We compromised on the small one.",
  "Smart move Sarah 👏",
  "Emma's getting really good at piano, her teacher said so today!",
  "She practices every morning before school, I'm so proud",
  "Family movie tonight? Vote: 1=action, 2=comedy, 3=animated",
  "3!!! 3!!! 3!!!",
  "3 for me too 🎬",
  "Animated it is. Moana 2? 🌊",
  "YESSSSS",
  "Flight to Denver is confirmed for the 22nd, back the 24th",
  "We'll manage! Have a safe trip",
  "Miss you already lol",
  "Who forgot to feed Captain Fluffington?? 🐕",
  "Jackson... 🫠",
  "I fed him I promise!!",
  "Then why is he staring at me like this 😂",
  "Emma can you help Lily with her homework tonight?",
  "Already on it 😊",
  "You're the best big sister",
  "Aww ❤️",
  "Groceries are in the car, can someone help unload?",
  "On my way down",
  "Me too!",
  "You guys are the best 🥹",
  "Don't forget the dentist is Tuesday at 9am",
  "Already in the calendar!",
  "Jackson needs a permission slip signed by Friday",
  "I already signed it, it's in his folder",
  "Oh thank you! I forgot",
  "Swimming lessons went great today, Lily almost swam by herself!",
  "She was so brave!! 🏊",
  "My baby is growing up too fast 😭",
  "First time making homemade pizza tonight — wish me luck 🍕",
  "You've got this!!",
  "It smells AMAZING",
  "It's actually really good! Recipe is in the app",
  "Reminder to everyone: shoes go IN the closet, not next to the door",
  "Sorry 😇",
  "Also me sorry 😇",
  "I plead the fifth 😂",
  "Emma's SAT score came back — she's really happy with it!",
  "That's WONDERFUL!! Tell her we're so proud 🥳",
  "She's literally jumping around the living room right now",
  "Somebody has to go to the post office today, package to pick up",
  "I'll go on my lunch break",
  "Thank you!! It might be the headphones I ordered",
  "Correct, they're here 😄",
  "Can we get a dog? Asking for science",
  "No 😂",
  "What if it was a very small dog",
  "STILL no 😂",
  "Worth a shot 🐶",
  "Pool is officially open for the season!!! 🏊🎉",
  "YESSS finally!",
  "Race you all in at 5pm!!",
  "Don't start without me I'm leaving work early for this",
  "Today was a good day 🌟",
  "Agreed ❤️",
  "Love you all",
  "Love you too!! 💕",
];

const msgRows = [];
for (let i = 0; i < 200; i++) {
  const sender  = pick(ALL_MEM);
  const convId  = pick(convIds);
  const readBy  = pickN(ALL_UIDS, rand(0, ALL_UIDS.length));
  const minsBack = rand(1, 14 * 24 * 60);
  msgRows.push({
    id: uuid(),
    conversation_id: convId,
    family_id: FAMILY_ID,
    sender_id: sender.user_id ?? CB,
    sender_name: sender.display_name ?? 'Daniel',
    kind: 'text',
    content: FAMILY_MSGS[i % FAMILY_MSGS.length],
    reactions: i % 7 === 0 ? { '❤️': [pick(ALL_UIDS)], '😂': [pick(ALL_UIDS)] } : {},
    read_by: readBy,
    is_pinned: i % 40 === 0,
    created_at: minsAgo(minsBack),
  });
}
// Sort by created_at so last_message_at trigger fires in order
msgRows.sort((a, b) => a.created_at.localeCompare(b.created_at));
await ins('family_messages', msgRows);

// ══════════════════════════════════════════════════════════════════════════
// 3. FAMILY ALBUMS (15)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Family Albums ──');

const albumDefs = [
  { name: 'Summer 2025',              kind: 'vacation',   desc: 'Beach trip to Myrtle Beach' },
  { name: 'Jackson Soccer Season',    kind: 'sports',     desc: 'Spring 2026 season highlights' },
  { name: 'Emma Piano Recital',       kind: 'milestones', desc: 'June 2026 recital at Harmony Music' },
  { name: 'Lily First Day of Kinder', kind: 'school',     desc: 'August 2025 — big day!' },
  { name: 'Christmas 2025',           kind: 'holiday',    desc: 'Holiday memories' },
  { name: 'Jackson Birthday 11',      kind: 'birthday',   desc: 'Laser Quest party!' },
  { name: 'Hawaii 2024 Vacation',     kind: 'vacation',   desc: 'Big Island family trip' },
  { name: 'Everyday Moments',         kind: 'general',    desc: 'Life as the Hughens' },
  { name: 'Emma Graduation',          kind: 'milestones', desc: 'Junior year highlights' },
  { name: 'Thanksgiving 2025',        kind: 'holiday',    desc: 'Hughen home + family gathering' },
  { name: 'Spring Sports 2026',       kind: 'sports',     desc: 'Soccer, swimming, ballet all season' },
  { name: 'Lily Ballet Recital',      kind: 'milestones', desc: 'City Arts Center performance' },
  { name: 'Family Camping Trip',      kind: 'vacation',   desc: 'July 2026 — first camping trip' },
  { name: 'Home Renovation',          kind: 'other',      desc: 'Kitchen remodel project photos' },
  { name: 'Pets — Captain Fluffington', kind: 'general',  desc: 'Our golden retriever being adorable' },
];

const albumRows = albumDefs.map(a => ({
  id: uuid(), family_id: FAMILY_ID, name: a.name, description: a.desc,
  kind: a.kind, is_shared: true, photo_count: rand(8, 45),
  created_by: CB, created_at: daysAgo(rand(10, 365)),
}));
const insertedAlbums = await ins('family_albums', albumRows);
const albumIds = insertedAlbums.map(r => r.id);

// ══════════════════════════════════════════════════════════════════════════
// 4. FAMILY PHOTOS (200)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Family Photos ──');

const PHOTO_CAPTIONS = [
  'Summer sunshine! ☀️', 'Game day energy! ⚽', 'Look at that smile 😊',
  'Family first 💕', 'Proud moment 🌟', 'Best day ever!',
  'Making memories', 'Love these people so much ❤️', 'Pure joy!',
  'Backyard fun 🌿', 'Beach vibes 🌊', 'Team Hughen!',
  'Silly faces 😜', 'Morning light ✨', 'Cozy Sunday',
  'Adventure awaits 🏕️', 'Concert night 🎵', 'Pool day 🏊',
  'Harvest time 🍂', 'Snow day! ❄️', 'Pizza night ritual 🍕',
  'Movie night crew 🎬', 'Big win today 🏆', 'Nature walk 🌲',
  'Game night champions 🎲', null, null, null, null, null,
];

const photoRows = [];
for (let i = 0; i < 200; i++) {
  const uploader = pick(ALL_MEM);
  const daysBack = rand(1, 400);
  const w = pick([1080, 1440, 1920, 2560, 3024]);
  const h = pick([1080, 1440, 1920, 2160]);
  photoRows.push({
    id: uuid(),
    family_id: FAMILY_ID,
    album_id: albumIds.length ? pick(albumIds) : null,
    uploaded_by: uploader.user_id ?? CB,
    storage_path: `families/${FAMILY_ID}/photos/${uuid()}.jpg`,
    url: `https://picsum.photos/seed/${i + 100}/${w}/${h}`,
    thumbnail_url: `https://picsum.photos/seed/${i + 100}/400/300`,
    caption: pick(PHOTO_CAPTIONS),
    taken_at: daysAgo(daysBack),
    width: w, height: h,
    size_bytes: rand(800_000, 6_000_000),
    tags: pickN(['family','outdoor','sports','school','holiday','food','pets','travel'], rand(0, 3)),
    member_tags: pickN(ALL_MIDS, rand(0, 3)),
    is_favorite: Math.random() < 0.15,
    metadata: {},
    created_at: daysAgo(daysBack),
  });
}
await ins('family_photos', photoRows);

// ══════════════════════════════════════════════════════════════════════════
// 5. FAMILY CONTACTS (200)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Family Contacts ──');

const AREA = ['555', '556', '557', '558', '559'];
const phone = () => `(${pick(AREA)}) ${rand(100,999)}-${rand(1000,9999)}`;

const contactDefs = [
  // Emergency
  { name: 'Daniel Hughen',           cat: 'emergency', rel: 'Father',        phone: '(555) 100-1001', email: 'daniel@hughen.com',   is_emergency: true,  org: null,                   spec: null },
  { name: 'Sarah Hughen',            cat: 'emergency', rel: 'Mother',        phone: '(555) 100-1002', email: 'sarah@hughen.com',    is_emergency: true,  org: null,                   spec: null },
  { name: 'Ruth Hughen',             cat: 'emergency', rel: 'Grandmother',   phone: '(555) 876-5432', email: null,                  is_emergency: true,  org: null,                   spec: null },
  { name: 'Jim Nakamura',            cat: 'emergency', rel: 'Neighbor',      phone: '(555) 987-3210', email: 'jim.n@email.com',     is_emergency: true,  org: null,                   spec: null },
  { name: 'Carol Peterson',          cat: 'emergency', rel: 'Neighbor',      phone: '(555) 987-4321', email: null,                  is_emergency: true,  org: null,                   spec: null },
  // Doctors
  { name: 'Dr. Sarah Patel',         cat: 'doctor',    rel: 'Pediatrician',  phone: '(555) 234-5678', email: null,                  is_emergency: false, org: 'Sunshine Pediatrics',  spec: 'Pediatrics' },
  { name: 'Dr. James Peterson',      cat: 'doctor',    rel: 'Family Doctor', phone: '(555) 234-6789', email: null,                  is_emergency: false, org: 'Westfield Family Medicine', spec: 'Family Medicine' },
  { name: 'Dr. Robert Stone',        cat: 'doctor',    rel: 'Cardiologist',  phone: '(555) 345-7890', email: null,                  is_emergency: false, org: 'Heart Health Associates', spec: 'Cardiology' },
  { name: 'Dr. Amanda Ross',         cat: 'doctor',    rel: 'Therapist',     phone: '(555) 456-8901', email: 'a.ross@mindwell.com', is_emergency: false, org: 'Mindwell Counseling',   spec: 'Psychology' },
  { name: 'Dr. Nina Gupta',          cat: 'doctor',    rel: 'Allergist',     phone: '(555) 567-9012', email: null,                  is_emergency: false, org: 'AllergyCare Specialists', spec: 'Allergy & Immunology' },
  { name: 'Dr. Lisa Chang',          cat: 'doctor',    rel: 'Dermatologist', phone: '(555) 678-0123', email: null,                  is_emergency: false, org: 'Skin Care Center',       spec: 'Dermatology' },
  { name: 'Dr. Alicia Torres',       cat: 'doctor',    rel: 'OB-GYN',        phone: '(555) 789-1234', email: null,                  is_emergency: false, org: "Women's Health Assoc.", spec: 'OB-GYN' },
  { name: 'Dr. James Liu',           cat: 'doctor',    rel: 'Optometrist',   phone: '(555) 890-2345', email: null,                  is_emergency: false, org: 'Vision Care Center',    spec: 'Optometry' },
  { name: 'Dr. Rebecca Chen',        cat: 'doctor',    rel: 'Pediatrician',  phone: '(555) 901-3456', email: null,                  is_emergency: false, org: "Children's Health Clinic", spec: 'Pediatrics' },
  // Dentists
  { name: 'Dr. Mark Williams',       cat: 'dentist',   rel: 'Dentist',       phone: '(555) 234-4321', email: null,                  is_emergency: false, org: 'Bright Smiles Dental',  spec: 'General Dentistry' },
  { name: 'Dr. Kevin Park',          cat: 'dentist',   rel: 'Orthodontist',  phone: '(555) 345-5432', email: null,                  is_emergency: false, org: 'Straight Smiles Ortho', spec: 'Orthodontics' },
  // Teachers
  { name: 'Mrs. Thompson',           cat: 'teacher',   rel: 'Teacher',       phone: '(555) 456-6543', email: 'thompson@westfield.edu', is_emergency: false, org: 'Westfield High School', spec: 'AP Chemistry' },
  { name: 'Mr. Peterson',            cat: 'teacher',   rel: 'Teacher',       phone: '(555) 567-7654', email: 'peterson@riverside.edu', is_emergency: false, org: 'Riverside Middle School', spec: '5th Grade' },
  { name: 'Ms. Martinez',            cat: 'teacher',   rel: 'Teacher',       phone: '(555) 678-8765', email: 'martinez@sunnydayelm.edu', is_emergency: false, org: 'Sunny Days Elementary', spec: 'Kindergarten' },
  { name: 'Mr. Rodriguez',           cat: 'teacher',   rel: 'Counselor',     phone: '(555) 789-9876', email: 'rodriguez@westfield.edu', is_emergency: false, org: 'Westfield High School', spec: 'School Counselor' },
  // Coaches
  { name: 'Coach Mike Peterson',     cat: 'coach',     rel: 'Soccer Coach',  phone: '(555) 234-8765', email: 'mpeterson@soccer.com', is_emergency: false, org: 'Riverside Rockets Soccer', spec: 'Soccer' },
  { name: 'Coach Amy Chen',          cat: 'coach',     rel: 'Swim Coach',    phone: '(555) 345-9876', email: null,                  is_emergency: false, org: 'Westfield Swim Club',   spec: 'Swimming' },
  { name: 'Ms. Sofia',               cat: 'coach',     rel: 'Ballet Teacher',phone: '(555) 456-0987', email: null,                  is_emergency: false, org: 'City Dance Academy',    spec: 'Ballet' },
  { name: 'Coach Ryan Davis',        cat: 'coach',     rel: 'Baseball Coach',phone: '(555) 567-1098', email: null,                  is_emergency: false, org: 'Blue Jays Baseball',    spec: 'Baseball' },
  // Babysitters
  { name: 'Emma Johnson',            cat: 'babysitter',rel: 'Babysitter',    phone: '(555) 234-2222', email: 'emmaj@email.com',     is_emergency: false, org: null,                   spec: null },
  { name: 'Tyler Williams',          cat: 'babysitter',rel: 'Babysitter',    phone: '(555) 345-3333', email: null,                  is_emergency: false, org: null,                   spec: null },
  { name: 'Mia Gonzalez',            cat: 'babysitter',rel: 'Babysitter',    phone: '(555) 456-4444', email: 'mia.g@email.com',     is_emergency: false, org: null,                   spec: null },
];

// Generate ~170 more contacts to reach 200
const FIRST_NAMES = ['James','Mary','John','Patricia','Robert','Linda','Michael','Barbara','William','Susan','David','Jessica','Richard','Karen','Joseph','Lisa','Charles','Nancy','Thomas','Betty','Mark','Margaret','Daniel','Sandra','Paul','Ashley','Andrew','Dorothy','Joshua','Kimberly','Kevin','Emily','Brian','Laura','George','Donna','Edward','Carol','Ronald','Ruth','Timothy','Sharon','Kenneth','Michelle','Jason','Amanda','Ryan','Melissa','Jeffrey','Deborah','Frank','Stephanie','Scott','Rebecca','Eric','Sharon','Stephen','Cynthia','Jacob','Kathleen','Larry','Shirley','Gary','Angela','Jonathan','Helen','Gregory','Emma','Henry','Teresa'];
const LAST_NAMES  = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker','Young','Hall','Allen','Torres','Nguyen','Hill','Flores','Green','Adams'];
const ROLES_EXTRA = [
  { cat: 'family',   rel: 'Cousin' },
  { cat: 'family',   rel: 'Uncle' },
  { cat: 'family',   rel: 'Aunt' },
  { cat: 'family',   rel: 'Family Friend' },
  { cat: 'neighbor', rel: 'Neighbor' },
  { cat: 'work',     rel: 'Colleague' },
  { cat: 'friend',   rel: 'Friend' },
  { cat: 'other',    rel: 'Other' },
];

for (let i = contactDefs.length; i < 200; i++) {
  const role = pick(ROLES_EXTRA);
  contactDefs.push({
    name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
    cat: role.cat, rel: role.rel,
    phone: phone(), email: Math.random() > 0.4 ? `${pick(FIRST_NAMES).toLowerCase()}${rand(10,99)}@email.com` : null,
    is_emergency: false, org: null, spec: null,
  });
}

await ins('family_contacts', contactDefs.map(c => ({
  id: uuid(), family_id: FAMILY_ID,
  name: c.name, relationship: c.rel, category: c.cat,
  phone: c.phone, email: c.email,
  is_emergency: c.is_emergency,
  organization: c.org, specialty: c.spec,
  tags: [],
  created_by: CB,
  created_at: daysAgo(rand(0, 365)),
})));

// ══════════════════════════════════════════════════════════════════════════
// 6. FAMILY REMINDERS (200)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Family Reminders ──');

const REMINDER_TEMPLATES = [
  // Time reminders
  { title: "Pay monthly mortgage",           kind: 'bill',       rec: 'monthly',   days: 12,  priority: 'urgent', mem: DANIEL },
  { title: "Renew home insurance policy",    kind: 'bill',       rec: 'yearly',    days: 15,  priority: 'high',   mem: DANIEL },
  { title: "Pay car insurance — Honda",      kind: 'bill',       rec: 'monthly',   days: 8,   priority: 'high',   mem: DANIEL },
  { title: "Car registration renewal",       kind: 'bill',       rec: 'yearly',    days: 30,  priority: 'high',   mem: DANIEL },
  { title: "HOA dues payment",               kind: 'bill',       rec: 'monthly',   days: 5,   priority: 'medium', mem: DANIEL },
  { title: "File quarterly tax estimate",    kind: 'bill',       rec: 'none',      days: 11,  priority: 'high',   mem: DANIEL },
  { title: "Review streaming subscriptions", kind: 'bill',       rec: 'monthly',   days: 20,  priority: 'low',    mem: DANIEL },
  { title: "Costco membership renewal",      kind: 'bill',       rec: 'yearly',    days: 45,  priority: 'low',    mem: SARAH  },
  { title: "Amazon Prime renewal",           kind: 'bill',       rec: 'yearly',    days: 60,  priority: 'low',    mem: SARAH  },
  { title: "Spotify family plan",            kind: 'bill',       rec: 'monthly',   days: 3,   priority: 'low',    mem: DANIEL },
  // Medication
  { title: "Jackson Zyrtec refill",          kind: 'medication', rec: 'monthly',   days: 6,   priority: 'high',   mem: JACKSON },
  { title: "Jackson Albuterol inhaler check",kind: 'medication', rec: 'monthly',   days: 14,  priority: 'high',   mem: JACKSON },
  { title: "Daniel Lisinopril refill",       kind: 'medication', rec: 'monthly',   days: 10,  priority: 'urgent', mem: DANIEL  },
  { title: "Lily fluoride supplement restock",kind:'medication', rec: 'monthly',   days: 21,  priority: 'medium', mem: LILY    },
  { title: "Emma iron supplement restock",   kind: 'medication', rec: 'monthly',   days: 25,  priority: 'medium', mem: EMMA    },
  // School
  { title: "Jackson permission slip — field trip", kind: 'school', rec: 'none',   days: 1,   priority: 'urgent', mem: JACKSON },
  { title: "Emma SAT registration deadline", kind: 'school',     rec: 'none',      days: 25,  priority: 'urgent', mem: EMMA    },
  { title: "Order school supplies for fall", kind: 'school',     rec: 'yearly',    days: 40,  priority: 'medium', mem: SARAH   },
  { title: "FAFSA opens — start Emma's",     kind: 'school',     rec: 'yearly',    days: 100, priority: 'high',   mem: DANIEL  },
  { title: "Lily kindergarten registration", kind: 'school',     rec: 'none',      days: -3,  priority: 'high',   mem: SARAH   },
  // Chore reminders
  { title: "Schedule HVAC annual service",   kind: 'chore',      rec: 'yearly',    days: 7,   priority: 'high',   mem: DANIEL  },
  { title: "Pool chemicals restock",         kind: 'chore',      rec: 'monthly',   days: 3,   priority: 'high',   mem: DANIEL  },
  { title: "Clean dryer vent",               kind: 'chore',      rec: 'monthly',   days: 15,  priority: 'medium', mem: DANIEL  },
  { title: "Replace HVAC air filter",        kind: 'chore',      rec: 'monthly',   days: 2,   priority: 'high',   mem: DANIEL  },
  { title: "Gutter cleaning — fall",         kind: 'chore',      rec: 'yearly',    days: 30,  priority: 'medium', mem: DANIEL  },
  // Regular appointments
  { title: "Jackson dental cleaning",        kind: 'time',       rec: 'none',      days: 10,  priority: 'high',   mem: JACKSON },
  { title: "Emma orthodontist checkup",      kind: 'time',       rec: 'none',      days: 21,  priority: 'high',   mem: EMMA    },
  { title: "Lily pediatrician checkup",      kind: 'time',       rec: 'none',      days: 12,  priority: 'high',   mem: LILY    },
  { title: "Daniel annual physical",         kind: 'time',       rec: 'yearly',    days: 90,  priority: 'medium', mem: DANIEL  },
  { title: "Sarah OB-GYN annual",            kind: 'time',       rec: 'yearly',    days: 120, priority: 'medium', mem: SARAH   },
  // Shopping/logistics
  { title: "Sunscreen restock — SPF 50",     kind: 'time',       rec: 'none',      days: 1,   priority: 'medium', mem: SARAH   },
  { title: "Jackson new soccer cleats",      kind: 'time',       rec: 'none',      days: 4,   priority: 'high',   mem: SARAH   },
  { title: "Lily ballet recital costume pickup",kind:'time',     rec: 'none',      days: 5,   priority: 'high',   mem: LILY    },
  { title: "Return library books",           kind: 'time',       rec: 'none',      days: 2,   priority: 'medium', mem: SARAH   },
  { title: "Grandma Ruth birthday gift",     kind: 'time',       rec: 'none',      days: 0,   priority: 'urgent', mem: DANIEL  },
  { title: "Plan Grandma Ruth July visit",   kind: 'time',       rec: 'none',      days: 8,   priority: 'medium', mem: SARAH   },
  { title: "Check home fire extinguishers",  kind: 'chore',      rec: 'yearly',    days: 14,  priority: 'high',   mem: DANIEL  },
  { title: "Oil change — Honda Pilot",       kind: 'chore',      rec: 'none',      days: 5,   priority: 'high',   mem: DANIEL  },
  { title: "Oil change — Toyota Camry",      kind: 'chore',      rec: 'none',      days: 20,  priority: 'medium', mem: SARAH   },
  { title: "Power wash driveway",            kind: 'chore',      rec: 'yearly',    days: 45,  priority: 'low',    mem: DANIEL  },
];

// Fill to 200
const EXTRA_REMINDER_TITLES = [
  "Back up family photos to hard drive", "Call dad to catch up", "Plan date night with Sarah",
  "Research college visits for Emma", "Set up 529 auto-contribution", "Schedule family photos",
  "Dog grooming appointment", "Renew Emma's learner's permit", "Sign up for summer reading program",
  "Review 401k allocation", "Check passport expiration dates", "Buy birthday card for Mom",
  "Schedule pest control quarterly", "Get garage door serviced", "Replace porch lightbulbs",
  "Check swimming pool cover for winter", "Order holiday cards", "Plan Thanksgiving menu",
  "Update emergency contact list at school", "Schedule chimney sweep", "Get new windshield wipers",
  "Replace smoke detector batteries", "Fill prescriptions before trip", "Get camp physical for Emma",
  "Order contacts for Daniel", "Schedule tire rotation", "Check umbrella policy renewal",
  "Sign up for girls soccer league — Lily", "Book hotel for Denver trip", "Buy Lily rain boots",
  "Get Jackson a new backpack", "Emma needs new tennis shoes", "Schedule eye exams",
  "Review will and beneficiaries", "Donate old clothes", "Schedule carpet cleaning",
  "Get second opinion on kitchen remodel", "Research solar panel companies", "Buy new pool towels",
  "Stock first aid kit", "Test carbon monoxide detectors", "Schedule flu shots for all",
  "Print family calendar for fridge", "Order Jackson's birthday invitations", "Reserve campsite for July",
  "Get car washed before road trip", "Fix back gate latch", "Replenish pantry staples",
  "Schedule family dentist cleanings", "Look into summer camp options for Lily",
  "Jackson needs new baseball glove", "Get Emma a planner for senior year",
  "Sign all kids up for fall sports", "Review car seat expiration — Lily",
  "Organize attic storage", "Label all kids' school supplies", "Get Daniel's work laptop serviced",
  "Contact HOA about fence repair", "Apply for rebate on new appliances", "Check Lily's shoe size",
  "Update family emergency plan", "Buy new bath towels", "Research after-school tutors for Jackson",
  "Schedule professional headshots — Daniel", "Plan neighborhood block party",
  "Look up pediatric dentist for Lily", "Book haircuts for all kids",
  "Check expiration on canned goods", "Replace kitchen faucet gasket",
  "Buy new board game for family nights", "Research coding camp for Jackson",
  "Emma needs SAT prep books", "Schedule professional carpet cleaning",
  "Get Daniel's eyes checked", "Order Christmas gifts early", "Review life insurance policy",
  "Research home warranty options", "Sign up for neighborhood watch", "Buy new bike helmet for Lily",
  "Check safety recall on car seats", "Schedule termite inspection",
  "Update passwords — use password manager", "Call internet provider about speed upgrade",
  "Jackson science fair project — start early", "Plan Emma's 17th birthday",
  "Book family portraits — fall", "Get garage organized before winter",
  "Schedule chimney cleaning", "Order new outdoor furniture cushions",
  "Paint the guest bedroom", "Fix the bathroom faucet drip",
  "Research college financial aid deadlines", "Set up kids' college savings contributions",
  "Buy new kitchen towels", "Replace master bedroom pillows",
  "Schedule furnace tune-up before winter", "Get Emma a college application checklist book",
  "Jackson needs new gym shoes for PE", "Sign Lily up for art class",
  "Get new welcome mat for front door", "Deep clean refrigerator coils",
  "Schedule window cleaning service", "Replace water filter cartridge",
];

while (REMINDER_TEMPLATES.length < 200) {
  const title = EXTRA_REMINDER_TITLES[(REMINDER_TEMPLATES.length - 40) % EXTRA_REMINDER_TITLES.length];
  const mem = pick(ALL_MEM);
  const daysOut = rand(-5, 60);
  REMINDER_TEMPLATES.push({
    title, kind: pick(['time','bill','chore','school','medication']),
    rec: pick(['none','none','none','weekly','monthly','yearly']),
    days: daysOut, priority: pick(['low','medium','medium','high']),
    mem,
  });
}

await ins('family_reminders', REMINDER_TEMPLATES.slice(0, 200).map(r => {
  const daysVal = r.days ?? rand(0, 30);
  const remindAt = daysVal >= 0 ? daysFrom(daysVal) : daysAgo(-daysVal);
  const isCompleted = daysVal < -2 && Math.random() > 0.3;
  return {
    id: uuid(), family_id: FAMILY_ID,
    created_by: CB,
    member_id: r.mem?.id ?? null,
    title: r.title, notes: null,
    kind: r.kind, remind_at: remindAt,
    recurrence: r.rec ?? 'none',
    priority: r.priority ?? 'medium',
    status: isCompleted ? 'completed' : daysVal < 0 ? 'active' : 'active',
    completed_at: isCompleted ? remindAt : null,
    ai_suggested: Math.random() < 0.1,
    tags: [],
    created_at: daysAgo(rand(1, 90)),
  };
}));

// ══════════════════════════════════════════════════════════════════════════
// 7. FAMILY RECIPES (200)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Family Recipes ──');

const RECIPE_DEFS = [
  // Dinners (60)
  { name: 'Chicken Tacos',           cat: 'dinner',    cuisine: 'Mexican',   diff: 'easy',   prep: 15, cook: 20, serv: 6, fav: true,  rating: 5, times: 24,
    ing: [['chicken breast','1.5 lbs'],['flour tortillas','12'],['salsa','1 cup'],['shredded cheddar','1 cup'],['shredded lettuce','2 cups'],['avocado','2'],['lime','1'],['cumin','1 tsp'],['garlic powder','1 tsp']],
    ins: ['Season chicken with cumin and garlic powder','Cook chicken in pan 6-7 min per side','Shred chicken with forks','Warm tortillas','Assemble with toppings and a squeeze of lime'] },
  { name: 'Spaghetti Bolognese',     cat: 'dinner',    cuisine: 'Italian',   diff: 'medium', prep: 15, cook: 45, serv: 6, fav: true,  rating: 5, times: 31,
    ing: [['ground beef','1.5 lbs'],['spaghetti','1 lb'],['marinara sauce','24 oz'],['onion','1'],['garlic cloves','4'],['parmesan','½ cup'],['olive oil','2 tbsp'],['Italian seasoning','1 tbsp'],['salt and pepper','to taste']],
    ins: ['Cook pasta al dente, reserve 1 cup pasta water','Sauté onion and garlic in olive oil 5 min','Brown beef, drain fat','Add marinara and simmer 20 min','Toss with pasta, top with parmesan'] },
  { name: 'Grilled Salmon',          cat: 'dinner',    cuisine: 'American',  diff: 'easy',   prep: 10, cook: 15, serv: 4, fav: true,  rating: 4, times: 18,
    ing: [['salmon fillets','4 × 6oz'],['lemon','2'],['fresh dill','¼ cup'],['asparagus','1 lb'],['olive oil','2 tbsp'],['garlic','2 cloves'],['salt','to taste'],['black pepper','to taste']],
    ins: ['Preheat grill to medium-high','Brush salmon with oil, season well','Grill 4-5 min per side','Grill asparagus alongside 3-4 min','Serve with lemon wedges and dill'] },
  { name: 'Homemade Pizza',          cat: 'dinner',    cuisine: 'Italian',   diff: 'medium', prep: 30, cook: 15, serv: 8, fav: true,  rating: 5, times: 22,
    ing: [['pizza dough','1 ball'],['mozzarella','2 cups'],['pepperoni','60 slices'],['marinara sauce','1 cup'],['mushrooms','1 cup'],['olive oil','1 tbsp'],['garlic powder','½ tsp'],['dried oregano','½ tsp']],
    ins: ['Preheat oven to 475°F','Stretch dough on floured surface','Spread sauce leaving 1" border','Add cheese, toppings and seasonings','Bake 12-14 minutes until golden'] },
  { name: 'Chicken Stir-Fry',        cat: 'dinner',    cuisine: 'Asian',     diff: 'easy',   prep: 15, cook: 15, serv: 4, fav: false, rating: 4, times: 15,
    ing: [['chicken breast','1 lb'],['broccoli florets','2 cups'],['snap peas','1 cup'],['soy sauce','3 tbsp'],['fresh ginger','1 tsp'],['garlic','3 cloves'],['sesame oil','1 tbsp'],['cornstarch','1 tbsp'],['jasmine rice','2 cups']],
    ins: ['Cook rice per package','Toss chicken in cornstarch and soy','Heat wok over high, cook chicken','Add veggies and stir-fry 3-4 min','Add ginger, garlic, finish with sesame oil'] },
  { name: 'BBQ Baby Back Ribs',      cat: 'dinner',    cuisine: 'American',  diff: 'hard',   prep: 20, cook: 180, serv: 4, fav: true, rating: 5, times: 8,
    ing: [['baby back ribs','2 racks'],['BBQ sauce','1½ cups'],['brown sugar','¼ cup'],['smoked paprika','2 tbsp'],['garlic powder','1 tbsp'],['cumin','1 tsp'],['salt','2 tsp'],['coleslaw mix','1 bag'],['cornbread mix','1 box']],
    ins: ['Remove membrane from ribs','Rub with dry spice mix','Wrap in foil, bake at 300°F 2.5 hours','Unwrap, brush with BBQ sauce','Broil 5 min until caramelized'] },
  { name: 'Beef Tacos',              cat: 'dinner',    cuisine: 'Mexican',   diff: 'easy',   prep: 10, cook: 15, serv: 6, fav: true,  rating: 4, times: 19,
    ing: [['ground beef','1.5 lbs'],['taco seasoning','1 packet'],['taco shells','12'],['shredded cheese','1 cup'],['salsa','1 cup'],['sour cream','½ cup'],['lettuce','1 cup'],['tomato','1'],['jalapeño','1 optional']],
    ins: ['Brown beef in skillet','Add taco seasoning and ¼ cup water','Simmer 3 minutes','Warm shells per package','Assemble with desired toppings'] },
  { name: 'Chicken Soup',            cat: 'dinner',    cuisine: 'American',  diff: 'medium', prep: 20, cook: 60, serv: 8, fav: true,  rating: 5, times: 12,
    ing: [['whole chicken','3 lbs'],['carrots','3'],['celery stalks','3'],['onion','1'],['egg noodles','2 cups'],['chicken broth','6 cups'],['bay leaves','2'],['fresh parsley','¼ cup'],['salt and pepper','to taste']],
    ins: ['Simmer chicken in broth with bay leaves 40 min','Remove chicken, shred meat','Add vegetables, cook 15 min','Add noodles last 8 min','Season and stir in parsley'] },
  { name: 'Stuffed Bell Peppers',    cat: 'dinner',    cuisine: 'American',  diff: 'medium', prep: 20, cook: 40, serv: 6, fav: false, rating: 4, times: 9,
    ing: [['bell peppers','6'],['ground beef','1 lb'],['cooked rice','2 cups'],['marinara sauce','1 cup'],['mozzarella','1 cup'],['garlic','3 cloves'],['Italian seasoning','1 tsp'],['salt and pepper','to taste']],
    ins: ['Cut tops off peppers, remove seeds','Brown beef with garlic and seasoning','Mix in rice and half the sauce','Fill peppers, top with remaining sauce and cheese','Bake at 375°F 35-40 minutes'] },
  { name: 'Turkey Chili',            cat: 'dinner',    cuisine: 'American',  diff: 'easy',   prep: 15, cook: 45, serv: 8, fav: false, rating: 4, times: 11,
    ing: [['ground turkey','1.5 lbs'],['kidney beans','2 cans'],['diced tomatoes','2 cans'],['onion','1'],['chili powder','2 tbsp'],['cumin','1 tsp'],['garlic','3 cloves'],['chicken broth','1 cup'],['sour cream','for topping']],
    ins: ['Brown turkey with onion and garlic','Add spices, stir 1 minute','Add tomatoes, beans, and broth','Simmer 30-40 minutes','Serve with sour cream and cornbread'] },
];

// Generate 190 more recipes to reach 200
const MORE_RECIPES = [
  ['Shrimp Pasta','dinner','Italian','medium',20,25,4,true,4,13],
  ['Mac and Cheese','dinner','American','easy',10,20,6,true,5,28],
  ['Salmon Teriyaki','dinner','Asian','easy',10,15,4,false,4,7],
  ['Chicken Parmesan','dinner','Italian','medium',20,30,4,true,5,16],
  ['Beef Stew','dinner','American','medium',25,120,6,false,4,5],
  ['Pork Tenderloin','dinner','American','medium',15,30,4,false,4,6],
  ['Vegetable Curry','dinner','Indian','medium',20,30,4,false,4,8],
  ['Lasagna','dinner','Italian','hard',30,60,8,true,5,9],
  ['Fish Tacos','dinner','Mexican','easy',15,15,4,true,5,14],
  ['Pulled Pork','dinner','American','hard',20,480,8,true,5,7],
  ['Shrimp Tacos','dinner','Mexican','easy',15,10,4,false,4,8],
  ['Chicken Fajitas','dinner','Mexican','easy',15,15,4,true,5,17],
  ['Beef Enchiladas','dinner','Mexican','medium',25,30,6,false,4,6],
  ['Chicken Marsala','dinner','Italian','medium',15,25,4,false,4,5],
  ['Lamb Chops','dinner','Mediterranean','hard',20,15,4,false,4,3],
  ['Pad Thai','dinner','Asian','medium',20,15,4,true,5,11],
  ['Fried Rice','dinner','Asian','easy',10,15,4,true,4,20],
  ['Korean BBQ Bowls','dinner','Asian','medium',20,20,4,false,4,7],
  ['BLT Flatbread Pizza','dinner','American','easy',10,12,4,false,3,4],
  ['Butternut Squash Soup','dinner','American','easy',15,30,6,false,4,6],
  ['Meatloaf','dinner','American','easy',20,60,6,false,4,8],
  ['Clam Chowder','dinner','American','medium',20,30,4,true,5,5],
  ['Crab Cakes','dinner','American','medium',20,15,4,false,4,4],
  ['Eggplant Parmesan','dinner','Italian','medium',25,40,4,false,3,3],
  ['White Chicken Chili','dinner','American','easy',15,30,6,true,5,13],
  ['Sloppy Joes','dinner','American','easy',10,20,6,false,4,7],
  ['Chicken Pot Pie','dinner','American','hard',30,45,6,true,5,6],
  ['Pork Fried Rice','dinner','Asian','easy',15,20,4,false,4,9],
  ['Beef Bulgogi','dinner','Asian','medium',20,15,4,false,4,5],
  ['Chicken Shawarma','dinner','Mediterranean','medium',20,25,4,true,5,8],
  // Breakfasts (30)
  ['Pancake Stack','breakfast','American','easy',10,15,4,true,5,32],
  ['Avocado Toast','breakfast','American','easy',5,5,2,true,4,25],
  ['Smoothie Bowl','breakfast','American','easy',10,0,2,false,4,18],
  ['Eggs Benedict','breakfast','American','medium',20,20,2,false,5,8],
  ['French Toast','breakfast','American','easy',10,15,4,true,5,22],
  ['Belgian Waffles','breakfast','American','easy',15,20,4,true,5,15],
  ['Breakfast Burritos','breakfast','Mexican','easy',15,15,4,true,5,19],
  ['Overnight Oats','breakfast','American','easy',10,0,2,false,4,30],
  ['Acai Bowl','breakfast','American','easy',10,0,1,false,4,12],
  ['Shakshuka','breakfast','Mediterranean','medium',10,20,4,false,4,7],
  ['Greek Yogurt Parfait','breakfast','American','easy',5,0,2,false,4,20],
  ['Banana Bread','breakfast','American','easy',15,60,8,true,5,14],
  ['Cinnamon Rolls','breakfast','American','hard',60,30,12,true,5,6],
  ['Vegetable Frittata','breakfast','Italian','medium',15,25,4,false,4,8],
  ['Blueberry Muffins','breakfast','American','easy',15,25,12,true,5,11],
  ['Chia Seed Pudding','breakfast','American','easy',5,0,2,false,4,15],
  ['Denver Omelette','breakfast','American','easy',10,10,2,false,4,9],
  ['Peanut Butter Granola','breakfast','American','easy',10,30,8,false,4,7],
  ['Lemon Ricotta Pancakes','breakfast','American','medium',15,20,4,false,5,5],
  ['Breakfast Quesadillas','breakfast','Mexican','easy',10,10,2,true,4,12],
  ['Bagel with Lox','breakfast','American','easy',5,0,2,false,4,8],
  ['Egg Muffin Cups','breakfast','American','easy',10,25,12,false,4,13],
  ['Pumpkin Spice Oatmeal','breakfast','American','easy',5,10,2,false,3,7],
  ['Strawberry Crepes','breakfast','French','medium',15,15,6,true,5,6],
  ['Coconut Granola','breakfast','American','easy',10,25,8,false,4,9],
  ['Turkey Sausage Breakfast Sandwich','breakfast','American','easy',10,10,2,false,4,7],
  ['Cottage Cheese Bowl','breakfast','American','easy',5,0,1,false,4,10],
  ['Spinach Feta Omelette','breakfast','American','easy',5,10,2,false,4,11],
  ['Protein Pancakes','breakfast','American','easy',10,15,4,false,4,14],
  ['Apple Cinnamon Waffles','breakfast','American','easy',15,20,4,true,5,8],
  // Lunches (30)
  ['Caesar Salad','lunch','American','easy',15,10,4,true,5,20],
  ['BLT Sandwich','lunch','American','easy',10,10,2,true,5,18],
  ['Chicken Quesadillas','lunch','Mexican','easy',10,10,4,true,5,22],
  ['Greek Salad Bowl','lunch','Mediterranean','easy',15,0,4,false,4,15],
  ['Tomato Basil Soup','lunch','Italian','easy',15,30,4,true,5,12],
  ['Turkey Club Sandwich','lunch','American','easy',10,5,2,false,4,9],
  ['Tuna Salad Wrap','lunch','American','easy',10,0,2,false,4,11],
  ['Caprese Salad','lunch','Italian','easy',10,0,4,false,4,8],
  ['Lentil Soup','lunch','Mediterranean','easy',15,40,6,false,4,7],
  ['Asian Noodle Salad','lunch','Asian','easy',15,0,4,false,4,9],
  ['Chicken Noodle Soup','lunch','American','easy',15,30,6,true,5,10],
  ['Veggie Wrap','lunch','American','easy',10,0,2,false,4,12],
  ['Falafel Bowl','lunch','Mediterranean','medium',20,20,4,false,4,6],
  ['Black Bean Burrito','lunch','Mexican','easy',10,10,2,false,4,8],
  ['Egg Salad Sandwich','lunch','American','easy',10,0,2,false,3,7],
  ['Minestrone Soup','lunch','Italian','easy',20,30,6,false,4,5],
  ['Pita with Hummus','lunch','Mediterranean','easy',5,0,2,false,4,15],
  ['Shrimp Avocado Salad','lunch','American','medium',15,5,2,false,4,6],
  ['French Onion Soup','lunch','French','medium',15,45,4,false,4,5],
  ['Chicken Caesar Wrap','lunch','American','easy',10,0,2,true,5,14],
  ['Gazpacho','lunch','Spanish','easy',15,0,4,false,3,3],
  ['Niçoise Salad','lunch','French','medium',20,10,4,false,4,4],
  ['Miso Soup','lunch','Asian','easy',5,10,4,false,4,11],
  ['Loaded Baked Potato','lunch','American','easy',5,60,1,true,4,7],
  ['Pasta Salad','lunch','Italian','easy',15,10,6,false,4,8],
  ['Club Wrap','lunch','American','easy',10,0,2,false,4,9],
  ['Corn Chowder','lunch','American','medium',15,25,4,false,4,6],
  ['Veggie Burger','lunch','American','easy',10,10,2,false,4,7],
  ['Chicken Naan Pizza','lunch','Indian','easy',10,12,2,false,4,5],
  ['Waldorf Salad','lunch','American','easy',15,0,4,false,4,4],
  // Desserts (20)
  ['Chocolate Chip Cookies','dessert','American','easy',15,12,24,true,5,35],
  ['Brownies','dessert','American','easy',15,25,16,true,5,28],
  ['Apple Pie','dessert','American','hard',45,60,8,true,5,10],
  ['Chocolate Cake','dessert','American','medium',20,35,12,true,5,14],
  ['Vanilla Ice Cream','dessert','American','medium',30,0,8,true,5,6],
  ['Cheesecake','dessert','American','hard',30,60,12,true,5,8],
  ['Banana Pudding','dessert','American','easy',20,0,8,true,5,11],
  ['Carrot Cake','dessert','American','medium',30,35,12,false,4,5],
  ['Blueberry Cobbler','dessert','American','easy',15,40,8,false,4,7],
  ['Rice Krispie Treats','dessert','American','easy',10,5,12,true,5,20],
  ['Tiramisu','dessert','Italian','hard',30,240,8,false,5,4],
  ['Peanut Butter Cookies','dessert','American','easy',15,10,24,true,5,16],
  ['Lemon Bars','dessert','American','medium',20,40,16,false,4,6],
  ['Cinnamon Apple Crisp','dessert','American','easy',15,40,6,true,5,9],
  ['Churros','dessert','Mexican','medium',15,10,6,false,4,5],
  ['Strawberry Shortcake','dessert','American','easy',20,15,6,true,5,7],
  ['Peach Cobbler','dessert','American','easy',15,40,8,true,5,6],
  ['No-Bake Energy Balls','snack','American','easy',15,0,12,false,4,13],
  ['Fruit Salad','snack','American','easy',15,0,6,false,4,18],
  ['Guacamole','snack','Mexican','easy',10,0,6,true,5,22],
];

const fullRecipes = [...RECIPE_DEFS];
for (const r of MORE_RECIPES) {
  const [name,cat,cuisine,diff,prep,cook,serv,fav,rating,times] = r;
  const simpleIng = [
    ['main ingredient','1 lb'],['supporting ingredient','2 cups'],
    ['seasoning','to taste'],['oil','1 tbsp'],['water or broth','as needed'],
  ];
  const simpleIns = [
    `Prepare all ingredients`,`Cook main ingredient over medium heat`,
    `Add supporting ingredients and seasonings`,`Simmer until done`,`Serve and enjoy`,
  ];
  fullRecipes.push({ name, cat, cuisine, diff, prep, cook, serv, fav, rating, times,
    ing: simpleIng, ins: simpleIns });
}

const TAGS_BY_CAT = {
  dinner:    ['family-favorite','weeknight','weekend','slow-cooker','grilling','one-pot'],
  breakfast: ['quick','meal-prep','healthy','weekend','kids-love'],
  lunch:     ['quick','healthy','meal-prep','work-lunch'],
  dessert:   ['special-occasion','kids-love','baking','holiday'],
  snack:     ['quick','healthy','kids-love'],
  other:     ['family-favorite'],
};

await ins('family_recipes', fullRecipes.slice(0, 200).map(r => ({
  id: uuid(), family_id: FAMILY_ID,
  name: r.name, category: r.cat, cuisine: r.cuisine, difficulty: r.diff,
  servings: r.serv, prep_time_mins: r.prep, cook_time_mins: r.cook,
  ingredients: (r.ing ?? []).map(([name, qty]) => ({ name, quantity: qty, unit: '' })),
  instructions: (r.ins ?? []).map((text, i) => ({ step: i + 1, text })),
  is_favorite: r.fav ?? false,
  rating: r.rating ?? null,
  times_made: r.times ?? 0,
  last_made_at: r.times > 0 ? daysAgo(rand(1, 60)) : null,
  tags: pickN(TAGS_BY_CAT[r.cat] ?? TAGS_BY_CAT.other, rand(1, 3)),
  allergy_flags: [],
  description: `A family staple — everyone loves this ${r.name.toLowerCase()}.`,
  created_by: CB,
  created_at: daysAgo(rand(10, 400)),
})));

// ══════════════════════════════════════════════════════════════════════════
// 8. TODO LISTS (10)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── To-Do Lists ──');

const listDefs = [
  { name: 'Family Tasks',       icon: '🏠', color: 'violet',  shared: true  },
  { name: 'Daniel Work',        icon: '💼', color: 'blue',    shared: false },
  { name: 'Sarah Personal',     icon: '⭐', color: 'rose',    shared: false },
  { name: 'Home Projects',      icon: '🔨', color: 'amber',   shared: true  },
  { name: 'Back to School',     icon: '📚', color: 'blue',    shared: true  },
  { name: 'Summer 2026',        icon: '☀️', color: 'amber',   shared: true  },
  { name: 'Vacation Planning',  icon: '✈️', color: 'teal',    shared: true  },
  { name: 'Emma School Tasks',  icon: '🎓', color: 'green',   shared: false },
  { name: 'Health & Wellness',  icon: '💪', color: 'green',   shared: false },
  { name: 'Someday / Maybe',    icon: '💡', color: 'rose',    shared: false },
];

const listRows = listDefs.map(l => ({
  id: uuid(), family_id: FAMILY_ID,
  name: l.name, icon: l.icon, color: l.color, is_shared: l.shared,
  created_by: DANIEL_MID,
  created_at: daysAgo(rand(5, 60)),
}));
const insertedLists = await ins('todo_lists', listRows);
const listIds = insertedLists.map(r => r.id);

// ══════════════════════════════════════════════════════════════════════════
// 9. TODO ITEMS (200)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── To-Do Items ──');

const TODO_ITEMS = [
  // Family Tasks
  { t: 'Schedule family photos for fall',       pri: 'medium', days: 30,  done: false, list: 0, tag: 'photos' },
  { t: 'Plan Thanksgiving menu',                pri: 'low',    days: 150, done: false, list: 0, tag: 'holiday' },
  { t: 'Buy birthday gift for Grandma Ruth',    pri: 'urgent', days: 0,   done: false, list: 0, tag: 'gift' },
  { t: 'Book camping site for July',            pri: 'high',   days: 10,  done: false, list: 0, tag: 'vacation' },
  { t: 'Renew all passports',                   pri: 'high',   days: 60,  done: false, list: 0, tag: null },
  { t: 'Update emergency contact list at schools',pri:'medium',days: 7,   done: false, list: 0, tag: 'school' },
  { t: 'Order Jackson birthday party invitations', pri:'high', days: 14,  done: false, list: 0, tag: null },
  { t: 'Donate old clothes and toys',           pri: 'low',    days: null,done: false, list: 0, tag: null },
  { t: 'Sign all kids up for fall sports',      pri: 'medium', days: 30,  done: false, list: 0, tag: 'sports' },
  { t: 'Deep clean fridge',                     pri: 'low',    days: null,done: true,  list: 0, tag: null },
  { t: 'Replace batteries in remotes',          pri: 'low',    days: null,done: true,  list: 0, tag: null },
  { t: 'Get family flu shots',                  pri: 'high',   days: 90,  done: false, list: 0, tag: 'health' },
  // Daniel Work
  { t: 'Finish Q2 performance reviews',         pri: 'urgent', days: 3,   done: false, list: 1, tag: 'work' },
  { t: 'Prepare Denver presentation',           pri: 'high',   days: 2,   done: false, list: 1, tag: 'work' },
  { t: 'Update LinkedIn profile',               pri: 'low',    days: null,done: false, list: 1, tag: null },
  { t: 'Schedule team off-site',                pri: 'medium', days: 30,  done: false, list: 1, tag: 'work' },
  { t: 'Expense report — June',                 pri: 'high',   days: 5,   done: false, list: 1, tag: 'work' },
  { t: 'Review Q3 budget proposal',             pri: 'high',   days: 7,   done: false, list: 1, tag: 'work' },
  { t: 'Call insurance broker about policy',    pri: 'medium', days: 10,  done: false, list: 1, tag: null },
  { t: 'Complete mandatory training modules',   pri: 'medium', days: 14,  done: false, list: 1, tag: 'work' },
  { t: 'Send thank you email to team',          pri: 'low',    days: 1,   done: true,  list: 1, tag: null },
  { t: 'Book hotel for Denver conference',      pri: 'urgent', days: 1,   done: true,  list: 1, tag: 'travel' },
  // Sarah Personal
  { t: 'Schedule hair appointment',             pri: 'low',    days: 7,   done: false, list: 2, tag: null },
  { t: 'Finish reading club book',              pri: 'medium', days: 6,   done: false, list: 2, tag: 'reading' },
  { t: 'Start morning yoga routine',            pri: 'medium', days: null,done: false, list: 2, tag: 'health' },
  { t: 'Call sister for birthday',              pri: 'high',   days: 2,   done: false, list: 2, tag: null },
  { t: 'Research online classes for fall',      pri: 'low',    days: 45,  done: false, list: 2, tag: null },
  { t: 'Plan girls trip with Jennifer',         pri: 'low',    days: null,done: false, list: 2, tag: 'travel' },
  { t: 'Organize kids school papers binder',    pri: 'medium', days: 14,  done: false, list: 2, tag: 'school' },
  { t: 'Update family address in accounts',     pri: 'low',    days: null,done: true,  list: 2, tag: null },
  // Home Projects
  { t: 'Get quotes for kitchen remodel',        pri: 'high',   days: 14,  done: false, list: 3, tag: 'kitchen' },
  { t: 'Paint guest bedroom',                   pri: 'medium', days: 30,  done: false, list: 3, tag: 'painting' },
  { t: 'Fix back gate latch',                   pri: 'medium', days: 7,   done: false, list: 3, tag: null },
  { t: 'Organize garage storage',               pri: 'low',    days: null,done: false, list: 3, tag: null },
  { t: 'Install new outdoor light fixture',     pri: 'low',    days: null,done: false, list: 3, tag: null },
  { t: 'Replace kitchen faucet',                pri: 'high',   days: 7,   done: false, list: 3, tag: 'plumbing' },
  { t: 'Build garden bed in backyard',          pri: 'low',    days: null,done: false, list: 3, tag: 'garden' },
  { t: 'Power wash deck and patio',             pri: 'medium', days: 14,  done: false, list: 3, tag: null },
  { t: 'Repair fence section on east side',     pri: 'medium', days: 21,  done: false, list: 3, tag: null },
  { t: 'Install ceiling fan in master bedroom', pri: 'medium', days: null,done: false, list: 3, tag: null },
  { t: 'Organize laundry room shelves',         pri: 'low',    days: null,done: true,  list: 3, tag: null },
  // Back to School
  { t: 'Buy school supplies for Emma',          pri: 'high',   days: 40,  done: false, list: 4, tag: 'emma' },
  { t: 'Buy school supplies for Jackson',       pri: 'high',   days: 40,  done: false, list: 4, tag: 'jackson' },
  { t: 'Buy school supplies for Lily',          pri: 'high',   days: 40,  done: false, list: 4, tag: 'lily' },
  { t: 'Register Emma for AP classes',          pri: 'urgent', days: 5,   done: false, list: 4, tag: 'emma' },
  { t: 'Get Jackson new backpack',              pri: 'medium', days: 35,  done: false, list: 4, tag: 'jackson' },
  { t: 'Update carpool schedule',               pri: 'medium', days: 35,  done: false, list: 4, tag: null },
  { t: 'Meet Lily new kindergarten teacher',    pri: 'medium', days: 30,  done: false, list: 4, tag: 'lily' },
  { t: 'Sign up for school lunch accounts',     pri: 'high',   days: 35,  done: false, list: 4, tag: null },
  { t: 'Buy new gym shoes for Jackson',         pri: 'medium', days: 35,  done: false, list: 4, tag: 'jackson' },
  { t: 'Update emergency contacts at schools',  pri: 'high',   days: 30,  done: false, list: 4, tag: null },
  // Summer 2026
  { t: 'Book swimming lessons for Lily',        pri: 'high',   days: 7,   done: true,  list: 5, tag: 'lily' },
  { t: 'Sign Emma up for SAT prep',             pri: 'high',   days: 5,   done: true,  list: 5, tag: 'emma' },
  { t: 'Research day camp for Lily',            pri: 'medium', days: 14,  done: false, list: 5, tag: 'lily' },
  { t: 'Plan 4th of July party',                pri: 'high',   days: 14,  done: false, list: 5, tag: 'holiday' },
  { t: 'Get pool ready for season',             pri: 'high',   days: 0,   done: true,  list: 5, tag: null },
  { t: 'Plan camping trip logistics',           pri: 'high',   days: 10,  done: false, list: 5, tag: 'camping' },
  { t: 'Buy new pool toys',                     pri: 'low',    days: 7,   done: false, list: 5, tag: null },
  { t: 'Sign Jackson up for summer baseball',   pri: 'medium', days: 3,   done: false, list: 5, tag: 'jackson' },
  { t: 'Order summer reading books for kids',   pri: 'medium', days: 7,   done: false, list: 5, tag: 'reading' },
  { t: 'Get sunscreen subscription',            pri: 'low',    days: null,done: false, list: 5, tag: null },
  // Vacation Planning
  { t: 'Research Big Island hotels',            pri: 'medium', days: 90,  done: false, list: 6, tag: 'hawaii' },
  { t: 'Book flights to Hawaii for 2027',       pri: 'medium', days: 180, done: false, list: 6, tag: 'hawaii' },
  { t: 'Research snorkeling tours',             pri: 'low',    days: 180, done: false, list: 6, tag: 'hawaii' },
  { t: 'Look into Disney World Grand Floridian',pri: 'low',    days: null,done: false, list: 6, tag: 'disney' },
  { t: 'Price Alaska cruise for summer 2027',   pri: 'low',    days: null,done: false, list: 6, tag: null },
  { t: 'Check kids passport expiration',        pri: 'high',   days: 7,   done: false, list: 6, tag: null },
  { t: 'Look into travel insurance',            pri: 'medium', days: 60,  done: false, list: 6, tag: null },
  // Emma School Tasks
  { t: 'Start Common App account',              pri: 'urgent', days: 7,   done: false, list: 7, tag: 'college' },
  { t: 'Request teacher recommendations',       pri: 'urgent', days: 14,  done: false, list: 7, tag: 'college' },
  { t: 'Draft main college essay',              pri: 'high',   days: 30,  done: false, list: 7, tag: 'college' },
  { t: 'Research target school list',           pri: 'high',   days: 21,  done: false, list: 7, tag: 'college' },
  { t: 'Schedule college campus visits',        pri: 'medium', days: 45,  done: false, list: 7, tag: 'college' },
  { t: 'Study for AP Chemistry exam',           pri: 'urgent', days: 5,   done: false, list: 7, tag: 'ap-exams' },
  { t: 'Finish physics lab report',             pri: 'urgent', days: 5,   done: false, list: 7, tag: 'school' },
  { t: 'Sign up for volunteer club',            pri: 'medium', days: 10,  done: false, list: 7, tag: 'extracurricular' },
  { t: 'Buy SAT prep book',                     pri: 'high',   days: 3,   done: true,  list: 7, tag: 'sat' },
  { t: 'Fill out scholarship applications',     pri: 'medium', days: 60,  done: false, list: 7, tag: 'college' },
  // Health & Wellness
  { t: 'Schedule annual physical — Daniel',     pri: 'high',   days: 30,  done: false, list: 8, tag: null },
  { t: 'Start couch to 5K program',             pri: 'medium', days: null,done: false, list: 8, tag: 'running' },
  { t: 'Track water intake daily',              pri: 'medium', days: null,done: false, list: 8, tag: 'health' },
  { t: 'Meal prep every Sunday',                pri: 'medium', days: null,done: false, list: 8, tag: 'food' },
  { t: 'Get standing desk for home office',     pri: 'low',    days: null,done: false, list: 8, tag: null },
  { t: 'Schedule eye exams for whole family',   pri: 'medium', days: 30,  done: false, list: 8, tag: null },
  { t: 'Research family therapist',             pri: 'low',    days: null,done: false, list: 8, tag: null },
  { t: 'Buy yoga mat and blocks for Sarah',     pri: 'low',    days: null,done: true,  list: 8, tag: null },
  { t: 'Sign Daniel up for golf lessons',       pri: 'low',    days: null,done: false, list: 8, tag: 'hobby' },
  { t: 'Research sleep tracking options',       pri: 'low',    days: null,done: false, list: 8, tag: null },
  // Someday / Maybe
  { t: 'Write family history book',             pri: 'low',    days: null,done: false, list: 9, tag: null },
  { t: 'Learn to speak conversational Spanish', pri: 'low',    days: null,done: false, list: 9, tag: 'learning' },
  { t: 'Build a treehouse for kids',            pri: 'low',    days: null,done: false, list: 9, tag: null },
  { t: 'Get a second dog someday',              pri: 'low',    days: null,done: false, list: 9, tag: null },
  { t: 'Start a family podcast or YouTube',     pri: 'low',    days: null,done: false, list: 9, tag: null },
  { t: 'Go on a family mission trip',           pri: 'low',    days: null,done: false, list: 9, tag: null },
  { t: 'Take ballroom dance lessons',           pri: 'low',    days: null,done: false, list: 9, tag: null },
  { t: 'Host a foreign exchange student',       pri: 'low',    days: null,done: false, list: 9, tag: null },
  { t: 'Invest in rental property',             pri: 'low',    days: null,done: false, list: 9, tag: null },
  { t: 'Take kids to see Northern Lights',      pri: 'low',    days: null,done: false, list: 9, tag: 'travel' },
];

// Fill to 200 with more realistic tasks
const EXTRA_TASKS = [
  ['Call insurance about claim','medium',7,false,0],['Organize the pantry again','low',null,true,3],
  ['Fix the creaky stair','low',null,false,3],['Order replacement light bulbs','low',null,false,3],
  ['Return Amazon packages','medium',2,false,2],['Schedule vet appointment for Captain','high',7,false,0],
  ['Research solar panel installers','medium',21,false,3],['Start Christmas list','low',180,false,9],
  ['Watch documentary — Emma recommends','low',null,false,9],['Call financial advisor','high',14,false,1],
  ['Review and update estate documents','high',30,false,1],['Submit FSA receipts','urgent',3,false,1],
  ['Order custom family ornaments','low',150,false,9],['Write thank you notes — graduation','medium',7,false,2],
  ['Get new doormat','low',null,false,3],['Buy Jackson cleats size 4.5','high',4,false,0],
  ['Emma needs new running shoes','medium',10,false,0],['Research orthodontist for Lily','medium',30,false,0],
  ['Clean out car — both cars','low',null,false,0],['Buy new Tupperware set','low',null,true,2],
  ['Get car detail before road trip','medium',7,false,5],['Print and frame family photos','low',null,false,9],
  ['Research college financial aid','high',21,false,7],['Teach Emma to drive — parking lots','high',14,false,0],
  ['Jackson book report — due Friday','urgent',4,false,7],['Sign Lily up for art class','medium',14,false,0],
  ['Get lawnmower serviced','medium',7,false,3],['Replace welcome mat','low',null,true,3],
  ['Update antivirus on all computers','medium',7,false,1],['Back up family photos','high',3,false,1],
  ['Download travel apps for trip','low',1,false,6],['Pack camping gear check','high',9,false,5],
  ['Make dentist appointments — all kids','high',14,false,0],['Research tutors for Jackson math','medium',10,false,4],
  ['Get new library cards','low',null,false,0],['Set up Bubaly for all members','high',0,true,0],
  ['Plan Emma sweet 16 party','medium',120,false,0],['Get new outdoor grill cover','low',null,false,3],
  ['Fix leaky faucet — master bath','high',3,false,3],['Winterize irrigation system','medium',120,false,3],
  ['Research 529 plan options','medium',14,false,1],['Max out Roth IRA this year','high',180,false,1],
  ['Sign up for food co-op delivery','low',null,false,2],['Label all kids water bottles','low',null,true,4],
  ['Get noise canceling headphones','low',null,false,9],['Research home warranty companies','medium',30,false,3],
  ['Plan neighborhood cookout','medium',14,false,0],['Organize command center in kitchen','medium',7,false,3],
  ['Get Lily rain boots','medium',3,false,0],['Emma needs prom dress alteration','high',14,false,7],
  ['Jackson needs new PE uniform','medium',30,false,4],['Buy board game for family night','low',null,false,0],
  ['Schedule professional cleaning service','medium',14,false,3],['Research preschool for Lily next year','high',30,false,2],
  ['Order personalized stockings','low',150,false,9],['Get outdoor string lights','low',null,false,3],
  ['Update Bubaly emergency contacts','high',1,false,0],['Scan and digitize old family photos','low',null,false,9],
  ['Find soccer tournament schedule','high',5,false,5],['Research coding camp for Jackson','medium',21,false,5],
  ['Buy Lily new bike helmet','high',7,false,0],['Get grills cleaned and serviced','medium',7,false,3],
  ['Organize kids room — seasonal rotation','medium',14,false,3],['Buy new reusable grocery bags','low',null,true,2],
  ['Schedule dog heartworm check','high',14,false,0],['Set up automatic savings transfer','high',3,false,1],
  ['Write letters to kids for their 18th bdays','low',null,false,9],['Research local volunteer opportunities','medium',null,false,9],
  ['Get Daniel new dress shirts for work','low',14,false,2],['Buy new pillows for master bedroom','low',null,false,3],
  ['Organize kids artwork — frame favorites','low',null,false,9],['Update kids heights on door frame','low',null,false,0],
  ['Sign birthday cards in advance','medium',5,false,2],['Set up kids chore app','medium',2,false,0],
  ['Plan anniversary dinner reservation','high',10,false,2],['Buy Lily dress for Grandma party','medium',8,false,0],
  ['Order sports gear for fall','medium',40,false,5],['Get Jackson math tutor','high',7,false,4],
  ['Complete kitchen remodel design board','medium',14,false,3],['Research dishwasher replacement','low',null,false,3],
  ['Get air quality test at home','low',null,false,3],['Buy insulated lunch boxes — school','medium',35,false,4],
  ['Research piano practice apps for Emma','low',null,false,9],['Update emergency binder','high',7,false,0],
  ['Print school year calendar','medium',5,false,4],['Set phone-free dinner rule','medium',null,false,0],
  ['Get family DNA test kits','low',null,false,9],['Research local hiking trails','low',null,false,5],
  ['Buy camping sleeping bag — Jackson','high',9,false,5],['Repaint front door','medium',30,false,3],
  ['Get dog professionally trained','medium',30,false,0],['Organize bathroom cabinet','low',null,true,2],
  ['Apply sunscreen before school rule','high',1,false,0],['Sign permission slip for Jackson','urgent',1,false,0],
  ['Emma driving practice — highway','high',14,false,0],['Buy new Chromebook for Jackson school','high',35,false,4],
];

while (TODO_ITEMS.length < 200) {
  const extra = EXTRA_TASKS[(TODO_ITEMS.length - 100) % EXTRA_TASKS.length];
  TODO_ITEMS.push({ t: extra[0], pri: extra[1], days: extra[2], done: extra[3], list: extra[4], tag: null });
}

const assignees = [DANIEL_MID, DANIEL_MID, null, null, ...ALL_MIDS];
await ins('todo_items', TODO_ITEMS.slice(0, 200).map(item => {
  const listId = listIds[item.list] ?? pick(listIds);
  const dueDate = item.days !== null ? dateStr(item.days >= 0 ? item.days : 0) : null;
  return {
    id: uuid(), family_id: FAMILY_ID,
    list_id: listId,
    created_by: DANIEL_MID,
    assigned_to_id: Math.random() > 0.6 ? pick(assignees) : null,
    title: item.t,
    notes: Math.random() > 0.7 ? 'Added from family planning session' : null,
    is_done: item.done ?? false,
    priority: item.pri ?? 'medium',
    due_date: dueDate,
    tags: item.tag ? [item.tag] : [],
    sort_order: TODO_ITEMS.indexOf(item),
    completed_at: item.done ? daysAgo(rand(1, 7)) : null,
    created_at: daysAgo(rand(1, 60)),
  };
}));

// ══════════════════════════════════════════════════════════════════════════
console.log('\n✅ Core Platform seed complete!');
console.log('   family_conversations: 10');
console.log('   family_messages:      200');
console.log('   family_albums:        15');
console.log('   family_photos:        200');
console.log('   family_contacts:      200');
console.log('   family_reminders:     200');
console.log('   family_recipes:       200');
console.log('   todo_lists:           10');
console.log('   todo_items:           200');
