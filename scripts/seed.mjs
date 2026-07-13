import { createSeedClient, requireSeedScope } from './seed-client.mjs';

const sb = createSeedClient();
const { familyId: FAMILY_ID, createdByUserId: DANIEL_USER_ID } = requireSeedScope();

const CB              = DANIEL_USER_ID; // created_by alias — always a valid auth user

const uuid = () => crypto.randomUUID();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const today = new Date('2026-06-19');
const daysAgo  = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString(); };
const daysFrom = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString(); };
const dateStr  = (n) => daysFrom(n).slice(0, 10);
const timeAt   = (base, h, m=0) => { const d = new Date(base); d.setHours(h, m, 0, 0); return d.toISOString(); };

async function ins(table, rows) {
  if (!rows.length) { console.log(`  – ${table}: 0 rows, skip`); return []; }
  const { data, error } = await sb.from(table).insert(rows).select('id');
  if (error) throw new Error(`Seed insert failed for ${table}: ${error.message}`);
  console.log(`  ✓ ${table}: +${rows.length}`);
  return data ?? [];
}

// ─── look up real member IDs ────────────────────────────────────────────────
const { data: mems, error: memberError } = await sb.from('family_members').select('id, display_name').eq('family_id', FAMILY_ID);
if (memberError) throw new Error(`Could not load seed members: ${memberError.message}`);
console.log('Members in DB:', mems?.map(m => `${m.display_name}:${m.id}`));

const memByName = new Map(mems?.map(m => [m.display_name, m.id]) ?? []);
const memberId = (name) => {
  const id = memByName.get(name);
  if (!id) throw new Error(`Seed family ${FAMILY_ID} is missing required member "${name}".`);
  return id;
};
const SARAH   = memberId('Sarah');
const EMMA    = memberId('Emma');
const JACKSON = memberId('Jackson');
const LILY    = memberId('Lily');
const GRANDMA = memberId('Grandma Ruth');
const DANIEL  = memberId('Daniel');

const ALL_MEM = [DANIEL, SARAH, EMMA, JACKSON, LILY];
const KIDS    = [EMMA, JACKSON, LILY];

// ─── STEP 1: Calendar Events ───────────────────────────────────────────────
console.log('\n── Calendar Events ──');
const CAT = ['general','school','sports','appointment','medication','maintenance','holiday','other'];
const calEvents = [];

for (let i = 60; i >= 1; i--) {
  if (Math.random() > 0.55) continue;
  const base = daysAgo(i);
  calEvents.push({
    id: uuid(), family_id: FAMILY_ID, created_by: CB,
    title: pick(['Family dinner','Doctor visit','Soccer practice','Piano lesson','Library trip','Movie night','Bike ride','Park visit','Grocery run','Date night']),
    category: pick(CAT), starts_at: timeAt(base, rand(8,19)), all_day: false, recurrence: 'none',
    assignee_id: pick([...ALL_MEM, null, null]),
  });
}

const futureEvents = [
  { title: 'Emma Piano Recital',           cat: 'school',       day: 3,  h: 18, mem: EMMA,    loc: 'Harmony Music School' },
  { title: 'Jackson Soccer Game vs Eagles',cat: 'sports',       day: 5,  h: 10, mem: JACKSON, loc: 'Eastside Sports Complex' },
  { title: 'Lily Ballet Performance',      cat: 'general',      day: 7,  h: 14, mem: LILY,    loc: 'City Arts Center' },
  { title: 'Daniel Work Conference',       cat: 'general',      day: 4,  h: 9,  mem: DANIEL,  loc: 'Downtown Convention Center' },
  { title: 'Sarah Book Club',              cat: 'general',      day: 6,  h: 19, mem: SARAH,   loc: 'Oak Street Library' },
  { title: 'Family BBQ at Grandmas House', cat: 'general',      day: 8,  h: 12, mem: null,    loc: "Grandma Ruth's, 45 Elm St" },
  { title: 'Emma SAT Prep Class',          cat: 'school',       day: 9,  h: 13, mem: EMMA,    loc: 'Kaplan Learning Center' },
  { title: 'Jackson Dental Checkup',       cat: 'appointment',  day: 10, h: 9,  mem: JACKSON, loc: 'Bright Smiles Dental' },
  { title: 'Lily Pediatrician Visit',      cat: 'appointment',  day: 12, h: 11, mem: LILY,    loc: 'Sunshine Pediatrics' },
  { title: 'Daniel Golf with Clients',     cat: 'general',      day: 11, h: 8,  mem: DANIEL,  loc: 'Pinehurst Golf Club' },
  { title: 'Sarah Yoga Class',             cat: 'general',      day: 2,  h: 7,  mem: SARAH,   loc: 'Harmony Yoga Studio' },
  { title: 'July 4th Celebration',         cat: 'holiday',      day: 15, h: 16, mem: null,    loc: 'City Park' },
  { title: 'Emma Summer Camp Drop-off',    cat: 'school',       day: 20, h: 8,  mem: EMMA,    loc: 'Camp Pinewood' },
  { title: 'Jackson Baseball Game',        cat: 'sports',       day: 13, h: 9,  mem: JACKSON, loc: 'Memorial Stadium' },
  { title: 'Family Movie Night',           cat: 'general',      day: 14, h: 19, mem: null },
  { title: 'Grandma Ruth Birthday Party',  cat: 'general',      day: 18, h: 15, mem: GRANDMA, loc: 'Hughen Home' },
  { title: 'Car Service Honda Pilot',      cat: 'maintenance',  day: 16, h: 9,  mem: DANIEL,  loc: 'Honda Dealer Service' },
  { title: 'HOA Meeting',                  cat: 'general',      day: 17, h: 19, mem: DANIEL,  loc: 'Community Center' },
  { title: 'Sarah Haircut',               cat: 'general',      day: 19, h: 14, mem: SARAH,   loc: 'Style Studio' },
  { title: 'Emma Orthodontist',            cat: 'appointment',  day: 21, h: 15, mem: EMMA,    loc: 'Straight Smiles Ortho' },
  { title: 'Lily Swimming Lessons',        cat: 'sports',       day: 1,  h: 10, mem: LILY,    loc: 'Community Pool' },
  { title: 'Daniel Flight to Denver',      cat: 'general',      day: 22, h: 6,  mem: DANIEL,  loc: 'Airport Terminal B' },
  { title: 'Family Camping Trip Day 1',    cat: 'holiday',      day: 30, h: 7,  mem: null },
  { title: 'Jackson Birthday Party',       cat: 'general',      day: 35, h: 14, mem: JACKSON, loc: 'Laser Quest' },
  { title: 'Back to School Shopping',      cat: 'school',       day: 40, h: 10, mem: null,    loc: 'Eastfield Mall' },
  { title: 'Today — Emma Dentist',         cat: 'appointment',  day: 0,  h: 9,  mem: EMMA,    loc: 'Bright Smiles Dental' },
  { title: 'Today — Soccer Practice',      cat: 'sports',       day: 0,  h: 15, mem: JACKSON, loc: 'Riverside Soccer Fields' },
  { title: 'Today — Family Tacos Night',   cat: 'general',      day: 0,  h: 18, mem: null },
  { title: 'Today — Grocery Pickup',       cat: 'general',      day: 0,  h: 17, mem: SARAH,   loc: 'Whole Foods' },
];

