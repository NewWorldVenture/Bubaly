process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://ltcxlbipiihclxwioyqj.supabase.co',
  'sb_secret_BfCiburaPbck_7uXGgWOPA_glwQ5GkV',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const FAMILY_ID  = 'a0cba6bd-88f7-48a9-926d-b27e5cf671dc';
const CB         = 'df41e924-9bea-4980-98d4-f9d78df05e49'; // auth.users.id for created_by
const USER_ID    = CB;

const { data: mems } = await sb.from('family_members').select('id,display_name').eq('family_id', FAMILY_ID);
const m = Object.fromEntries(mems.map(x => [x.display_name, x.id]));
const DANIEL  = m['Daniel'];
const SARAH   = m['Sarah'];
const EMMA    = m['Emma'];
const JACKSON = m['Jackson'];
const LILY    = m['Lily'];

const uuid = () => crypto.randomUUID();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randF = (min, max, dec=2) => parseFloat((Math.random() * (max - min) + min).toFixed(dec));
const today = new Date('2026-06-19');
const daysAgo  = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString(); };
const daysFrom = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString(); };
const dateStr  = (n) => daysFrom(n).slice(0, 10);

async function ins(table, rows) {
  if (!rows.length) { console.log(`  – ${table}: 0 rows`); return []; }
  const { data, error } = await sb.from(table).insert(rows).select('id');
  if (error) { console.error(`❌ ${table}:`, error.message); return []; }
  console.log(`  ✓ ${table}: +${rows.length}`);
  return data ?? [];
}

// ─── FINANCIAL ACCOUNTS ────────────────────────────────────────────────────
// type enum: 'checking' | 'savings' | 'credit' | 'investment' | 'retirement'
console.log('\n── Financial Accounts ──');
const ACC = { checking: uuid(), savings: uuid(), credit: uuid(), invest401k: uuid(), emmaColl: uuid(), sarah401k: uuid() };
await ins('financial_accounts', [
  { id: ACC.checking,  family_id: FAMILY_ID, name: 'Chase Checking',         type: 'checking',    balance: 8432.17,   institution: 'Chase Bank',   last_four: '4892', created_by: CB },
  { id: ACC.savings,   family_id: FAMILY_ID, name: 'Chase Savings',          type: 'savings',     balance: 18400.00,  institution: 'Chase Bank',   last_four: '7731', created_by: CB },
  { id: ACC.credit,    family_id: FAMILY_ID, name: 'Chase Sapphire Reserve', type: 'credit',      balance: -2847.33,  institution: 'Chase Bank',   last_four: '9903', created_by: CB },
  { id: ACC.invest401k,family_id: FAMILY_ID, name: "Daniel 401k — Fidelity", type: 'retirement',  balance: 287450.00, institution: 'Fidelity',    last_four: '0023', created_by: CB },
  { id: ACC.emmaColl,  family_id: FAMILY_ID, name: "Emma 529 College Fund",  type: 'investment',  balance: 42600.00,  institution: 'Vanguard',    last_four: '5512', created_by: CB },
  { id: ACC.sarah401k, family_id: FAMILY_ID, name: "Sarah 401k — Vanguard",  type: 'retirement',  balance: 94200.00,  institution: 'Vanguard',    last_four: '3341', created_by: CB },
]);

// ─── TRANSACTIONS ──────────────────────────────────────────────────────────
// columns: name, amount, category, date (date), type (income/expense/transfer), notes, account_id
console.log('\n── Transactions ──');
const transactions = [];

// Income: biweekly
for (let i = 0; i < 6; i++) {
  transactions.push({ id: uuid(), family_id: FAMILY_ID, account_id: ACC.checking, name: 'Payroll — NewWorld Ventures', amount: 4832.50, category: 'salary', type: 'income', date: daysAgo(i * 14).slice(0, 10) });
  if (i < 3) transactions.push({ id: uuid(), family_id: FAMILY_ID, account_id: ACC.checking, name: 'Sarah Consulting Income', amount: 1250.00, category: 'freelance', type: 'income', date: daysAgo(i * 14 + 7).slice(0, 10) });
}

