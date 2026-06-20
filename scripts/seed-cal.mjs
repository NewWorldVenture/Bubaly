process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://ltcxlbipiihclxwioyqj.supabase.co',
  'sb_secret_BfCiburaPbck_7uXGgWOPA_glwQ5GkV',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const FAMILY_ID = 'a0cba6bd-88f7-48a9-926d-b27e5cf671dc';
const CB        = 'df41e924-9bea-4980-98d4-f9d78df05e49';
const DANIEL    = '1dfe994e-75c8-4cb6-920e-20984fae5651';

const { data: mems } = await sb.from('family_members').select('id,display_name').eq('family_id', FAMILY_ID);
const m = Object.fromEntries(mems.map(x => [x.display_name, x.id]));
const SARAH = m['Sarah'], EMMA = m['Emma'], JACKSON = m['Jackson'], LILY = m['Lily'], GRANDMA = m['Grandma Ruth'];
const ALL = [DANIEL, SARAH, EMMA, JACKSON, LILY];

const uuid = () => crypto.randomUUID();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const today = new Date('2026-06-19');
const daysAgo  = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString(); };
const daysFrom = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString(); };
const timeAt   = (base, h, m=0) => { const d = new Date(base); d.setHours(h, m, 0, 0); return d.toISOString(); };

// Valid event_category enum values
const CAT = ['general','school','sports','family','work','medical'];

const rows = [];

// 60 past events
for (let i = 60; i >= 1; i--) {
  if (Math.random() > 0.55) continue;
  rows.push({
    id: uuid(), family_id: FAMILY_ID, created_by: CB,
    title: pick(['Family dinner','Doctor visit','Soccer practice','Piano lesson','Library trip','Movie night','Bike ride','Park visit','Grocery run','Date night','Swimming class','Book club','Volunteer day','Game night']),
    category: pick(CAT), starts_at: timeAt(daysAgo(i), rand(8,19)), all_day: false, recurrence: 'none',
    assignee_id: pick([...ALL, null, null]),
  });
}