for (const e of futureEvents) {
  const base = e.day === 0 ? today.toISOString() : daysFrom(e.day);
  calEvents.push({
    id: uuid(), family_id: FAMILY_ID, created_by: CB,
    title: e.title, category: e.cat,
    starts_at: timeAt(base, e.h), ends_at: timeAt(base, e.h + 1),
    all_day: false, recurrence: 'none',
    assignee_id: e.mem ?? null, location: e.loc ?? null,
  });
}
await ins('calendar_events', calEvents);

// ─── STEP 2: School Events ─────────────────────────────────────────────────
console.log('\n── School Events ──');
const schoolRows = [
  { m: EMMA,    s: 'Westfield High School',  t: 'AP Chemistry Midterm',               type: 'test',       day: -20 },
  { m: EMMA,    s: 'Westfield High School',  t: 'English Essay — Shakespeare',         type: 'assignment', day: -14, n: 'Analyze Hamlet Act 3' },
  { m: EMMA,    s: 'Westfield High School',  t: 'Science Fair Project Due',            type: 'project',    day: -7,  n: 'Volcano chemistry project' },
  { m: EMMA,    s: 'Westfield High School',  t: 'AP History Final',                    type: 'test',       day: -3 },
  { m: EMMA,    s: 'Westfield High School',  t: 'Graduation Photo Day',                type: 'other',      day: 2 },
  { m: EMMA,    s: 'Westfield High School',  t: 'Physics Lab Report Due',              type: 'assignment', day: 5,   n: 'Circuits and resistance' },
  { m: EMMA,    s: 'Westfield High School',  t: 'Parent-Teacher Conference',           type: 'meeting',    day: 9 },
  { m: EMMA,    s: 'Westfield High School',  t: 'Spanish Oral Exam',                   type: 'test',       day: 7 },
  { m: EMMA,    s: 'Westfield High School',  t: 'Junior Prom',                          type: 'performance',day: 18 },
  { m: EMMA,    s: 'Westfield High School',  t: 'SAT Testing Day',                     type: 'test',       day: 25 },
  { m: EMMA,    s: 'Westfield High School',  t: 'College Application Workshop',        type: 'meeting',    day: 30 },
  { m: EMMA,    s: 'Westfield High School',  t: 'AP Calculus Review Session',          type: 'other',      day: 15 },
  { m: JACKSON, s: 'Riverside Middle School',t: 'Math Quiz — Fractions',               type: 'test',       day: -18 },
  { m: JACKSON, s: 'Riverside Middle School',t: 'Book Report — Charlottes Web',        type: 'assignment', day: -10, n: 'Include character analysis' },
  { m: JACKSON, s: 'Riverside Middle School',t: 'Science Poster Presentation',         type: 'project',    day: -5 },
  { m: JACKSON, s: 'Riverside Middle School',t: 'Field Trip — Natural History Museum', type: 'field_trip', day: 4,   n: 'Bring lunch and $5' },
  { m: JACKSON, s: 'Riverside Middle School',t: 'Permission Slip Due',                 type: 'assignment', day: 1,   n: 'Sign and return to Mr. Peterson' },
  { m: JACKSON, s: 'Riverside Middle School',t: 'Spelling Bee Competition',            type: 'performance',day: 8 },
  { m: JACKSON, s: 'Riverside Middle School',t: 'Social Studies Test — US History',   type: 'test',       day: 11 },
  { m: JACKSON, s: 'Riverside Middle School',t: 'Art Show — Student Exhibit',          type: 'performance',day: 15 },
  { m: JACKSON, s: 'Riverside Middle School',t: 'Summer School Registration',          type: 'other',      day: 20 },
  { m: JACKSON, s: 'Riverside Middle School',t: 'Reading Log Due — Chapter Books',    type: 'assignment', day: -2 },
  { m: LILY,    s: 'Sunny Days Elementary',  t: 'Show and Tell — Pets',               type: 'other',      day: -15 },
  { m: LILY,    s: 'Sunny Days Elementary',  t: 'Reading Milestone — 100 Books',      type: 'other',      day: -8 },
  { m: LILY,    s: 'Sunny Days Elementary',  t: 'School Play — Cinderella',           type: 'performance',day: 6,   n: 'Lily plays a fairy! Costume ready.' },
  { m: LILY,    s: 'Sunny Days Elementary',  t: 'Kindergarten Graduation Prep',       type: 'other',      day: 3 },
  { m: LILY,    s: 'Sunny Days Elementary',  t: 'End-of-Year Party',                  type: 'other',      day: 10 },
  { m: LILY,    s: 'Sunny Days Elementary',  t: 'Field Day — Bring Sunscreen',        type: 'field_trip', day: 14 },
  { m: LILY,    s: 'Sunny Days Elementary',  t: 'Letter Recognition Assessment',      type: 'test',       day: -12 },
];
await ins('school_events', schoolRows.map(r => ({
  id: uuid(), family_id: FAMILY_ID, member_id: r.m, school_name: r.s,
  title: r.t, event_type: r.type, notes: r.n ?? null,
  starts_at: r.day <= 0 ? timeAt(daysAgo(Math.abs(r.day)), 8) : timeAt(daysFrom(r.day), 8),
  created_by: CB,
})));