// Expense templates
const tmplts = [
  { n: 'Whole Foods Market', min: 80,  max: 220, cat: 'groceries', acc: 'credit' },
  { n: 'Costco Wholesale',   min: 120, max: 350, cat: 'groceries', acc: 'credit' },
  { n: 'Target',             min: 40,  max: 180, cat: 'groceries', acc: 'credit' },
  { n: 'Starbucks',          min: 8,   max: 25,  cat: 'dining',    acc: 'credit' },
  { n: 'Chipotle',           min: 25,  max: 55,  cat: 'dining',    acc: 'credit' },
  { n: 'Olive Garden',       min: 60,  max: 120, cat: 'dining',    acc: 'credit' },
  { n: 'Netflix',            min: 22,  max: 23,  cat: 'entertainment', acc: 'credit' },
  { n: 'Spotify Family',     min: 16,  max: 17,  cat: 'entertainment', acc: 'credit' },
  { n: 'Disney+',            min: 13,  max: 14,  cat: 'entertainment', acc: 'credit' },
  { n: 'AT&T Wireless',      min: 184, max: 185, cat: 'utilities',  acc: 'checking' },
  { n: 'Xfinity Internet',   min: 89,  max: 90,  cat: 'utilities',  acc: 'checking' },
  { n: 'Duke Energy',        min: 120, max: 280, cat: 'utilities',  acc: 'checking' },
  { n: 'Shell Gas',          min: 55,  max: 90,  cat: 'transport',  acc: 'credit' },
  { n: 'Kaplan Learning',    min: 299, max: 300, cat: 'education',  acc: 'checking' },
  { n: 'Emma Piano Lessons', min: 80,  max: 80,  cat: 'education',  acc: 'checking' },
  { n: 'CVS Pharmacy',       min: 18,  max: 65,  cat: 'healthcare', acc: 'credit' },
  { n: 'Amazon.com',         min: 25,  max: 150, cat: 'shopping',   acc: 'credit' },
  { n: 'Home Depot',         min: 35,  max: 180, cat: 'home',       acc: 'credit' },
  { n: 'Old Navy',           min: 40,  max: 120, cat: 'clothing',   acc: 'credit' },
  { n: 'Wells Fargo Mortgage', min: 2847, max: 2848, cat: 'housing', acc: 'checking' },
];

for (let i = 0; i < 90; i++) {
  const cnt = rand(2, 4);
  for (let j = 0; j < cnt; j++) {
    const t = pick(tmplts);
    transactions.push({ id: uuid(), family_id: FAMILY_ID, account_id: ACC[t.acc] ?? ACC.checking, name: t.n, amount: -randF(t.min, t.max), category: t.cat, type: 'expense', date: daysAgo(i).slice(0, 10) });
  }
}

for (let i = 0; i < transactions.length; i += 100) {
  const chunk = transactions.slice(i, i + 100);
  const { error } = await sb.from('transactions').insert(chunk);
  if (error) { console.error('❌ transactions batch:', error.message); break; }
}
console.log(`  ✓ transactions: +${transactions.length}`);

// ─── BUDGETS ────────────────────────────────────────────────────────────────
// columns: category, amount, period (weekly/monthly/yearly)
console.log('\n── Budgets ──');
await ins('budgets', [
  { id: uuid(), family_id: FAMILY_ID, category: 'groceries',    amount: 1200.00, period: 'monthly', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, category: 'dining',       amount: 400.00,  period: 'monthly', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, category: 'utilities',    amount: 500.00,  period: 'monthly', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, category: 'entertainment',amount: 200.00,  period: 'monthly', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, category: 'healthcare',   amount: 300.00,  period: 'monthly', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, category: 'clothing',     amount: 250.00,  period: 'monthly', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, category: 'transport',    amount: 350.00,  period: 'monthly', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, category: 'education',    amount: 600.00,  period: 'monthly', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, category: 'home',         amount: 400.00,  period: 'monthly', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, category: 'shopping',     amount: 300.00,  period: 'monthly', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, category: 'housing',      amount: 3000.00, period: 'monthly', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, category: 'vacation',     amount: 8000.00, period: 'yearly',  created_by: CB },
]);