// Fixed upcoming events
const fixed = [
  { t: 'Emma Piano Recital',           cat: 'school',  day: 3,  h: 18, mem: EMMA,    loc: 'Harmony Music School' },
  { t: 'Jackson Soccer Game vs Eagles',cat: 'sports',  day: 5,  h: 10, mem: JACKSON, loc: 'Eastside Sports Complex' },
  { t: 'Lily Ballet Performance',      cat: 'family',  day: 7,  h: 14, mem: LILY,    loc: 'City Arts Center' },
  { t: 'Daniel Work Conference',       cat: 'work',    day: 4,  h: 9,  mem: DANIEL,  loc: 'Downtown Convention Center' },
  { t: 'Sarah Book Club',              cat: 'general', day: 6,  h: 19, mem: SARAH,   loc: 'Oak Street Library' },
  { t: 'Family BBQ at Grandmas',       cat: 'family',  day: 8,  h: 12, mem: null,    loc: "Grandma Ruth's house" },
  { t: 'Emma SAT Prep Class',          cat: 'school',  day: 9,  h: 13, mem: EMMA,    loc: 'Kaplan Learning Center' },
  { t: 'Jackson Dental Checkup',       cat: 'medical', day: 10, h: 9,  mem: JACKSON, loc: 'Bright Smiles Dental' },
  { t: 'Lily Pediatrician Visit',      cat: 'medical', day: 12, h: 11, mem: LILY,    loc: 'Sunshine Pediatrics' },
  { t: 'Daniel Golf with Clients',     cat: 'work',    day: 11, h: 8,  mem: DANIEL,  loc: 'Pinehurst Golf Club' },
  { t: 'Sarah Yoga Class',             cat: 'general', day: 2,  h: 7,  mem: SARAH,   loc: 'Harmony Yoga Studio' },
  { t: 'July 4th Family Celebration',  cat: 'family',  day: 15, h: 16, mem: null,    loc: 'City Park' },
  { t: 'Emma Summer Camp Drop-off',    cat: 'school',  day: 20, h: 8,  mem: EMMA,    loc: 'Camp Pinewood' },
  { t: 'Jackson Baseball Game',        cat: 'sports',  day: 13, h: 9,  mem: JACKSON, loc: 'Memorial Stadium' },
  { t: 'Family Movie Night',           cat: 'family',  day: 14, h: 19, mem: null },
  { t: 'Grandma Ruth Birthday Party',  cat: 'family',  day: 18, h: 15, mem: GRANDMA, loc: 'Hughen Home' },
  { t: 'Car Service Honda Pilot',      cat: 'general', day: 16, h: 9,  mem: DANIEL,  loc: 'Honda Dealer Service' },
  { t: 'HOA Meeting',                  cat: 'general', day: 17, h: 19, mem: DANIEL,  loc: 'Community Center' },
  { t: 'Sarah Haircut',                cat: 'general', day: 19, h: 14, mem: SARAH,   loc: 'Style Studio' },
  { t: 'Emma Orthodontist',            cat: 'medical', day: 21, h: 15, mem: EMMA,    loc: 'Straight Smiles Ortho' },
  { t: 'Lily Swimming Lessons',        cat: 'sports',  day: 1,  h: 10, mem: LILY,    loc: 'Community Pool' },
  { t: 'Daniel Flight to Denver',      cat: 'work',    day: 22, h: 6,  mem: DANIEL,  loc: 'Airport Terminal B' },
  { t: 'Family Camping Trip Day 1',    cat: 'family',  day: 30, h: 7,  mem: null },
  { t: 'Jackson Birthday Celebration', cat: 'family',  day: 35, h: 14, mem: JACKSON, loc: 'Laser Quest' },
  { t: 'Back to School Shopping',      cat: 'school',  day: 40, h: 10, mem: null,    loc: 'Eastfield Mall' },
  { t: 'Today Emma Dentist',           cat: 'medical', day: 0,  h: 9,  mem: EMMA,    loc: 'Bright Smiles Dental' },
  { t: 'Today Soccer Practice',        cat: 'sports',  day: 0,  h: 15, mem: JACKSON, loc: 'Riverside Soccer Fields' },
  { t: 'Today Tacos Night',            cat: 'family',  day: 0,  h: 18, mem: null },
  { t: 'Today Grocery Pickup',         cat: 'general', day: 0,  h: 17, mem: SARAH,   loc: 'Whole Foods' },
  { t: 'Sarah Dentist Appointment',    cat: 'medical', day: 26, h: 10, mem: SARAH,   loc: 'Bright Smiles Dental' },
  { t: 'Daniel Quarterly Review',      cat: 'work',    day: 24, h: 9,  mem: DANIEL,  loc: 'Office' },
  { t: 'Emma Therapy Session',         cat: 'medical', day: 27, h: 14, mem: EMMA,    loc: 'Mindwell Counseling' },
  { t: 'Lily Dance Recital Rehearsal', cat: 'school',  day: 28, h: 16, mem: LILY,    loc: 'City Dance Academy' },
  { t: 'Jackson Scouts Meeting',       cat: 'general', day: 29, h: 18, mem: JACKSON, loc: 'Community Center' },
  { t: 'Family Camping Trip Day 2',    cat: 'family',  day: 31, h: 8,  mem: null },
  { t: 'Family Camping Trip Day 3',    cat: 'family',  day: 32, h: 8,  mem: null },
  { t: 'Daniel Returns from Camping',  cat: 'general', day: 33, h: 16, mem: DANIEL },
  { t: 'Neighborhood Pool Party',      cat: 'family',  day: 36, h: 14, mem: null,    loc: 'Community Pool' },
  { t: 'Emma College Campus Visit',    cat: 'school',  day: 38, h: 9,  mem: EMMA,    loc: 'University of Michigan' },
  { t: 'Sarah Volunteer Day',          cat: 'general', day: 41, h: 9,  mem: SARAH,   loc: 'Food Bank' },
  { t: 'Daniel Investment Review',     cat: 'work',    day: 42, h: 14, mem: DANIEL },
  { t: 'Jackson Soccer Practice',      cat: 'sports',  day: 43, h: 16, mem: JACKSON, loc: 'Riverside Fields' },
  { t: 'Lily First Day of Summer Camp',cat: 'general', day: 44, h: 8,  mem: LILY,    loc: 'Camp Sunshine' },
  { t: 'Emma Girls Night Out',         cat: 'general', day: 45, h: 19, mem: EMMA },
  { t: 'Family Dinner at Grandmas',    cat: 'family',  day: 47, h: 17, mem: null,    loc: "Grandma Ruth's house" },
  { t: 'Sarah Dermatologist',          cat: 'medical', day: 48, h: 11, mem: SARAH,   loc: 'Skin Care Center' },
  { t: 'Lily Swimming Lessons 2',      cat: 'sports',  day: 50, h: 10, mem: LILY,    loc: 'Community Pool' },
  { t: 'Jackson Baseball Tryout',      cat: 'sports',  day: 52, h: 9,  mem: JACKSON, loc: 'East Athletic Complex' },
];

for (const e of fixed) {
  const base = e.day === 0 ? today.toISOString() : daysFrom(e.day);
  rows.push({
    id: uuid(), family_id: FAMILY_ID, created_by: CB,
    title: e.t, category: e.cat,
    starts_at: timeAt(base, e.h), ends_at: timeAt(base, e.h + 2),
    all_day: false, recurrence: 'none',
    assignee_id: e.mem ?? null, location: e.loc ?? null,
  });
}

const { data, error } = await sb.from('calendar_events').insert(rows).select('id');
if (error) console.error('❌', error.message);
else console.log(`✓ calendar_events: +${data.length}`);