// ─── STEP 3: Sports Events ─────────────────────────────────────────────────
console.log('\n── Sports Events ──');
const sportsDefs = [
  { m: JACKSON, sport: 'Soccer',   team: 'Riverside Rockets' },
  { m: JACKSON, sport: 'Baseball', team: 'Blue Jays' },
  { m: EMMA,    sport: 'Swimming', team: 'Westfield Swim Club' },
  { m: LILY,    sport: 'Ballet',   team: 'City Dance Academy' },
  { m: LILY,    sport: 'T-Ball',   team: 'Pink Stars' },
];
const sportsRows = [];
for (let i = -45; i <= 60; i += rand(3,7)) {
  if (Math.random() > 0.65) continue;
  const sp = pick(sportsDefs);
  const base = i <= 0 ? daysAgo(Math.abs(i)) : daysFrom(i);
  const isGame = Math.random() > 0.45;
  sportsRows.push({
    id: uuid(), family_id: FAMILY_ID, member_id: sp.m, sport: sp.sport, team: sp.team,
    title: isGame ? `${sp.sport} Game — ${sp.team}` : `${sp.sport} Practice`,
    event_type: isGame ? 'game' : 'practice',
    location: pick(['Riverside Fields','City Sports Complex','Community Gym','East Park','Memorial Stadium','Community Pool','West Athletic Club']),
    starts_at: timeAt(base, rand(9,17)), recurrence: 'none', created_by: CB,
  });
}
await ins('sports_events', sportsRows);

// ─── STEP 4: Appointments ──────────────────────────────────────────────────
console.log('\n── Appointments ──');
const appts = [
  { m: EMMA,    t: 'Annual Physical',          pr: 'Dr. Rebecca Chen',   loc: "Children's Health Clinic",    day: -40 },
  { m: JACKSON, t: 'Dental Cleaning',          pr: 'Dr. Mark Williams',  loc: 'Bright Smiles Dental',        day: -35 },
  { m: LILY,    t: 'Well-Child Checkup',        pr: 'Dr. Sarah Patel',   loc: 'Sunshine Pediatrics',         day: -28 },
  { m: DANIEL,  t: 'Eye Exam',                 pr: 'Dr. James Liu',      loc: 'Vision Care Center',          day: -20 },
  { m: SARAH,   t: 'OB-GYN Annual Visit',      pr: 'Dr. Alicia Torres',  loc: "Women's Health Assoc.",       day: -15 },
  { m: EMMA,    t: 'Orthodontist Checkup',      pr: 'Dr. Kevin Park',    loc: 'Straight Smiles Ortho',       day: -10 },
  { m: JACKSON, t: 'Allergy Test Follow-Up',   pr: 'Dr. Nina Gupta',    loc: 'AllergyCare Specialists',     day: -5 },
  { m: EMMA,    t: 'Dentist — Cleaning',        pr: 'Dr. Mark Williams', loc: 'Bright Smiles Dental',        day: 0 },
  { m: LILY,    t: 'Pediatrician Check',        pr: 'Dr. Sarah Patel',   loc: 'Sunshine Pediatrics',         day: 12 },
  { m: DANIEL,  t: 'Cardiology Checkup',        pr: 'Dr. Robert Stone',  loc: 'Heart Health Associates',     day: 18 },
  { m: SARAH,   t: 'Dermatology Consult',       pr: 'Dr. Lisa Chang',    loc: 'Skin Care Center',            day: 22 },
  { m: JACKSON, t: 'Sports Physical',           pr: 'Dr. Tom Bradley',   loc: 'Family Health Clinic',        day: 28 },
  { m: EMMA,    t: 'Therapy Session',           pr: 'Dr. Amanda Ross',   loc: 'Mindwell Counseling',         day: 6 },
  { m: EMMA,    t: 'Therapy Session',           pr: 'Dr. Amanda Ross',   loc: 'Mindwell Counseling',         day: 13 },
  { m: LILY,    t: 'Speech Therapy',            pr: 'Ms. Carol Jensen',  loc: 'Language Learning Center',    day: 3 },
  { m: EMMA,    t: 'Therapy Session',           pr: 'Dr. Amanda Ross',   loc: 'Mindwell Counseling',         day: -7 },
  { m: DANIEL,  t: 'Annual Physical',           pr: 'Dr. James Peterson', loc: 'Westfield Family Medicine',  day: -45 },
  { m: SARAH,   t: 'Mammogram',                pr: 'Radiology Dept',    loc: 'St. Mary Medical Center',     day: -22 },
];
await ins('appointments', appts.map(a => ({
  id: uuid(), family_id: FAMILY_ID, member_id: a.m, title: a.t, provider: a.pr, location: a.loc,
  starts_at: a.day <= 0 ? timeAt(daysAgo(Math.abs(a.day)), 9) : timeAt(daysFrom(a.day), 9),
  ends_at:   a.day <= 0 ? timeAt(daysAgo(Math.abs(a.day)), 10) : timeAt(daysFrom(a.day), 10),
  notes: null, created_by: CB,
})));

// ─── STEP 5: Chores + Assignments ─────────────────────────────────────────
console.log('\n── Chores ──');
const CHORE_DEFS = [
  { t: 'Empty Dishwasher',       pts: 5,  pri: 'low',    m: EMMA,    rec: 'daily'   },
  { t: 'Feed the Dog',           pts: 5,  pri: 'high',   m: JACKSON, rec: 'daily'   },
  { t: 'Take Out Trash',         pts: 10, pri: 'medium', m: EMMA,    rec: 'weekly'  },
  { t: 'Vacuum Living Room',     pts: 15, pri: 'medium', m: JACKSON, rec: 'weekly'  },
  { t: 'Clean Bathrooms',        pts: 20, pri: 'high',   m: SARAH,   rec: 'weekly'  },
  { t: 'Mow the Lawn',           pts: 30, pri: 'medium', m: DANIEL,  rec: 'weekly'  },
  { t: 'Dust Furniture',         pts: 15, pri: 'low',    m: EMMA,    rec: 'weekly'  },
  { t: 'Wipe Kitchen Counters',  pts: 5,  pri: 'low',    m: LILY,    rec: 'daily'   },
  { t: 'Do Laundry',             pts: 20, pri: 'medium', m: SARAH,   rec: 'weekly'  },
  { t: 'Clean Car Interior',     pts: 25, pri: 'low',    m: DANIEL,  rec: 'monthly' },
  { t: 'Water Plants',           pts: 5,  pri: 'low',    m: LILY,    rec: 'weekly'  },
  { t: 'Make Bed',               pts: 5,  pri: 'low',    m: JACKSON, rec: 'daily'   },
  { t: 'Set Dinner Table',       pts: 5,  pri: 'low',    m: LILY,    rec: 'daily'   },
  { t: 'Walk the Dog',           pts: 10, pri: 'medium', m: JACKSON, rec: 'daily'   },
  { t: 'Organize Pantry',        pts: 20, pri: 'low',    m: SARAH,   rec: 'monthly' },
  { t: 'Clean Garage',           pts: 35, pri: 'low',    m: DANIEL,  rec: 'monthly' },
  { t: 'Sweep Porch',            pts: 10, pri: 'low',    m: JACKSON, rec: 'weekly'  },
  { t: 'Sort Recycling',         pts: 5,  pri: 'medium', m: EMMA,    rec: 'weekly'  },
  { t: 'Clean Windows',          pts: 15, pri: 'low',    m: DANIEL,  rec: 'monthly' },
  { t: 'Put Away Groceries',     pts: 10, pri: 'medium', m: EMMA,    rec: 'none'    },
];