// ─── BILLS ──────────────────────────────────────────────────────────────────
// columns: name, amount, due_date (date), is_recurring, recurrence, status (upcoming/paid/overdue), category
console.log('\n── Bills ──');
await ins('bills', [
  { id: uuid(), family_id: FAMILY_ID, name: 'Wells Fargo Mortgage',       amount: 2847.00, due_date: dateStr(12), is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: 'housing',       created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'AT&T Wireless',              amount: 184.00,  due_date: dateStr(-4), is_recurring: true, recurrence: 'monthly', status: 'paid',     category: 'utilities',     created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Xfinity Internet',           amount: 89.99,   due_date: dateStr(1),  is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: 'utilities',     created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Duke Energy Electric',       amount: 185.00,  due_date: dateStr(3),  is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: 'utilities',     created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'State Farm Home Insurance',  amount: 175.00,  due_date: dateStr(-14),is_recurring: true, recurrence: 'monthly', status: 'paid',     category: 'insurance',     created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Progressive Auto Insurance', amount: 210.00,  due_date: dateStr(8),  is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: 'insurance',     created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Netflix',                    amount: 22.99,   due_date: dateStr(-12),is_recurring: true, recurrence: 'monthly', status: 'paid',     category: 'entertainment', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Spotify Family',             amount: 16.99,   due_date: dateStr(7),  is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: 'entertainment', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Amazon Prime',               amount: 14.99,   due_date: dateStr(-1), is_recurring: true, recurrence: 'monthly', status: 'paid',     category: 'entertainment', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Disney+',                    amount: 13.99,   due_date: dateStr(11), is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: 'entertainment', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'City Water and Sewer',       amount: 67.00,   due_date: dateStr(9),  is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: 'utilities',     created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'HOA Dues',                   amount: 125.00,  due_date: dateStr(-19),is_recurring: true, recurrence: 'monthly', status: 'paid',     category: 'housing',       created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Fidelity 401k Contribution', amount: 500.00,  due_date: dateStr(-5), is_recurring: true, recurrence: 'monthly', status: 'paid',     category: 'savings',       created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: "Emma 529 Contribution",      amount: 500.00,  due_date: dateStr(-5), is_recurring: true, recurrence: 'monthly', status: 'paid',     category: 'savings',       created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Car Registration Honda',     amount: 148.00,  due_date: dateStr(30), is_recurring: true, recurrence: 'yearly',  status: 'upcoming', category: 'transport',     created_by: CB },
]);

// ─── SAVINGS GOALS ──────────────────────────────────────────────────────────
// columns: name, target_amount, current_amount, target_date (date), emoji
console.log('\n── Savings Goals ──');
await ins('savings_goals', [
  { id: uuid(), family_id: FAMILY_ID, name: 'Emergency Fund',        target_amount: 25000, current_amount: 18400, target_date: dateStr(180), emoji: '🛡️', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Hawaii Vacation 2027',  target_amount: 8000,  current_amount: 3600,  target_date: dateStr(400), emoji: '🌺', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Kitchen Remodel',       target_amount: 15000, current_amount: 2300,  target_date: dateStr(270), emoji: '🏠', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: "Emma College Fund",     target_amount: 80000, current_amount: 42600, target_date: dateStr(730), emoji: '🎓', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'New Roof Fund',         target_amount: 18000, current_amount: 4500,  target_date: dateStr(540), emoji: '🏗️', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Solar Panels',          target_amount: 22000, current_amount: 0,     target_date: dateStr(300), emoji: '☀️', created_by: CB },
  { id: uuid(), family_id: FAMILY_ID, name: 'Holiday Gifts Fund',    target_amount: 2000,  current_amount: 450,   target_date: dateStr(185), emoji: '🎁', created_by: CB },
]);

// ─── HEALTH METRICS ──────────────────────────────────────────────────────────
// type enum: 'steps'|'sleep_hours'|'heart_rate'|'calories'|'active_minutes'|'distance'|'weight'|'water_cups'
// no created_by column
console.log('\n── Health Metrics ──');
const hmRows = [];
// Daniel
for (let i = 90; i >= 0; i -= 3) {
  hmRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: DANIEL, type: 'weight',      value: randF(195, 205, 1), unit: 'lbs',   recorded_at: daysAgo(i) });
  if (i % 7 === 0) hmRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: DANIEL, type: 'heart_rate', value: rand(62, 78), unit: 'bpm', recorded_at: daysAgo(i) });
}
for (let i = 60; i >= 0; i--) {
  if (Math.random() > 0.35) hmRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: DANIEL, type: 'steps',       value: rand(3500, 12000), unit: 'steps', recorded_at: daysAgo(i) });
  if (Math.random() > 0.5)  hmRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: DANIEL, type: 'sleep_hours', value: randF(5.5, 8.5, 1), unit: 'hours', recorded_at: daysAgo(i) });
  if (Math.random() > 0.6)  hmRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: DANIEL, type: 'active_minutes', value: rand(15, 75), unit: 'min', recorded_at: daysAgo(i) });
}
// Sarah
for (let i = 60; i >= 0; i -= 4) {
  hmRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: SARAH, type: 'weight',      value: randF(136, 143, 1), unit: 'lbs',   recorded_at: daysAgo(i) });
  hmRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: SARAH, type: 'sleep_hours', value: randF(6.0, 8.5, 1), unit: 'hours', recorded_at: daysAgo(i) });
  if (Math.random() > 0.5) hmRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: SARAH, type: 'steps', value: rand(5000, 14000), unit: 'steps', recorded_at: daysAgo(i) });
}
// Kids — periodic weight/heart rate
for (const [kid, wMin, wMax] of [[EMMA,115,120],[JACKSON,82,88],[LILY,52,56]]) {
  for (let i = 0; i < 6; i++) {
    hmRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: kid, type: 'weight',     value: randF(wMin, wMax, 1), unit: 'lbs', recorded_at: daysAgo(i * 15) });
    hmRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: kid, type: 'heart_rate', value: rand(68, 90), unit: 'bpm', recorded_at: daysAgo(i * 15) });
    if (kid === EMMA) hmRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: EMMA, type: 'sleep_hours', value: randF(7, 9, 1), unit: 'hours', recorded_at: daysAgo(i * 15) });
  }
}
await ins('health_metrics', hmRows);

