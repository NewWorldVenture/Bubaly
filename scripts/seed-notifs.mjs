import { createSeedClient, requireSeedScope } from './seed-client.mjs';

const sb = createSeedClient();
const { familyId: FAMILY_ID, createdByUserId: USER_ID } = requireSeedScope();
const uuid=()=>crypto.randomUUID();
const d=(n)=>{const x=new Date('2026-06-19');x.setDate(x.getDate()-n);return x.toISOString();};
// Only valid types: 'system' and 'reminder'
const rows=[
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:'Chore Reminder',           body:'Emma: Empty Dishwasher due today',                    is_read:false,send_at:d(0)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:'Appointment Tomorrow',      body:'Jackson Dental Checkup at Bright Smiles, 9am',        is_read:false,send_at:d(0)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:'Grocery Pickup Today',      body:'Whole Foods pickup at 5pm (Sarah)',                   is_read:false,send_at:d(0)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:'Medication Reminder',       body:"Jackson's Zyrtec — 8:00 AM",                         is_read:true, send_at:d(1)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'system',  title:'Morning Briefing Ready',    body:'AI Family Briefing for June 19 is ready',            is_read:false,send_at:d(0)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:"Lily's School Play",        body:"School Play 'Cinderella' in 6 days — Lily is a fairy!",is_read:false,send_at:d(0)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:'Soccer Game Today!',        body:'Jackson vs Eagles at 10am — Eastside Sports Complex',  is_read:false,send_at:d(0)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'system',  title:'Goal Progress Update',      body:'Emergency Fund at 74% of $25,000 — great progress!',  is_read:false,send_at:d(1)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:'Bill Due Soon',             body:'Duke Energy due in 3 days — $185',                   is_read:false,send_at:d(2)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'system',  title:'Weekly Chore Summary',      body:'Family completed 14 chores this week — 285 pts earned!',is_read:true,send_at:d(3)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:'Permission Slip Due',       body:"Jackson's Field Trip form due tomorrow — sign & return",is_read:false,send_at:d(0)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:'SAT Registration Deadline', body:'Emma: Register at collegeboard.org by July 15',       is_read:false,send_at:d(0)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'system',  title:'New Grade Posted',          body:'Emma received 97/100 on AP Calculus BC Quiz!',        is_read:false,send_at:d(1)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:'Maintenance Overdue',       body:'HVAC air filter replacement is overdue — high priority',is_read:false,send_at:d(2)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:"Grandma's Birthday!",       body:"Today is Grandma Ruth's birthday — she turns 74!",   is_read:false,send_at:d(0)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:'Lily Costume Pickup',       body:'Ballet recital costume ready at City Dance Academy after 3pm',is_read:false,send_at:d(0)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'system',  title:'Reward Redeemed',           body:"Jackson redeemed 'Extra Screen Time' (50 pts) — approved!",is_read:true,send_at:d(4)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:'Prescription Ready',        body:"Jackson's Zyrtec refill is ready at Walgreens",       is_read:true, send_at:d(5)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'reminder',title:'Library Books Due',         body:'3 books due — Lily has 2, Jackson has 1',             is_read:false,send_at:d(0)},
  {id:uuid(),family_id:FAMILY_ID,user_id:USER_ID,type:'system',  title:'Budget Alert',              body:'Dining Out budget is 87% used with 11 days left',     is_read:false,send_at:d(2)},
];
const {data,error}=await sb.from('notifications').insert(rows).select('id');
if(error)throw new Error(`Seed insert failed for notifications: ${error.message}`);
else console.log('✓ notifications: +'+data.length);

// Final count
const tables=['family_members','calendar_events','school_events','sports_events','appointments','chores','chore_assignments','rewards','meals','meal_plans','grocery_lists','grocery_items','medications','medication_schedules','home_assets','maintenance_tasks','documents','notes','goals','reminders','financial_accounts','transactions','budgets','bills','savings_goals','health_metrics','workout_logs','school_classes','grades','teams','game_results','ai_conversations','ai_messages','notifications'];
let total=0;
console.log('\n── Final Row Counts ──');
for(const t of tables){
  const {count}=await sb.from(t).select('*',{count:'exact',head:true}).eq('family_id',FAMILY_ID);
  total+=count??0;
  if((count??0)>0)console.log(`  ${t}: ${count}`);
}
console.log(`\n🎉 GRAND TOTAL: ${total} rows`);