const choreMap = [];
const choreRows = CHORE_DEFS.map(c => {
  const id = uuid();
  choreMap.push({ id, ...c });
  return { id, family_id: FAMILY_ID, title: c.t, points: c.pts, priority: c.pri, recurrence: c.rec, requires_approval: c.pts >= 20, created_by: CB };
});
await ins('chores', choreRows);

const DONE_STATUSES = ['done','approved','done','done','approved'];
const asgns = [];
for (const c of choreMap) {
  for (let i = 0; i < rand(3,5); i++) {
    asgns.push({ id: uuid(), family_id: FAMILY_ID, chore_id: c.id, member_id: c.m, status: pick(DONE_STATUSES), due_at: daysAgo(rand(2,50)), submitted_at: daysAgo(rand(1,4)), points_awarded: c.pts });
  }
  asgns.push({ id: uuid(), family_id: FAMILY_ID, chore_id: c.id, member_id: c.m, status: pick(['todo','in_progress','todo']), due_at: daysFrom(rand(0,3)) });
}
await ins('chore_assignments', asgns);

// ─── STEP 6: Rewards ──────────────────────────────────────────────────────
console.log('\n── Rewards ──');
await ins('rewards', [
  { id: uuid(), family_id: FAMILY_ID, title: 'Pizza Night',           description: 'Family picks any pizza place',      cost_points: 100, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Movie of Your Choice',  description: 'Pick any movie for Friday night',    cost_points: 75,  created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Extra Screen Time',     description: '2 extra hours of gaming or TV',      cost_points: 50,  created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Ice Cream Outing',      description: 'Trip to Scoops Ice Cream',           cost_points: 60,  created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Skip One Chore',        description: 'Skip any single chore this week',   cost_points: 40,  created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Sleepover with Friend', description: 'Host or attend a sleepover',         cost_points: 150, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'New Video Game',        description: '$20 credit toward a new game',       cost_points: 200, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Amusement Park Day',    description: 'Family trip to Six Flags',           cost_points: 500, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Stay Up 1 Hour Late',   description: 'One night with late bedtime',        cost_points: 30,  created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Breakfast in Bed',      description: 'Special breakfast served to you',    cost_points: 80,  created_by: CB },
]);

// ─── STEP 7: Meals + Plans ────────────────────────────────────────────────
console.log('\n── Meals ──');
const MEAL_DEFS = [
  { n: 'Chicken Tacos',        t: 'dinner',    ing: ['chicken breast','tortillas','salsa','cheese','lettuce','avocado'] },
  { n: 'Spaghetti Bolognese',  t: 'dinner',    ing: ['ground beef','pasta','marinara sauce','garlic','parmesan'] },
  { n: 'Grilled Salmon',       t: 'dinner',    ing: ['salmon fillets','lemon','dill','asparagus','rice'] },
  { n: 'Homemade Pizza',       t: 'dinner',    ing: ['pizza dough','mozzarella','pepperoni','marinara','mushrooms'] },
  { n: 'Chicken Stir Fry',     t: 'dinner',    ing: ['chicken','broccoli','snap peas','soy sauce','ginger','rice'] },
  { n: 'Beef Tacos',           t: 'dinner',    ing: ['ground beef','taco shells','cheese','salsa','sour cream'] },
  { n: 'Mac and Cheese',       t: 'dinner',    ing: ['macaroni','cheddar cheese','milk','butter','breadcrumbs'] },
  { n: 'BBQ Ribs',             t: 'dinner',    ing: ['pork ribs','BBQ sauce','garlic','coleslaw','cornbread'] },
  { n: 'Chicken Soup',         t: 'dinner',    ing: ['whole chicken','carrots','celery','onion','noodles'] },
  { n: 'Stuffed Bell Peppers', t: 'dinner',    ing: ['bell peppers','ground beef','rice','tomato sauce','cheese'] },
  { n: 'Turkey Chili',         t: 'dinner',    ing: ['ground turkey','kidney beans','tomatoes','cumin','chili powder'] },
  { n: 'Shrimp Pasta',         t: 'dinner',    ing: ['shrimp','linguine','garlic','butter','parsley','lemon'] },
  { n: 'Pancake Stack',        t: 'breakfast', ing: ['flour','eggs','milk','butter','maple syrup','blueberries'] },
  { n: 'Avocado Toast',        t: 'breakfast', ing: ['sourdough','avocado','eggs','red pepper flakes'] },
  { n: 'Smoothie Bowl',        t: 'breakfast', ing: ['frozen berries','banana','yogurt','granola','honey'] },
  { n: 'Eggs Benedict',        t: 'breakfast', ing: ['English muffins','Canadian bacon','eggs','hollandaise'] },
  { n: 'Caesar Salad',         t: 'lunch',     ing: ['romaine','chicken','croutons','Caesar dressing','parmesan'] },
  { n: 'BLT Sandwich',         t: 'lunch',     ing: ['bacon','lettuce','tomato','sourdough','mayo'] },
  { n: 'Chicken Quesadillas',  t: 'lunch',     ing: ['flour tortillas','chicken','cheese','salsa','sour cream'] },
  { n: 'Greek Salad Bowl',     t: 'lunch',     ing: ['cucumber','tomato','feta','olives','red onion','pita'] },
];

const mealIds = [];
await ins('meals', MEAL_DEFS.map(m => {
  const id = uuid(); mealIds.push(id);
  return { id, family_id: FAMILY_ID, name: m.n, meal_type: m.t, ingredients: m.ing, created_by: CB };
}));

const mealPlans = [];
for (let i = -30; i <= 30; i++) {
  if (Math.random() > 0.55) continue;
  mealPlans.push({ id: uuid(), family_id: FAMILY_ID, meal_id: mealIds[rand(0,11)], plan_date: dateStr(i), meal_type: 'dinner', created_by: CB });
  if (Math.random() > 0.6) mealPlans.push({ id: uuid(), family_id: FAMILY_ID, meal_id: mealIds[rand(12,15)], plan_date: dateStr(i), meal_type: 'breakfast', created_by: CB });
  if (Math.random() > 0.7) mealPlans.push({ id: uuid(), family_id: FAMILY_ID, meal_id: mealIds[rand(16,19)], plan_date: dateStr(i), meal_type: 'lunch', created_by: CB });
}
await ins('meal_plans', mealPlans);