// ─── WORKOUT LOGS ──────────────────────────────────────────────────────────
// columns: member_id, activity (not workout_type), duration_minutes, calories, distance, notes, recorded_at, created_by
console.log('\n── Workout Logs ──');
const wlRows = [];
const ACTIVITIES = ['running','walking','cycling','swimming','weightlifting','yoga','HIIT','stretching','hiking','pilates'];
for (let i = 90; i >= 0; i--) {
  if (Math.random() > 0.45) continue;
  const act = pick(ACTIVITIES);
  wlRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: pick([DANIEL, SARAH]), activity: act, duration_minutes: rand(20, 75), calories: rand(150, 550), notes: `${act} session`, recorded_at: daysAgo(i), created_by: CB });
}
for (let i = 60; i >= 0; i--) {
  if (Math.random() > 0.45) continue;
  wlRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: EMMA, activity: pick(['swimming','running','yoga']), duration_minutes: rand(30,60), calories: rand(100,350), recorded_at: daysAgo(i), created_by: CB });
}
await ins('workout_logs', wlRows);

// ─── SCHOOL CLASSES ─────────────────────────────────────────────────────────
// columns: member_id, subject, teacher, room, time_slot, day_of_week, school_name, created_by
console.log('\n── School Classes ──');
const clsRows = [];
const classIdMap = new Map();

const EMMA_CLS = [
  { s: 'AP Chemistry',   t: 'Mr. Rodriguez',   r: '201', ts: '8:00-9:00 AM',  dn: 'Westfield High School' },
  { s: 'AP Calculus BC', t: 'Ms. Johnson',     r: '315', ts: '9:15-10:15 AM', dn: 'Westfield High School' },
  { s: 'AP History',     t: 'Mr. Thompson',    r: '108', ts: '10:30-11:30 AM',dn: 'Westfield High School' },
  { s: 'AP English Lit', t: 'Dr. Washington',  r: '220', ts: '12:00-1:00 PM', dn: 'Westfield High School' },
  { s: 'Spanish IV',     t: 'Sra. Martinez',   r: '145', ts: '1:15-2:15 PM',  dn: 'Westfield High School' },
  { s: 'Physics',        t: 'Mr. Chen',        r: '203', ts: '2:30-3:30 PM',  dn: 'Westfield High School' },
  { s: 'Robotics Club',  t: 'Mr. Patel',       r: '120', ts: '3:30-5:00 PM',  dn: 'Westfield High School' },
];
const JACKSON_CLS = [
  { s: 'Math 6',         t: 'Mr. Peterson',    r: '105', ts: '8:00-8:50 AM',  dn: 'Riverside Middle School' },
  { s: 'Language Arts',  t: 'Ms. Williams',    r: '112', ts: '9:00-9:50 AM',  dn: 'Riverside Middle School' },
  { s: 'Social Studies', t: 'Ms. Brown',       r: '201', ts: '10:00-10:50 AM',dn: 'Riverside Middle School' },
  { s: 'Science',        t: 'Mr. Davis',       r: '208', ts: '11:00-11:50 AM',dn: 'Riverside Middle School' },
  { s: 'PE',             t: 'Coach Miller',    r: 'Gym', ts: '1:00-1:50 PM',  dn: 'Riverside Middle School' },
  { s: 'Art',            t: 'Ms. Garcia',      r: '115', ts: '2:00-2:50 PM',  dn: 'Riverside Middle School' },
];
const LILY_CLS = [
  { s: 'Reading and Phonics',   t: 'Mrs. Taylor', r: 'K-2', ts: '8:00-9:00 AM', dn: 'Sunny Days Elementary' },
  { s: 'Math Foundations',      t: 'Mrs. Taylor', r: 'K-2', ts: '9:00-10:00 AM',dn: 'Sunny Days Elementary' },
  { s: 'Art and Music',         t: 'Mr. Wilson',  r: 'K-2', ts: '1:00-2:00 PM', dn: 'Sunny Days Elementary' },
];