// ─── STEP 8: Grocery ──────────────────────────────────────────────────────
console.log('\n── Grocery ──');
const [gList1] = await ins('grocery_lists', [{ id: uuid(), family_id: FAMILY_ID, name: 'Weekly Groceries', is_archived: false, created_by: CB }]);
const [gList2] = await ins('grocery_lists', [{ id: uuid(), family_id: FAMILY_ID, name: 'Last Weeks List', is_archived: true,  created_by: CB }]);

const L1 = gList1?.id ?? uuid();
const L2 = gList2?.id ?? uuid();

await ins('grocery_items', [
  ...[
    { n: 'Chicken Breast', q: '2 lbs', c: 'Meat & Seafood', chk: false },
    { n: 'Salmon Fillets', q: '4 pieces', c: 'Meat & Seafood', chk: false },
    { n: 'Ground Beef', q: '1.5 lbs', c: 'Meat & Seafood', chk: true },
    { n: 'Whole Milk', q: '1 gallon', c: 'Dairy', chk: true },
    { n: 'Greek Yogurt', q: '32 oz', c: 'Dairy', chk: false },
    { n: 'Cheddar Cheese', q: '8 oz', c: 'Dairy', chk: false },
    { n: 'Eggs', q: '2 dozen', c: 'Dairy', chk: true },
    { n: 'Butter', q: '1 lb', c: 'Dairy', chk: true },
    { n: 'Sourdough Bread', q: '1 loaf', c: 'Bakery', chk: false },
    { n: 'Whole Wheat Tortillas', q: '1 pack', c: 'Bakery', chk: false },
    { n: 'Broccoli', q: '2 heads', c: 'Produce', chk: false },
    { n: 'Baby Spinach', q: '5 oz bag', c: 'Produce', chk: true },
    { n: 'Romaine Lettuce', q: '2 heads', c: 'Produce', chk: false },
    { n: 'Avocados', q: '4', c: 'Produce', chk: false },
    { n: 'Tomatoes', q: '1 lb', c: 'Produce', chk: true },
    { n: 'Bell Peppers', q: '3 mixed', c: 'Produce', chk: false },
    { n: 'Carrots', q: '2 lbs', c: 'Produce', chk: true },
    { n: 'Bananas', q: '1 bunch', c: 'Produce', chk: false },
    { n: 'Blueberries', q: '1 pint', c: 'Produce', chk: false },
    { n: 'Apples', q: '6', c: 'Produce', chk: true },
    { n: 'Olive Oil', q: '16 oz', c: 'Pantry', chk: false },
    { n: 'Soy Sauce', q: '10 oz', c: 'Pantry', chk: true },
    { n: 'Chicken Broth', q: '32 oz', c: 'Pantry', chk: false },
    { n: 'Pasta', q: '1 lb', c: 'Pantry', chk: false },
    { n: 'Rice', q: '5 lb bag', c: 'Pantry', chk: true },
    { n: 'Granola Bars', q: '12-pack', c: 'Snacks', chk: false },
    { n: 'Goldfish Crackers', q: '2 bags', c: 'Snacks', chk: false },
    { n: 'Apple Juice', q: '64 oz', c: 'Beverages', chk: true },
    { n: 'Sparkling Water', q: '12-pack', c: 'Beverages', chk: false },
    { n: 'Laundry Detergent', q: '1 bottle', c: 'Household', chk: false },
    { n: 'Dish Soap', q: '2 bottles', c: 'Household', chk: true },
    { n: 'Paper Towels', q: '6 rolls', c: 'Household', chk: false },
    { n: 'Toothpaste', q: '3-pack', c: 'Personal Care', chk: false },
    { n: 'Shampoo', q: '1 bottle', c: 'Personal Care', chk: true },
  ].map(g => ({ id: uuid(), family_id: FAMILY_ID, list_id: L1, name: g.n, quantity: g.q, category: g.c, is_checked: g.chk, created_by: CB })),
  ...['Flour','Sugar','Vanilla Extract','Baking Soda','Heavy Cream','Cocoa Powder','Honey','Brown Sugar','Powdered Sugar'].map(name => (
    { id: uuid(), family_id: FAMILY_ID, list_id: L2, name, quantity: null, category: 'Pantry', is_checked: true, created_by: CB }
  )),
]);

// ─── STEP 9: Medications ──────────────────────────────────────────────────
console.log('\n── Medications ──');
const medDefs = [
  { m: JACKSON, n: 'Zyrtec (Cetirizine)',    d: '10mg',      i: 'Once daily for allergies',          active: true },
  { m: JACKSON, n: 'Albuterol Inhaler',       d: '2 puffs',   i: 'Before exercise or as needed',      active: true },
  { m: EMMA,    n: 'Daily Multivitamin',      d: '1 tablet',  i: 'Take with breakfast',               active: true },
  { m: EMMA,    n: 'Iron Supplement',          d: '325mg',     i: 'Take with vitamin C',               active: true },
  { m: DANIEL,  n: 'Lisinopril',              d: '10mg',      i: 'Daily for blood pressure',          active: true },
  { m: DANIEL,  n: 'Fish Oil',                d: '1000mg',    i: 'Take with dinner',                  active: true },
  { m: SARAH,   n: 'Vitamin D3',              d: '2000 IU',   i: 'Take with breakfast',               active: true },
  { m: SARAH,   n: 'Magnesium Glycinate',     d: '400mg',     i: 'Take before bed',                   active: true },
  { m: LILY,    n: 'Fluoride Supplement',     d: '0.5mg',     i: 'Chewable at bedtime after brushing',active: true },
  { m: JACKSON, n: 'Amoxicillin',             d: '250mg',     i: 'Completed — ear infection course',  active: false },
];

const medIds2 = [];
await ins('medications', medDefs.map(m => {
  const id = uuid(); medIds2.push({ id, active: m.active, name: m.n });
  return { id, family_id: FAMILY_ID, member_id: m.m, name: m.n, dosage: m.d, instructions: m.i, is_active: m.active, created_by: CB };
}));

await ins('medication_schedules', medIds2.filter(m => m.active).map(m => ({
  id: uuid(), family_id: FAMILY_ID, medication_id: m.id,
  time_of_day: m.name.includes('Magnesium') ? '21:00' : m.name.includes('Fish Oil') ? '18:00' : '08:00',
  days_of_week: [0,1,2,3,4,5,6], starts_on: dateStr(-60),
})));