for (const [member, classes] of [[EMMA, EMMA_CLS],[JACKSON, JACKSON_CLS],[LILY, LILY_CLS]]) {
  for (const c of classes) {
    const id = uuid();
    classIdMap.set(`${member}-${c.s}`, id);
    clsRows.push({ id, family_id: FAMILY_ID, member_id: member, subject: c.s, teacher: c.t, room: c.r, time_slot: c.ts, school_name: c.dn, created_by: CB });
  }
}
await ins('school_classes', clsRows);

// ─── GRADES ─────────────────────────────────────────────────────────────────
// columns: member_id, class_id, subject, title, grade (text), grade_type, score, max_score, date
// grade_type: 'test'|'quiz'|'homework'|'project'|'final'|'participation'|'other'
console.log('\n── Grades ──');
const gradeRows = [];
const EMMA_SCORES = { 'AP Chemistry': [88,91,85,92,87,90,95], 'AP Calculus BC': [95,97,93,98,96,94,100], 'AP History': [91,89,94,92,90,93,95], 'AP English Lit': [96,94,97,95,92,96,98], 'Spanish IV': [93,95,91,94,96,92,97], 'Physics': [89,87,91,88,90,87,93] };
const JACK_SCORES = { 'Math 6': [92,88,95,91,87,94,96], 'Language Arts': [85,88,82,87,90,84,91], 'Social Studies': [89,91,86,93,88,90,92], 'Science': [94,92,88,96,91,89,95], 'Art': [98,97,99,96,98,99,100] };
const TYPES = ['test','quiz','homework','project','test','quiz','final'];

for (const [member, subjectMap] of [[EMMA, EMMA_SCORES], [JACKSON, JACK_SCORES]]) {
  for (const [subj, scores] of Object.entries(subjectMap)) {
    const classId = classIdMap.get(`${member}-${subj}`);
    scores.forEach((score, i) => {
      const pct = Math.round(score);
      const letter = pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : 'D';
      gradeRows.push({ id: uuid(), family_id: FAMILY_ID, member_id: member, class_id: classId ?? null, subject: subj, title: `${subj} — ${TYPES[i]} ${i+1}`, grade: `${letter} (${pct}%)`, grade_type: TYPES[i], score, max_score: 100, date: daysAgo(rand(5 + i*10, 12 + i*10)).slice(0,10), created_by: CB });
    });
  }
}
await ins('grades', gradeRows);

// ─── TEAMS ───────────────────────────────────────────────────────────────────
// columns: member_id, sport, team_name, season, coach, is_active
console.log('\n── Teams ──');
const T_SOCCER   = uuid(), T_BASEBALL = uuid(), T_SWIM = uuid(), T_BALLET = uuid();
await ins('teams', [
  { id: T_SOCCER,   family_id: FAMILY_ID, member_id: JACKSON, sport: 'Soccer',   team_name: 'Riverside Rockets', season: 'Spring 2026', coach: 'Mike Peterson',  is_active: true, created_by: CB },
  { id: T_BASEBALL, family_id: FAMILY_ID, member_id: JACKSON, sport: 'Baseball', team_name: 'Blue Jays',         season: 'Summer 2026', coach: 'Dave Rivera',    is_active: true, created_by: CB },
  { id: T_SWIM,     family_id: FAMILY_ID, member_id: EMMA,    sport: 'Swimming', team_name: 'Westfield Swim Club',season: 'Spring 2026', coach: 'Lisa Nguyen',    is_active: true, created_by: CB },
  { id: T_BALLET,   family_id: FAMILY_ID, member_id: LILY,    sport: 'Ballet',   team_name: 'City Dance Academy', season: 'Spring 2026', coach: 'Sarah Fontaine', is_active: true, created_by: CB },
]);