// ─── STEP 10: Home Assets + Maintenance ───────────────────────────────────
console.log('\n── Home Assets ──');
const assetDefs = [
  { n: 'Honda Pilot 2022',       cat: 'Vehicle',     loc: 'Garage',        brand: 'Honda',      model: 'Pilot',        pur: '2022-03-15', war: '2027-03-15' },
  { n: 'Toyota Camry 2019',      cat: 'Vehicle',     loc: 'Garage',        brand: 'Toyota',     model: 'Camry',        pur: '2019-06-01', war: '2024-06-01' },
  { n: 'HVAC System',            cat: 'Appliance',   loc: 'Utility Room',  brand: 'Trane',      model: 'XR15',         pur: '2020-08-10', war: '2025-08-10' },
  { n: 'Refrigerator',           cat: 'Appliance',   loc: 'Kitchen',       brand: 'Samsung',    model: 'RF28',         pur: '2021-01-05', war: '2026-01-05' },
  { n: 'Washer and Dryer Set',   cat: 'Appliance',   loc: 'Laundry Room',  brand: 'LG',         model: 'WM4000H',      pur: '2020-11-20', war: '2025-11-20' },
  { n: 'Dishwasher',             cat: 'Appliance',   loc: 'Kitchen',       brand: 'Bosch',      model: 'SHPM88Z',      pur: '2021-03-10', war: '2026-03-10' },
  { n: 'Water Heater',           cat: 'Plumbing',    loc: 'Utility Room',  brand: 'Rheem',      model: 'PRO50',        pur: '2018-07-22', war: '2028-07-22' },
  { n: 'Roof 30yr Shingle',      cat: 'Structural',  loc: 'Exterior',      brand: 'GAF',        model: 'Timberline HDZ',pur: '2015-09-01', war: '2045-09-01' },
  { n: 'Riding Lawn Mower',      cat: 'Outdoor',     loc: 'Garage',        brand: 'John Deere', model: 'D130',         pur: '2019-04-20', war: '2022-04-20' },
  { n: 'Pool Equipment',         cat: 'Outdoor',     loc: 'Backyard',      brand: 'Hayward',    model: 'TriStar',      pur: '2020-05-15', war: '2025-05-15' },
  { n: '75 inch Samsung TV',     cat: 'Electronics', loc: 'Living Room',   brand: 'Samsung',    model: 'QN75QN90B',    pur: '2022-11-25', war: '2025-11-25' },
  { n: 'MacBook Pro 14 inch',    cat: 'Electronics', loc: 'Home Office',   brand: 'Apple',      model: 'MacBook Pro M2',pur: '2022-10-01', war: '2025-10-01' },
  { n: 'Home Security System',   cat: 'Security',    loc: 'Whole Home',    brand: 'Ring',       model: 'Alarm Pro',    pur: '2021-08-01', war: '2024-08-01' },
  { n: 'Standby Generator',      cat: 'Electrical',  loc: 'Side Yard',     brand: 'Generac',    model: '7043',         pur: '2021-02-10', war: '2026-02-10' },
  { n: 'Garage Door System',     cat: 'Structural',  loc: 'Garage',        brand: 'Chamberlain',model: 'B6765',        pur: '2020-06-05', war: '2025-06-05' },
];

const assetMap2 = new Map();
await ins('home_assets', assetDefs.map(a => {
  const id = uuid(); assetMap2.set(a.n, id);
  return { id, family_id: FAMILY_ID, name: a.n, category: a.cat, location: a.loc, brand: a.brand, model: a.model, purchased_on: a.pur, warranty_until: a.war, created_by: CB };
}));

const maintDefs = [
  { a: 'Honda Pilot 2022',     t: 'Oil Change and Tire Rotation',     pri: 'high',   days: 5,   st: 'todo',        interval: 90 },
  { a: 'Toyota Camry 2019',    t: 'Oil Change',                        pri: 'medium', days: 20,  st: 'todo',        interval: 90 },
  { a: 'HVAC System',          t: 'Replace Air Filter',                pri: 'high',   days: 2,   st: 'in_progress', interval: 30 },
  { a: 'HVAC System',          t: 'Annual HVAC Service',               pri: 'medium', days: 45,  st: 'todo',        interval: 365 },
  { a: 'Pool Equipment',       t: 'Pool Chemical Balance Check',       pri: 'high',   days: 3,   st: 'todo',        interval: 7 },
  { a: 'Pool Equipment',       t: 'Clean Pool Filter',                 pri: 'medium', days: 14,  st: 'todo',        interval: 30 },
  { a: 'Riding Lawn Mower',    t: 'Sharpen Mower Blades',              pri: 'low',    days: 30,  st: 'todo',        interval: 90 },
  { a: 'Roof 30yr Shingle',    t: 'Annual Roof Inspection',            pri: 'medium', days: 60,  st: 'todo',        interval: 365 },
  { a: 'Water Heater',         t: 'Flush Water Heater Tank',           pri: 'medium', days: 90,  st: 'todo',        interval: 365 },
  { a: 'Washer and Dryer Set', t: 'Clean Dryer Vent',                  pri: 'high',   days: 15,  st: 'todo',        interval: 180 },
  { a: 'Home Security System', t: 'Test All Sensors and Cameras',      pri: 'medium', days: 7,   st: 'todo',        interval: 90 },
  { a: 'Standby Generator',    t: 'Monthly Generator Test Run',        pri: 'medium', days: 10,  st: 'todo',        interval: 30 },
  { a: 'Honda Pilot 2022',     t: 'Cabin Air Filter Replacement',      pri: 'low',    days: -5,  st: 'done',        interval: 180 },
  { a: 'Dishwasher',           t: 'Run Cleaning Cycle with Affresh',   pri: 'low',    days: -2,  st: 'done',        interval: 30 },
  { a: 'Garage Door System',   t: 'Lubricate Garage Door Rails',       pri: 'low',    days: 25,  st: 'todo',        interval: 180 },
  { a: null,                   t: 'Gutter Cleaning',                    pri: 'medium', days: 30,  st: 'todo',        interval: 180 },
  { a: null,                   t: 'Power Wash Driveway and Patio',      pri: 'low',    days: 45,  st: 'todo',        interval: 365 },
  { a: null,                   t: 'Inspect Smoke and CO Detectors',     pri: 'high',   days: 1,   st: 'todo',        interval: 180 },
  { a: null,                   t: 'Quarterly Pest Control Service',     pri: 'medium', days: 60,  st: 'todo',        interval: 90 },
  { a: null,                   t: 'Touch Up Exterior Paint',            pri: 'low',    days: 90,  st: 'todo',        interval: 365 },
];