// ─── GAME RESULTS ────────────────────────────────────────────────────────────
// columns: team_id, opponent, our_score, their_score, date (date), result (win/loss/tie), notes
console.log('\n── Game Results ──');
const gameRows = [];
const S_GAMES = [
  { opp: 'Eastside Eagles',   us: 3, th: 1, res: 'win' }, { opp: 'Northfield Tigers', us: 2, th: 2, res: 'tie' },
  { opp: 'Westwood Warriors', us: 1, th: 2, res: 'loss'}, { opp: 'Lakeside Lightning',us: 4, th: 0, res: 'win' },
  { opp: 'Hillside Hawks',    us: 2, th: 1, res: 'win' }, { opp: 'Valley Vipers',     us: 0, th: 3, res: 'loss'},
  { opp: 'Creekside Cougars', us: 3, th: 2, res: 'win' }, { opp: 'Sunset Stars',      us: 1, th: 1, res: 'tie' },
  { opp: 'Eastside Eagles',   us: 2, th: 0, res: 'win' }, { opp: 'Northfield Tigers', us: 1, th: 3, res: 'loss'},
];
S_GAMES.forEach((g, i) => gameRows.push({ id: uuid(), family_id: FAMILY_ID, team_id: T_SOCCER, opponent: g.opp, our_score: g.us, their_score: g.th, result: g.res, date: daysAgo((S_GAMES.length - i) * 7).slice(0,10), created_by: CB }));

const B_GAMES = [
  { opp: 'Crosstown Cubs',    us: 5, th: 3, res: 'win' }, { opp: 'Riverside Reds',    us: 2, th: 7, res: 'loss'},
  { opp: 'Greenview Giants',  us: 4, th: 4, res: 'tie' }, { opp: 'Lakeview Lions',    us: 6, th: 2, res: 'win' },
  { opp: 'Millbrook Marlins', us: 3, th: 5, res: 'loss'}, { opp: 'Parkside Pirates',  us: 7, th: 1, res: 'win' },
  { opp: 'Crosstown Cubs',    us: 4, th: 2, res: 'win' },
];
B_GAMES.forEach((g, i) => gameRows.push({ id: uuid(), family_id: FAMILY_ID, team_id: T_BASEBALL, opponent: g.opp, our_score: g.us, their_score: g.th, result: g.res, date: daysAgo((B_GAMES.length - i) * 10).slice(0,10), created_by: CB }));

await ins('game_results', gameRows);

// ─── AI CONVERSATIONS + MESSAGES ─────────────────────────────────────────────
// ai_conversations: user_id, title, provider, model
// ai_messages: conversation_id, family_id, role ('user'|'assistant'|'system'|'tool'), content
console.log('\n── AI Conversations ──');
const TOPICS = [
  { t: 'Family vacation planning to Hawaii' },
  { t: "Help with Emma's college essay" },
  { t: 'Meal prep ideas for the week' },
  { t: 'Jackson soccer training tips' },
  { t: 'Managing family budget for June' },
  { t: 'Summer activities for Lily' },
  { t: 'HVAC maintenance guidance' },
  { t: 'Kids screen time best practices' },
  { t: 'Healthy dinner ideas for picky eaters' },
  { t: 'Work-life balance strategies' },
  { t: 'Back to school shopping checklist' },
  { t: 'Family organization tips' },
  { t: 'SAT prep resources for Emma' },
  { t: 'Family chore system optimization' },
  { t: 'Camping trip planning checklist' },
];

const convos = TOPICS.map(t => ({ id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, title: t.t, provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }));
await ins('ai_conversations', convos);