await ins('maintenance_tasks', maintDefs.map(t => ({
  id: uuid(), family_id: FAMILY_ID,
  asset_id: t.a ? (assetMap2.get(t.a) ?? null) : null,
  title: t.t, status: t.st, priority: t.pri, recurrence: 'none',
  interval_days: t.interval,
  due_at: t.days >= 0 ? daysFrom(t.days) : daysAgo(Math.abs(t.days)),
  completed_at: t.st === 'done' ? daysAgo(Math.abs(t.days)) : null,
  assignee_id: pick([DANIEL, SARAH]), created_by: CB,
})));

// ─── STEP 11: Documents ───────────────────────────────────────────────────
console.log('\n── Documents ──');
const docDefs = [
  { t: "Daniel Passport",              cat: 'ID',        m: DANIEL,  exp: 730,  sz: 1200000 },
  { t: "Sarah Passport",               cat: 'ID',        m: SARAH,   exp: 1100, sz: 1150000 },
  { t: "Emma Passport",                cat: 'ID',        m: EMMA,    exp: 820,  sz: 980000 },
  { t: "Daniel Drivers License",       cat: 'ID',        m: DANIEL,  exp: 540,  sz: 450000 },
  { t: "Sarah Drivers License",        cat: 'ID',        m: SARAH,   exp: 380,  sz: 420000 },
  { t: "Jackson Birth Certificate",    cat: 'ID',        m: JACKSON, exp: null, sz: 320000 },
  { t: "Lily Birth Certificate",       cat: 'ID',        m: LILY,    exp: null, sz: 318000 },
  { t: "Emma Birth Certificate",       cat: 'ID',        m: EMMA,    exp: null, sz: 315000 },
  { t: 'Home Insurance Policy 2026',   cat: 'Insurance', m: null,    exp: 360,  sz: 2400000 },
  { t: 'Auto Insurance Honda Pilot',   cat: 'Insurance', m: null,    exp: 180,  sz: 1800000 },
  { t: 'Auto Insurance Toyota Camry',  cat: 'Insurance', m: null,    exp: 180,  sz: 1750000 },
  { t: 'Health Insurance Card Daniel', cat: 'Insurance', m: DANIEL,  exp: 190,  sz: 380000 },
  { t: 'Health Insurance Card Sarah',  cat: 'Insurance', m: SARAH,   exp: 190,  sz: 375000 },
  { t: 'Life Insurance Policy Daniel', cat: 'Insurance', m: DANIEL,  exp: 3650, sz: 3200000 },
  { t: "Emma Vaccination Record",      cat: 'Medical',   m: EMMA,    exp: null, sz: 890000 },
  { t: "Jackson Vaccination Record",   cat: 'Medical',   m: JACKSON, exp: null, sz: 880000 },
  { t: "Lily Vaccination Record",      cat: 'Medical',   m: LILY,    exp: null, sz: 875000 },
  { t: "Daniel Blood Work Q1 2026",    cat: 'Medical',   m: DANIEL,  exp: null, sz: 450000 },
  { t: "Jackson Allergy Test Results", cat: 'Medical',   m: JACKSON, exp: null, sz: 520000 },
  { t: '2025 Federal Tax Return',      cat: 'Financial', m: null,    exp: null, sz: 1800000 },
  { t: '2024 Federal Tax Return',      cat: 'Financial', m: null,    exp: null, sz: 1750000 },
  { t: 'Mortgage Statement June 2026', cat: 'Financial', m: null,    exp: null, sz: 650000 },
  { t: 'W-2 Daniel 2025',             cat: 'Financial', m: DANIEL,  exp: null, sz: 420000 },
  { t: '401k Statement Q1 2026',      cat: 'Financial', m: DANIEL,  exp: null, sz: 890000 },
  { t: 'Home Deed',                    cat: 'Property',  m: null,    exp: null, sz: 2100000 },
  { t: 'HOA Rules and Regulations',    cat: 'Property',  m: null,    exp: null, sz: 1500000 },
  { t: 'Home Inspection Report 2018',  cat: 'Property',  m: null,    exp: null, sz: 5200000 },
  { t: "Emma Report Card Spring 2026", cat: 'School',    m: EMMA,    exp: null, sz: 340000 },
  { t: "Jackson Report Card Spring 2026", cat: 'School', m: JACKSON, exp: null, sz: 335000 },
  { t: "Emma IEP Documentation",       cat: 'School',    m: EMMA,    exp: 365,  sz: 780000 },
];
await ins('documents', docDefs.map(d => ({
  id: uuid(), family_id: FAMILY_ID, title: d.t, category: d.cat,
  storage_path: `families/${FAMILY_ID}/docs/${d.t.toLowerCase().replace(/\s+/g,'-')}.pdf`,
  mime_type: 'application/pdf', size_bytes: d.sz,
  expires_at: d.exp != null ? daysFrom(d.exp) : null,
  member_id: d.m, created_by: CB,
})));

// ─── STEP 12: Notes ───────────────────────────────────────────────────────
console.log('\n── Notes ──');
await ins('notes', [
  { id: uuid(), family_id: FAMILY_ID, title: 'Emergency Contacts', body: 'Police: 911\nPoison Control: 1-800-222-1222\nDr. Patel: (555) 234-5678\nNeighbor Jim: (555) 987-3210\nGrandma Ruth: (555) 876-5432', is_pinned: true, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'WiFi Passwords', body: 'Main: HughenHome2024\nGuest: WelcomeGuests!\nNAS: HughenNAS2023', is_pinned: true, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Summer Camp Packing List', body: 'Emma: 7 t-shirts, 3 shorts, sleeping bag, pillow, bug spray, sunscreen SPF 50, flashlight, toothbrush, journal', is_pinned: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'House Rules', body: '1. Phones off at dinner\n2. Homework before screens\n3. Bedtime: Lily 8pm, Jackson 9pm, Emma 10pm\n4. Chores done before weekends\n5. Be kind to each other', is_pinned: true, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Contractor Contacts', body: 'Plumber: Mikes Plumbing (555) 432-1000\nElectrician: ProElectric (555) 543-2000\nHVAC: Cool Air (555) 654-3000\nLandscaping: Green Thumb (555) 765-4000', is_pinned: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Vacation Ideas 2027', body: 'Hawaii - big island tour\nDisney World - Grand Floridian\nEurope - Paris plus Rome 10 days\nAlaska cruise\nYellowstone plus Grand Teton road trip', is_pinned: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: "Jackson Soccer Schedule", body: 'Tuesdays and Thursdays: Practice 4-6pm Riverside Fields\nSaturdays: Games 10am - check app for location\nCoach: Mike Peterson (555) 234-8765', is_pinned: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Family Budget Goals 2026', body: 'Emergency Fund: $25,000 target (currently $18,400)\nVacation Fund: $8,000 by December\nCollege Fund Emma: +$500/month\nHome Improvements: $15,000 kitchen remodel', is_pinned: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: "Emma College List", body: 'Reach: Stanford, MIT, Duke\nTarget: UCLA, USC, Michigan\nSafety: Arizona State, Utah, Colorado\nEssay: robotics club, volunteering, overcoming anxiety', is_pinned: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Meal Prep Sunday Tips', body: 'Batch cook rice and quinoa\nGrill 4 chicken breasts\nCut veggies for the week\nPrepare overnight oats x3\nMake one pot soup for lunches', is_pinned: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Security Codes', body: 'Alarm: 8492\nGarage: 3817\nSafe: [kept in safe deposit box]', is_pinned: true, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Library Card Numbers', body: 'Daniel: 21050001234567\nSarah: 21050002345678\nEmma: 21050003456789\nJackson: 21050004567890\nLily: 21050005678901', is_pinned: false, created_by: CB },
]);

// ─── STEP 13: Goals ───────────────────────────────────────────────────────
console.log('\n── Goals ──');
await ins('goals', [
  { id: uuid(), family_id: FAMILY_ID, title: 'Build Emergency Fund to $25,000',  description: 'Save 6 months of expenses',               target_date: dateStr(180), progress: 74, is_complete: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Emma College Applications Done',   description: 'Apply to 10 schools by December',          target_date: dateStr(200), progress: 30, is_complete: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Kitchen Remodel Complete',         description: 'New cabinets, counters, appliances',        target_date: dateStr(270), progress: 15, is_complete: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Hawaii Family Vacation 2027',      description: 'Big Island trip for the whole family',      target_date: dateStr(400), progress: 45, is_complete: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Jackson Learns to Ride Bike',      description: 'Practice 3x per week without training wheels', target_date: dateStr(30), progress: 80, is_complete: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Daniel Loses 15 lbs by September', description: 'Exercise 4x/week, track calories',          target_date: dateStr(90),  progress: 40, is_complete: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Family Reads 50 Books Together',   description: 'Combined goal tracked per member',           target_date: dateStr(365), progress: 60, is_complete: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Install Solar Panels',             description: 'Research, get quotes, install residential solar', target_date: dateStr(300), progress: 10, is_complete: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Run 5K as a Family',              description: 'Enter the City Fun Run in October',          target_date: dateStr(120), progress: 55, is_complete: false, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Donate $500 to Local Food Bank',  description: 'Fundraise through chore earnings',           target_date: dateStr(150), progress: 25, is_complete: false, created_by: CB },
]);

// ─── STEP 14: Reminders ───────────────────────────────────────────────────
console.log('\n── Reminders ──');
await ins('reminders', [
  { id: uuid(), family_id: FAMILY_ID, title: 'Pay Mortgage',                    notes: 'Due the 1st - auto-pay via Chase',         remind_at: daysFrom(12), recurrence: 'monthly', is_done: false, member_id: DANIEL, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Jackson Permission Slip Due',     notes: 'Sign and return to Mr. Peterson by Friday', remind_at: daysFrom(1),  recurrence: 'none',    is_done: false, member_id: JACKSON, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Renew Home Insurance',            notes: 'State Farm - compare quotes first',         remind_at: daysFrom(15), recurrence: 'none',    is_done: false, member_id: DANIEL, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Emma Orthodontist Appointment',   notes: 'Straight Smiles Ortho, 3pm',                remind_at: daysFrom(21), recurrence: 'none',    is_done: false, member_id: EMMA, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Car Registration Honda Pilot',    notes: 'DMV renewal due; can do online',            remind_at: daysFrom(30), recurrence: 'yearly',  is_done: false, member_id: DANIEL, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Lily Ballet Recital Costume',     notes: 'Pickup at City Dance Academy after 3pm',   remind_at: daysFrom(5),  recurrence: 'none',    is_done: false, member_id: LILY, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Jackson Dentist Appointment',     notes: 'Bright Smiles Dental, 9am',                remind_at: daysFrom(10), recurrence: 'none',    is_done: false, member_id: JACKSON, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Order School Supplies for Fall',  notes: 'Check supply lists from each school',       remind_at: daysFrom(40), recurrence: 'none',    is_done: false, member_id: SARAH, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Schedule HVAC Service',           notes: 'Cool Air Systems annual maintenance',       remind_at: daysFrom(7),  recurrence: 'none',    is_done: false, member_id: DANIEL, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Emma SAT Registration Deadline',  notes: 'Register at collegeboard.org by July 15',  remind_at: daysFrom(25), recurrence: 'none',    is_done: false, member_id: EMMA, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Pool Chemicals Restock',          notes: 'Need chlorine tablets and pH down',         remind_at: daysFrom(3),  recurrence: 'none',    is_done: false, member_id: DANIEL, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Grandma Ruth Birthday Gift',      notes: 'Buy gift and ship early',                  remind_at: daysFrom(0),  recurrence: 'none',    is_done: false, member_id: GRANDMA, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'File Q2 Tax Estimate',            notes: 'Estimated quarterly payment due',           remind_at: daysFrom(11), recurrence: 'none',    is_done: false, member_id: DANIEL, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Return Library Books',            notes: '3 books due - Lily 2, Jackson 1',          remind_at: daysFrom(2),  recurrence: 'none',    is_done: false, member_id: SARAH, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Jackson Medication Refill Zyrtec',notes: 'Walgreens pickup',                          remind_at: daysFrom(6),  recurrence: 'monthly', is_done: false, member_id: JACKSON, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Review Streaming Subscriptions',  notes: 'Review Netflix, Hulu, Disney+, Spotify',   remind_at: daysFrom(20), recurrence: 'none',    is_done: false, member_id: DANIEL, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Jackson New Soccer Cleats',       notes: 'He outgrew current pair - need size 4.5',  remind_at: daysFrom(4),  recurrence: 'none',    is_done: false, member_id: JACKSON, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Plan Grandma Ruth July Visit',    notes: 'Confirm dates - she mentioned mid-July',   remind_at: daysFrom(8),  recurrence: 'none',    is_done: false, member_id: SARAH, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Sunscreen Restock',               notes: 'Running low - buy SPF 50 for kids',        remind_at: daysFrom(1),  recurrence: 'none',    is_done: false, member_id: SARAH, created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, title: 'Check Home Fire Extinguishers',   notes: 'Inspect gauge on all 3 units',              remind_at: daysFrom(14), recurrence: 'none',    is_done: false, member_id: DANIEL, created_by: CB },
]);

console.log('\n✅ Phase 1 complete!');