const aiMsgs = [];
for (const c of convos) {
  const n = rand(3, 7);
  for (let j = 0; j < n; j++) {
    aiMsgs.push({ id: uuid(), family_id: FAMILY_ID, conversation_id: c.id, role: j % 2 === 0 ? 'user' : 'assistant', content: j % 2 === 0 ? `Help me with: ${c.title}. What should I know?` : `Happy to help with ${c.title}! Here are the key points to consider based on your family's situation...`, created_at: daysAgo(rand(0, 60)) });
  }
}
await ins('ai_messages', aiMsgs);

// ─── NOTIFICATIONS ──────────────────────────────────────────────────────────
// columns: user_id, type (notification_type enum), title, body, is_read, send_at, sent_at
// type enum: 'chore_due'|'medication_due'|'calendar_event'|'school_event'|'sports_event'|'maintenance_task'|'grocery_reminder'|'document_expiry'|'family_invite'|'system'
console.log('\n── Notifications ──');
await ins('notifications', [
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'chore_due',         title: 'Chore Completed',          body: 'Emma completed Empty Dishwasher and earned 5 points!', is_read: false, send_at: daysAgo(0) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'calendar_event',    title: 'Upcoming Event',           body: 'Jackson Soccer Game vs Eagles is in 5 days',           is_read: false, send_at: daysAgo(0) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'grocery_reminder',  title: 'Shopping Reminder',        body: 'Grocery pickup scheduled for today at 5pm — Whole Foods', is_read: false, send_at: daysAgo(0) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'chore_due',         title: 'Chore Needs Approval',     body: 'Jackson submitted Vacuum Living Room for your approval (+15 pts)', is_read: false, send_at: daysAgo(1) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'medication_due',    title: 'Medication Reminder',      body: "Jackson's Zyrtec dose scheduled for 8:00 AM",          is_read: true,  send_at: daysAgo(1) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'maintenance_task',  title: 'Maintenance Overdue',      body: 'HVAC Air Filter replacement is overdue — high priority',is_read: false, send_at: daysAgo(2) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'school_event',      title: 'School Event Reminder',    body: "Lily's School Play Cinderella is in 6 days!",           is_read: false, send_at: daysAgo(2) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'sports_event',      title: 'Game Result Recorded',     body: 'Jackson scored 2 goals — Riverside Rockets won 3-1!',   is_read: true,  send_at: daysAgo(3) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'document_expiry',   title: 'Document Expiring',        body: "Sarah's Driver License expires in ~12 months — renewal reminder set", is_read: true, send_at: daysAgo(3) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'calendar_event',    title: 'Event Reminder',           body: "Emma's Piano Recital is in 3 days at Harmony Music School", is_read: false, send_at: daysAgo(0) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'system',            title: 'Morning Briefing Ready',   body: 'Your AI Family Briefing for June 19 is ready — 4 events today!', is_read: false, send_at: daysAgo(0) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'chore_due',         title: 'Daily Chores Reminder',    body: '3 chores due today: Feed Dog (Jackson), Set Table (Lily), Make Bed (Jackson)', is_read: false, send_at: daysAgo(0) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'medication_due',    title: 'Evening Medication',       body: "Reminder: Sarah's Magnesium Glycinate at 9:00 PM",       is_read: false, send_at: daysAgo(0) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'grocery_reminder',  title: 'Low Stock Alert',          body: 'Several items running low — check grocery list',           is_read: true,  send_at: daysAgo(4) },
  { id: uuid(), family_id: FAMILY_ID, user_id: USER_ID, type: 'school_event',      title: 'Assignment Due Tomorrow',  body: "Jackson's Permission Slip for Field Trip due tomorrow",   is_read: false, send_at: daysAgo(0) },
]);

// ─── FINAL COUNT ────────────────────────────────────────────────────────────
console.log('\n✅ Phase 2 complete!\n── Final Row Counts ──');
const tables = ['family_members','calendar_events','school_events','sports_events','appointments','chores','chore_assignments','rewards','meals','meal_plans','grocery_lists','grocery_items','medications','medication_schedules','home_assets','maintenance_tasks','documents','notes','goals','reminders','financial_accounts','transactions','budgets','bills','savings_goals','health_metrics','workout_logs','school_classes','grades','teams','game_results','ai_conversations','ai_messages','notifications'];
let total = 0;
for (const t of tables) {
  const { count } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('family_id', FAMILY_ID);
  const n = count ?? 0;
  total += n;
  if (n > 0) console.log(`  ${t}: ${n}`);
}
console.log(`\n🎉 TOTAL (Hughen family): ${total} rows`);
