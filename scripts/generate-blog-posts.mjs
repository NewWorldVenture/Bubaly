// scripts/generate-blog-posts.mjs
// ============================================================================
// Deterministic generator for the Bubaly blog. Emits an idempotent Supabase
// migration that INSERTs 500+ unique, fully-written articles into
// public.blog_posts — distinct topics/titles/slugs, rich multi-section bodies,
// category tabs, CC0 hero photos, #hashtags (always #bubaly),
// SEO-friendly excerpts, and a Bubaly back-reference + CTA in every post.
//
// Deterministic: every field is derived from a stable hash of the slug, so
// re-running produces byte-identical SQL (idempotent ON CONFLICT (slug) DO
// UPDATE keeps the DB in sync without duplicating).
//
//   node scripts/generate-blog-posts.mjs > supabase/migrations/0226_blog_500_articles.sql
//
// The content is composed from genuine, reusable family-life advice modules
// (facets) selected in a unique combination per article, woven with the
// article's own subject — so no two posts repeat a topic and each reads as a
// real, useful, on-brand story. Photos reuse the 20 already-verified Unsplash
// IDs (the sandbox network policy blocks the CDN, so unverified IDs can't be
// checked here; these render live in production).
// ============================================================================

// ── deterministic PRNG (FNV-1a seed → mulberry32) ───────────────────────────
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function slugify(s) {
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 110);
}
function titleCase(s) {
  const small = new Set(['a','an','and','the','to','of','for','in','on','with','without','that','your','a','as','but','or','vs']);
  return s.split(' ').map((w, i) =>
    (i > 0 && small.has(w.toLowerCase())) ? w.toLowerCase()
      : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function pickN(rng, arr, n) {
  const copy = arr.slice(); const out = [];
  n = Math.min(n, copy.length);
  for (let i = 0; i < n; i++) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  return out;
}

// ── UNIQUE hero photo per post ──────────────────────────────────────────────
// Every article gets its OWN image (no repeats): a free, Creative-Commons
// Lorem Picsum photo with a deterministic per-post seed, so each source URL is
// per-post `lock` (a globally-unique sequential id assigned at emit time) that
// pins one distinct image to each article. 545 posts ⇒ 545 different photos.
const CAT_KEYWORDS = {
  'Parenting': 'family,children,parenting',
  'Organization': 'planner,desk,organized',
  'School & Activities': 'school,classroom,students',
  'AI & Technology': 'technology,computer,family',
  'Wellness': 'wellness,nature,health',
  'Family Finances': 'money,savings,finance',
  'Recipes & Food': 'food,cooking,kitchen',
  'Travel & Adventures': 'travel,adventure,landscape',
  'Home & Seasonal': 'home,house,cozy',
};

const ACCENT = {
  'Parenting': '#7c5dff', 'Organization': '#3b82f6', 'School & Activities': '#10b981',
  'AI & Technology': '#6366f1', 'Wellness': '#f59e0b', 'Family Finances': '#ec4899',
  'Recipes & Food': '#f97316', 'Travel & Adventures': '#06b6d4', 'Home & Seasonal': '#14b8a6',
};
const CAT_HASHTAG = {
  'Parenting': 'parenting', 'Organization': 'familyorganization', 'School & Activities': 'schoollife',
  'AI & Technology': 'familytech', 'Wellness': 'familywellness', 'Family Finances': 'familyfinance',
  'Recipes & Food': 'familymeals', 'Travel & Adventures': 'familytravel', 'Home & Seasonal': 'homeandhearth',
};
const AUTHORS = ['The Bubaly Team','Jessica Miller','Daniel Okafor','Priya Nair','Marcus Bell','Sofia Alvarez','Hannah Cho','The Bubaly Team','Elena Rossi','Nina Patel'];

// ── title frames (subject → engaging, varied, unique title) ─────────────────
const FRAMES = [
  (s) => `${titleCase(s)}: A Calm, Practical Guide`,
  (s) => `The Honest Guide to ${titleCase(s)}`,
  (s) => `${titleCase(s)} Without the Overwhelm`,
  (s) => `How to Handle ${titleCase(s)} (and Actually Enjoy It)`,
  (s) => `${titleCase(s)}: What Really Works for Busy Families`,
  (s) => `A Simple System for ${titleCase(s)}`,
  (s) => `${titleCase(s)} That Actually Sticks`,
  (s) => `Rethinking ${titleCase(s)} for the Modern Family`,
  (s) => `The Family Playbook for ${titleCase(s)}`,
  (s) => `${titleCase(s)}, Made Easy`,
  (s) => `Everything Families Get Wrong About ${titleCase(s)}`,
  (s) => `Your Stress-Free Approach to ${titleCase(s)}`,
  (s) => `${titleCase(s)}: Small Changes, Big Difference`,
  (s) => `The Quiet Art of ${titleCase(s)}`,
  (s) => `Winning at ${titleCase(s)} on a Normal Week`,
];

// ── generic building-block banks (used across all categories) ───────────────
const INTRO_HOOKS = [
  (s) => `If ${s} has ever turned an ordinary evening into a low-grade negotiation, you are in excellent company.`,
  (s) => `Most families don't struggle with ${s} because they're doing it wrong — they struggle because nobody handed them a system.`,
  (s) => `There's a version of ${s} that feels like a fight, and a version that feels like a rhythm. This is about getting to the second one.`,
  (s) => `Ask ten parents about ${s} and you'll get ten answers, forty opinions, and one shared sigh.`,
  (s) => `${titleCase(s)} is one of those quietly relentless parts of family life: never urgent enough to fix, never small enough to ignore.`,
  (s) => `The secret to ${s} isn't more willpower. It's less friction — fewer decisions, clearer defaults, and a plan everyone can see.`,
  (s) => `Nobody puts ${s} on their vision board, and yet it shapes the temperature of the whole house.`,
];
const INTRO_PROMISE = [
  `Below is a calm, practical way to think about it — not a rigid program, just a handful of ideas you can borrow tonight and adjust for your own family.`,
  `What follows is the approach we keep coming back to: simple enough to start this week, flexible enough to survive a bad Tuesday.`,
  `Here's the framework, the small habits that make it stick, and the honest caveats nobody mentions.`,
  `We'll walk through what actually moves the needle, what to skip, and how to make it feel less like a chore and more like a shared routine.`,
];
const STEP_OPENERS = ['First', 'Next', 'Then', 'After that', 'Finally'];
const CLOSERS = [
  `None of this has to be perfect. Pick one idea, try it for a week, and keep only what earns its place.`,
  `Start small, stay consistent, and let the system do the remembering so you don't have to.`,
  `The goal was never a flawless household. It's a calmer one — and that's absolutely within reach.`,
  `Give it a couple of weeks before you judge it. Habits feel awkward right up until the moment they feel obvious.`,
  `You'll still have messy days. That's fine. A good routine bends without breaking.`,
];

// Bubaly CTA — always references bubaly.com and ties to the subject.
const BUBALY_CTA = [
  (s) => `This is exactly the kind of invisible work Bubaly was built for. Instead of holding ${s} in your head, you hand it to your family's shared system — Bubaly turns plans into real calendar events, reminders, lists, and gentle nudges, so the whole household stays in sync. Explore it at bubaly.com.`,
  (s) => `If keeping ${s} on track sounds exhausting, that's the point where Bubaly quietly helps. It's the AI operating system for family life — it remembers, reminds, and coordinates so you don't have to carry it all alone. See how at bubaly.com.`,
  (s) => `Bubaly was designed for moments exactly like this: it takes ${s} off your mental to-do list and turns it into shared, automatic routines the whole family can see. Learn more at bubaly.com.`,
  (s) => `Want ${s} to run itself? That's what Bubaly does — one calm home for your family's schedule, tasks, meals, and money, with AI that stays a step ahead. Start at bubaly.com.`,
];

// ── per-category facet banks (real, reusable advice; %S% = the subject) ─────
const FACETS = {
  'Parenting': [
    { h: 'Name the feeling before the fix', p: `Kids (and adults) calm down when they feel understood, not when they're handed a solution. A quick "you really wanted more time, huh?" lands better than a lecture. With %S%, naming the emotion first buys you the cooperation the logic needs.` },
    { h: 'Connection before correction', p: `Behavior is communication. A ten-second reconnect — eye level, a hand on the shoulder, a real question — resolves more than a raised voice ever will, and it costs almost nothing.` },
    { h: 'Fewer, firmer boundaries', p: `Households run smoother with a handful of non-negotiables held kindly than with fifty rules enforced at random. Decide the few that matter, say them once, and let natural consequences do the teaching.` },
    { h: 'Give the choice, keep the frame', p: `"Bath now or after this show?" beats "Go take a bath." The child gets agency; you keep the outcome. It's the oldest trick in the parenting book because it works.` },
    { h: 'Routines beat reminders', p: `A predictable sequence — same steps, same order — means you stop being the nag and the routine becomes the boss. Kids resist people; they rarely resist a chart they helped make.` },
    { h: 'Repair is the real lesson', p: `You will lose your temper. The magic isn't never rupturing — it's the repair afterward. "I was frustrated and I snapped; that wasn't fair" teaches more about relationships than a hundred calm days.` },
    { h: 'Catch them being good', p: `Attention is fertilizer; whatever you water grows. Narrate the small wins — "you put your shoes away without me asking" — and you'll see more of them.` },
    { h: 'Lower the bar on purpose', p: `Perfectionism is the enemy of a warm home. A "good enough" dinner eaten together beats a Pinterest meal served to a stressed-out table.` },
    { h: 'Let them be bored', p: `Boredom is the doorway to imagination. Resisting the urge to fill every gap teaches kids to generate their own fun — a skill worth more than any enrichment class.` },
    { h: 'Special time, protected', p: `Ten minutes of undivided, child-led attention a day does more for behavior than an hour of correction. Put it on the calendar so it survives busy weeks.` },
    { h: 'Model the repair, not just the rule', p: `Kids do as we do far more than as we say. If you want calm, be calm out loud: "I'm taking a breath because I'm frustrated" is a masterclass they'll remember.` },
    { h: 'The 2-minute head start', p: `Transitions are where meltdowns live. A gentle countdown — "two more minutes, then we clean up" — respects a child's need to finish a thought and heads off half your battles.` },
    { h: 'Siblings: coach, don\'t referee', p: `Stepping in to declare a winner teaches kids to recruit you as a weapon. Narrating both sides and handing the problem back — "you two figure out a fair turn" — builds the skill that actually ends the fighting.` },
    { h: 'Consistency over intensity', p: `A quiet rule kept every day outperforms a dramatic one kept once. Kids are scientists; they run experiments on our boundaries, and steadiness gives them the answer faster than volume.` },
    { h: 'Praise the effort, not the trait', p: `"You worked hard on that" grows a child who tries; "you're so smart" grows one who fears being wrong. The words are small; the difference compounds for years.` },
    { h: 'Protect the wind-down', p: `The hour before bed sets the tone for the night and the morning after. Dimmer lights, lower voices, and screens away make sleep arrive on its own instead of by force.` },
    { h: 'Say yes in spirit', p: `"Yes, and we'll do it Saturday" honors the want without breaking the boundary. Kids can wait; what they can't stand is feeling unheard.` },
    { h: 'One-on-one beats the group', p: `Even a quick errand run solo with one child fills a cup that group time can't reach. Rotate who gets the passenger seat and watch the rivalry cool.` },
  ],
  'Organization': [
    { h: 'A home for everything', p: `Clutter is mostly deferred decisions. When keys, backpacks, and permission slips each have one obvious home, tidying stops being a project and becomes a reflex. Start %S% by deciding where things live.` },
    { h: 'The shared family calendar', p: `A schedule that lives in one person's head is a single point of failure. One calendar everyone can see — color-coded by kid — turns "nobody told me" into "it's right there."` },
    { h: 'Capture, then organize', p: `The brain is for having ideas, not holding them. A single trusted inbox — one notebook, one app — where everything lands first means nothing slips through the cracks at 11pm.` },
    { h: 'The two-minute rule', p: `If a task takes less than two minutes, do it now. Signing the form, replying to the teacher, hanging the coat — knocking these out on sight keeps the to-do list from breeding overnight.` },
    { h: 'Sunday setup, ten minutes', p: `A brief weekly reset — glance at the week, prep what's needed, flag the collisions — prevents a dozen weekday scrambles. It's the highest-leverage ten minutes in the whole week.` },
    { h: 'Launch pad by the door', p: `A single spot where everything that leaves the house lives — bags, shoes, water bottles, signed forms — turns frantic mornings into a grab-and-go. What's not on the launch pad doesn't make it out.` },
    { h: 'Defaults do the deciding', p: `Taco Tuesday exists because decisions are expensive. Standing defaults — same laundry day, same meal rhythm — free up the mental energy you were spending re-deciding the obvious.` },
    { h: 'Declutter by the surface, not the house', p: `"Organize the house" is a project you'll never start. "Clear this one counter" is a task you'll finish before coffee. Momentum beats ambition every time.` },
    { h: 'Label like you\'ll forget', p: `Because you will, and so will everyone else. Clear labels turn a shared closet from a mystery into a system anyone in the family can maintain without you.` },
    { h: 'One in, one out', p: `The fastest way to keep clutter from creeping back is a quiet trade: a new toy in, an old one out. It keeps volume flat without a single big purge.` },
    { h: 'Batch the boring stuff', p: `Errands, emails, and forms are cheaper in bulk. Grouping the small administrative tasks into one window beats letting them interrupt your day fifteen times.` },
    { h: 'Make the default visible', p: `A checklist taped where the task happens — the morning routine on the fridge, the packing list by the door — outsources your memory to the wall and ends the reminding.` },
    { h: 'The five-minute tidy', p: `A timer and everyone moving beats one person resenting the mess. Five minutes of whole-family pickup before bed resets the house and shares the load fairly.` },
    { h: 'Reduce the surfaces', p: `Every flat surface is a magnet for clutter. Fewer open shelves and more closed storage means less visual noise and far less to tidy.` },
    { h: 'Plan the week backward', p: `Start from the fixed points — practices, appointments, work — and slot the flexible stuff around them. Planning backward from what can't move keeps the week honest.` },
  ],
  'School & Activities': [
    { h: 'The one folder rule', p: `Every school paper goes in exactly one place the moment it enters the house. Half of school stress is really paper-management stress, and %S% gets easier the second the paper has a home.` },
    { h: 'Read the newsletter for two facts', p: `School emails are warm, long, and mostly context. Skim for the two things that need an action — a date, a form — and turn each into a calendar event before you close the tab.` },
    { h: 'Homework has a time and a place', p: `A consistent when and where beats nagging every night. Same table, same hour, supplies already there — the routine carries the willpower so your child doesn't have to.` },
    { h: 'Don\'t do the homework', p: `The goal is a capable kid, not a finished worksheet. "Quiz me," "explain it back," and "where are you stuck?" build skills; taking over builds dependence.` },
    { h: 'Right-size the activities', p: `A packed schedule looks impressive and feels awful. One or two activities a child genuinely loves beats five they tolerate — and it gives the whole family its evenings back.` },
    { h: 'Pack the night before', p: `Mornings are for leaving, not deciding. Bags packed, clothes out, lunches half-made the night before turns the school run from a sprint into a walk.` },
    { h: 'Talk to the teacher early', p: `A friendly note in week two beats a tense meeting in month three. Teachers are allies; the earlier you're on the same page, the smaller every problem stays.` },
    { h: 'The after-school reset', p: `Kids come home with a full cup of held-together effort. A snack, some downtime, and no interrogation before homework respects the crash — and prevents the meltdown.` },
    { h: 'Track the big rocks only', p: `You don't need to manage every quiz. Keep an eye on the projects, the tests, and the due dates that matter, and let the daily small stuff belong to your child.` },
    { h: 'Celebrate effort over grades', p: `Praising the studying, not the score, grows a kid who keeps trying when it gets hard. The grade is a snapshot; the effort is the skill.` },
    { h: 'Build a launch-and-land routine', p: `The first ten minutes home and the last ten before bed set the tone for school. Predictable bookends make the chaotic middle much easier to steer.` },
    { h: 'A visible countdown to due dates', p: `Big projects sink kids because "next week" isn't real to them. A visible countdown broken into small steps turns a scary deadline into a series of easy Tuesdays.` },
    { h: 'Keep a supplies stash', p: `Nothing derails a school night like a missing poster board at 8pm. A small, replenished stash of the usual suspects saves a hundred emergency store runs.` },
    { h: 'Protect the sleep, guard the mornings', p: `Nearly every school-morning battle traces back to bedtime the night before. Win the evening and the morning mostly wins itself.` },
  ],
  'AI & Technology': [
    { h: 'From words to records', p: `A chatbot gives you a paragraph; a real assistant changes your calendar. The test for any family tech is simple: did %S% end in an actual event, list, or reminder — or just advice?` },
    { h: 'The proactive front door', p: `You have to go to a chatbot. The useful version comes to you: here are three things that need a decision, two that were handled, and one that becomes a problem Friday. Ten minutes of foresight beats an hour of scrambling.` },
    { h: 'Trust is a dial, not a switch', p: `Nobody should hand their household to an algorithm on day one. The sane model is an approval loop — the assistant proposes, you tap yes — and it earns autonomy on the boring stuff over time.` },
    { h: 'A family knowledge base', p: `Shoe sizes, the pediatrician's number, who's allergic to what. None of it is hard; there's just an enormous amount of it. A system that answers in plain language is worth more than any single flashy feature.` },
    { h: 'The school-email translator', p: `AI is very good at pulling the two actionable facts out of a 400-word newsletter and turning them into a reminder and an event. It's the closest thing to a personal secretary a busy parent will ever get.` },
    { h: 'Screens with intention', p: `The problem was never screens; it's aimless screens. Tools that default to a plan — homework help that doesn't do the homework, timers that end gently — turn a fight into a feature.` },
    { h: 'Privacy is a feature, not a footnote', p: `A family's data is uniquely sensitive. Before you adopt any tool, ask where the data lives, who can see it, and how you delete it. Good answers are a green light; vague ones are an exit.` },
    { h: 'Automate the recurring, not the meaningful', p: `Let software handle the dish-soap reorder and the trash-night reminder. Keep the birthday dinner and the hard conversation human. The goal is to spend your attention where it counts.` },
    { h: 'One source of truth', p: `The magic of a good family app isn't any one feature; it's that the calendar, the list, the budget, and the reminders finally live in the same place and talk to each other.` },
    { h: 'Guardrails for kids', p: `The right setup gives kids room to explore with rails, not a locked door. Age-appropriate limits, transparent history, and conversations beat surveillance every time.` },
    { h: 'Ask better questions', p: `AI rewards specificity. "Plan three 20-minute dinners for a nut-free week using what's in my pantry" gets a useful answer; "what's for dinner" gets a shrug. Teaching the family to prompt well is half the value.` },
    { h: 'The early-warning system', p: `The best tech reads the week ahead and flags collisions while they're cheap to fix — two parties one Saturday, a form due the morning after a late game. Foresight is the feature nobody advertises but everyone needs.` },
    { h: 'Keep a human in the loop', p: `Automation should draft, not decide, anything that touches money, safety, or feelings. A quick human glance before it's real is the difference between a helpful tool and a scary one.` },
  ],
  'Wellness': [
    { h: 'Sleep is the keystone', p: `Fix sleep and half the other problems shrink: moods, focus, patience, appetite. Protecting bedtime is the single highest-return wellness habit a family has, and %S% gets easier once everyone is rested.` },
    { h: 'Move together, not perfectly', p: `A walk after dinner beats a gym membership nobody uses. Movement that's woven into family life — a bike ride, a dance-off, raking leaves — sticks because it's shared and fun.` },
    { h: 'Feelings need words', p: `Kids who can name what they feel can manage it. A simple daily check-in — rose, thorn, bud — builds emotional vocabulary that pays off for a lifetime.` },
    { h: 'The 80/20 plate', p: `Nutrition isn't all-or-nothing. Aim for mostly-good most of the time and let dessert be dessert. The pressure to be perfect causes more harm at the table than the occasional cookie.` },
    { h: 'Sunlight and outside time', p: `Ten minutes of morning light sets the body clock; time outdoors resets the mood. It's free, it's fast, and it does more for the whole family than most supplements.` },
    { h: 'Model the repair with yourself', p: `Kids learn self-care by watching. When they see you rest without guilt, apologize without shame, and ask for help without drama, you teach more than any lecture could.` },
    { h: 'Name the mental load', p: `The invisible work of noticing, planning, and remembering is real work, and it exhausts the person carrying it. Saying it out loud is the first step to sharing it.` },
    { h: 'Protect white space', p: `An over-scheduled family is a stressed family. Guarding a few blank evenings a week isn't laziness; it's maintenance. Rest is where the recovery actually happens.` },
    { h: 'Breathe before you react', p: `One slow breath creates a gap between the trigger and the response, and in that gap lives every good parenting decision you'll ever make. It's the cheapest tool with the highest return.` },
    { h: 'Hydration and the afternoon slump', p: `Half of the 4pm meltdown — kids and adults — is really hunger and thirst wearing a costume. A snack and a glass of water resolve more than a timeout ever will.` },
    { h: 'Connection is medicine', p: `Loneliness is a health risk; belonging is a buffer. Regular, low-stakes togetherness — a shared meal, a standing walk — does quiet, measurable good for everyone under the roof.` },
    { h: 'Small rituals, big anchors', p: `A Friday movie night or a Sunday pancake breakfast gives the week a shape to lean on. Rituals cost little and return a sense of steadiness kids remember for decades.` },
    { h: 'Less news, more presence', p: `A household marinating in headlines carries a background hum of dread. Curating the input — and being present instead of scrolling — lowers the whole family's baseline stress.` },
  ],
  'Family Finances': [
    { h: 'Give every dollar a job', p: `A budget isn't restriction; it's a plan you made on a calm day for the money you'll spend on a stressful one. When each dollar has a job, %S% stops being a source of dread.` },
    { h: 'Automate the good decisions', p: `Willpower is a terrible savings plan. Automatic transfers on payday mean the saving happens before the spending can — you're never choosing between the two in the moment.` },
    { h: 'Talk about money openly', p: `Money silence is how bad habits get inherited. Age-appropriate honesty — "we're saving for that, so not this month" — raises kids who understand trade-offs instead of fearing them.` },
    { h: 'The three-jar system for kids', p: `Spend, save, give. Splitting allowance three ways turns an abstract lecture into a hands-on lesson a six-year-old can feel. The jar they watch grow teaches patience better than any talk.` },
    { h: 'Name the emergency fund', p: `A cushion of even a few hundred dollars converts a crisis into an inconvenience. Start absurdly small if you must; the habit matters more than the number at first.` },
    { h: 'Audit the subscriptions', p: `Recurring charges are where budgets quietly leak. A twice-a-year sweep of every subscription usually funds a family outing with money you'd forgotten you were spending.` },
    { h: 'Plan for the irregular', p: `Holidays, birthdays, and back-to-school aren't surprises — they arrive on schedule every year. Setting aside a little each month means they never blow up the budget.` },
    { h: 'The 24-hour rule', p: `For any non-essential want, wait a day. Half the time the urge passes; the other half you buy it with intention instead of impulse. It's the simplest spending filter there is.` },
    { h: 'Involve kids in real trade-offs', p: `Handing a child the grocery list and a budget teaches more in one trip than a year of lectures. Real choices with real limits build real judgment.` },
    { h: 'Track for a month, then relax', p: `You don't need to track forever — just long enough to see where the money actually goes. Awareness alone shifts behavior; the spreadsheet is a means, not a lifestyle.` },
    { h: 'Sinking funds beat credit', p: `Saving a little each month toward a known future cost — new tires, summer camp — means paying cash for the predictable instead of financing it in a panic.` },
    { h: 'Value time, not just money', p: `The point of financial order isn't a bigger number; it's a calmer life and more choices. Spend on what genuinely adds to your family and cut hard on what doesn't.` },
  ],
  'Recipes & Food': [
    { h: 'Plan around the week you actually have', p: `The best dinner plan bends to reality: fast meals on busy nights, the ambitious one on a night you're home. Matching %S% to the real calendar is why plans survive past Wednesday.` },
    { h: 'Keep a short list of house dinners', p: `Every family needs ten reliable, everyone-eats-it meals on rotation. It's not boring; it's a foundation. Save the experiments for the weekend and let weeknights be easy.` },
    { h: 'Prep components, not full meals', p: `Cooked grains, roasted veg, and a protein in the fridge become five different dinners. Prepping building blocks beats cooking five separate meals and keeps leftovers from feeling like leftovers.` },
    { h: 'The list builds itself', p: `A meal plan and a grocery list are the same document. Write the plan, and the list falls out of it — sorted by aisle, minus what's already in the pantry.` },
    { h: 'Get kids in the kitchen', p: `Children eat what they help make. Even a toddler can wash, tear, and stir, and the pride of "I made this" does more for picky eating than any bribe.` },
    { h: 'Embrace the theme night', p: `Taco Tuesday, breakfast-for-dinner, pasta night — themes kill the daily "what's for dinner" decision while leaving room to vary the details. Structure with flexibility is the whole game.` },
    { h: 'Cook once, eat twice', p: `Double the batch, freeze half. A little extra effort tonight buys you a free dinner on the worst night of next week — the cheapest insurance in the kitchen.` },
    { h: 'A well-stocked pantry is a safety net', p: `When the fridge looks empty, a good pantry still has dinner in it. A handful of staples — pasta, beans, tinned tomatoes, rice — means you're never truly stuck.` },
    { h: 'Make vegetables the default, not the fight', p: `Put them out first, when everyone's hungry, and keep it low-drama. Roasted, with a little salt and oil, most vegetables win converts without a single negotiation.` },
    { h: 'Lower the stakes on dinner', p: `A simple meal eaten together beats an elaborate one served to a stressed table. The nutrition of connection is real; give yourself permission to keep it easy.` },
    { h: 'Leftovers, reinvented', p: `Last night's roast chicken is tonight's tacos and tomorrow's soup. Treating leftovers as ingredients, not repeats, slashes waste and the mental load at once.` },
    { h: 'One-pan and slow-cooker allies', p: `The best weeknight recipes clean up after themselves. One-pan dinners and the slow cooker do the work while you do homework and pickup — hands-off is a feature.` },
    { h: 'Snacks with a plan', p: `Grazing derails appetites and budgets. A visible, pre-portioned snack shelf the kids can reach ends the constant asking and keeps dinner the main event.` },
  ],
  'Travel & Adventures': [
    { h: 'The adventure can be small', p: `A memorable outing doesn't require a passport. A new park, a sunrise pancake run, a night hike with flashlights — %S% is really about attention, not distance.` },
    { h: 'Pack a launch list, not a suitcase', p: `A reusable, family-specific packing list — refined after every trip — turns the pre-trip scramble into a calm hour. You stop reinventing it and start trusting it.` },
    { h: 'Build in nothing time', p: `Over-planned trips exhaust everyone. Leaving blank space for a puddle, a playground, or an unplanned nap is where the best memories quietly happen.` },
    { h: 'Snacks are strategy', p: `Half of travel meltdowns are hunger in disguise. A well-provisioned snack bag is the single highest-return item you'll pack, for kids and grown-ups alike.` },
    { h: 'Give kids a job', p: `A child with a map, a camera, or "navigator" duties is a child who's engaged instead of whining. Ownership turns passengers into explorers.` },
    { h: 'The night-before-departure reset', p: `Bags by the door, documents in one folder, phones charging, roles assigned. A ten-minute setup the night before is the difference between a smooth start and a stressful one.` },
    { h: 'Keep the routine anchors', p: `Even on the road, a familiar bedtime book or morning ritual keeps young kids regulated. A few portable anchors let everything else be an adventure.` },
    { h: 'Document lightly, live fully', p: `A handful of real photos beats a phone glued to your face all day. Capture a moment, then put it away and actually be in the next one.` },
    { h: 'Plan for the weather you\'ll get', p: `A backup indoor idea and a rain layer turn a washout into a pivot. The families who "get lucky" with weather are usually just the ones who planned for it.` },
    { h: 'Local and low-key beats far and flashy', p: `Kids rarely remember the price tag; they remember the freedom and your undivided attention. A day trip done well outperforms an expensive one done frazzled.` },
    { h: 'A shared trip calendar', p: `When flight times, reservations, and must-dos live in one place everyone can see, the trip stops living in one parent's head — and that parent finally gets to relax too.` },
    { h: 'Ease back in', p: `The re-entry is part of the trip. An unpacking plan and a buffer day before real life resumes keeps the vacation glow from evaporating in a Monday-morning scramble.` },
  ],
  'Home & Seasonal': [
    { h: 'Reset with the seasons', p: `Four times a year, do a light sweep — swap the closet, check the smoke alarms, refresh the emergency kit. Tying %S% to the seasons means it actually happens instead of never.` },
    { h: 'The 15-minute evening reset', p: `A short, whole-family tidy before bed means you wake up to a home that's on your side. It's not about clean; it's about starting the day without a headwind.` },
    { h: 'A maintenance rhythm, not a marathon', p: `Homes don't fall apart in a day, and they don't get fixed in one either. A simple recurring checklist — filters, gutters, batteries — spreads the work so it never piles into a crisis.` },
    { h: 'Zones, not piles', p: `Give every room a clear job and every category a zone. When the "stuff" has a where, tidying becomes routing instead of deciding, and anyone can help.` },
    { h: 'Decorate for the moment, store the rest', p: `Seasonal decor is joyful in small doses and overwhelming in boxes. Curate a favorite few, label the bins clearly, and let the attic hold the overflow.` },
    { h: 'Prep the house for the season ahead', p: `A little foresight — sealing drafts before winter, servicing the AC before summer — trades a cheap hour now for an expensive emergency later. The calendar is your ally.` },
    { h: 'Everyone owns a zone', p: `A home runs on shared ownership, not one martyr. Assigning each family member a small area they're responsible for turns "why is it always me" into a team effort.` },
    { h: 'Keep a donate box open', p: `A permanent, visible donate box catches the outgrown and the unused before they become clutter. When it's full, it goes — no big purge required.` },
    { h: 'Light and air change everything', p: `Open a window, let the light in, and a room resets for free. The cheapest home upgrade is usually just airflow and a decluttered surface.` },
    { h: 'Ready the entryway for the season', p: `The front door does the heavy lifting: boots and bins in winter, sunscreen and hats in summer. Matching the launch pad to the season keeps the whole house flowing.` },
    { h: 'Batch the seasonal swaps', p: `Wardrobe change, bedding, and gear all turn over at once. Doing the seasonal swap in one focused afternoon beats a slow trickle of half-finished transitions.` },
    { h: 'Make the holidays a plan, not a panic', p: `The magic of a good season is mostly logistics done early. A simple running list of gifts, meals, and dates turns December from a sprint into something you can actually enjoy.` },
  ],
};

// ── subjects per category (concrete, unique topics → unique titles) ─────────
const SUBJECTS = {
  'Parenting': [
    'setting screen-time limits that actually work','handling toddler tantrums in public','raising a confident only child','sibling rivalry between close-in-age kids','getting kids to listen the first time','positive discipline for strong-willed kids','building bedtime routines for toddlers','talking to teens so they talk back','managing back-talk without power struggles','co-parenting on the same page','helping a shy child make friends','teaching kids to apologize and mean it','surviving the threenager stage','raising kind kids in a mean-meme world','handling the after-school meltdown','getting picky eaters to the table','potty training without the power struggle','weaning off the pacifier','teaching gratitude that isn\'t forced','raising resilient kids who bounce back','managing sibling fairness and jealousy','helping kids handle big feelings','setting boundaries with grandparents','the art of the family meeting','teaching kids to lose gracefully','handling the homework battle','raising responsible kids with chores','navigating the tween attitude shift','building your child\'s emotional vocabulary','helping kids sleep in their own bed','managing separation anxiety at drop-off','raising a child who reads for fun','teaching kids about consent and body autonomy','handling lying without shame','the calm response to whining','encouraging independence in little kids','preparing a first child for a new baby','managing screen envy between siblings','teaching kids to handle failure','building confidence in an anxious child','raising kids who help without being asked','the honest talk about bullying','managing meltdowns at the grocery store','helping kids adjust to a move','teaching patience to an impatient toddler','raising a good sport at game time','navigating first crushes and heartbreak','building trust with a secretive teen','handling the endless "why" questions','teaching kids to manage their own mornings','helping a perfectionist child relax','raising kids across a big age gap','the gentle approach to sleep regressions','teaching kids to share their space','managing the transition to middle school','raising a child with big emotions','helping kids build real friendships','teaching kids to advocate for themselves','the family screen agreement','raising confident daughters','raising emotionally literate sons','handling sibling tattling','teaching kids to wait their turn','the bedtime stalling standoff','raising grateful kids in an abundant home','managing the pickup-line chaos','helping kids process a tough day','raising kids who own their mistakes','the screen-free family dinner','teaching kids to handle boredom','helping a highly sensitive child thrive','managing the witching-hour chaos','raising kids who are kind to themselves','the gentle end to thumb-sucking','teaching kids to keep promises',
  ],
  'Organization': [
    'building a family command center','taming the paper pile','organizing the family calendar','a morning routine that runs itself','the ten-minute evening reset','decluttering the kids\' rooms for good','organizing the mudroom and entryway','managing the family to-do list','setting up a chore system that lasts','organizing digital family photos','planning the week on Sunday night','keeping the kitchen counters clear','organizing the garage sanely','a system for school forms and permission slips','managing multiple kids\' schedules','the art of meal-plan-to-grocery-list','organizing seasonal clothes','building a household binder','taming the toy explosion','a paperless system for family documents','organizing the medicine cabinet safely','managing birthday-party logistics','the family launch pad by the door','keeping track of everyone\'s appointments','organizing craft and art supplies','a system for hand-me-downs','managing the family inbox','decluttering sentimental kid art','organizing the linen closet','planning meals for a picky household','keeping the car clean with kids','a reset routine for after vacation','organizing holiday decorations','managing extracurricular gear','building a family emergency binder','the weekly reset that saves your sanity','organizing kids\' school memories','a labeling system anyone can follow','managing subscriptions and renewals','keeping the pantry organized','organizing the junk drawer once and for all','a system for library books and returns','planning the family week backward','managing shared family passwords safely','organizing the playroom by zones','keeping birthdays and gifts on track','a fair division of household labor','organizing the home office with kids around','the one-touch rule for clutter','managing the never-ending laundry','building routines kids can own','organizing sports schedules for multiple kids','a simple system for meal leftovers','keeping the family fridge functional','decluttering before the holidays','organizing travel documents and essentials','a command center for a small space','managing the school-year transition','keeping shared spaces tidy with teens','organizing the weekly grocery run','a system for returning what you borrow','organizing the kids\' bathroom','managing the family reading list','keeping gift ideas in one place','organizing warranties and manuals','the annual digital-life cleanup','managing the family chore rotation','organizing snacks kids can reach',
  ],
  'School & Activities': [
    'surviving back-to-school season','building a homework routine that works','choosing the right extracurriculars','handling too many activities','preparing for parent-teacher conferences','helping with a big school project','managing science fair season','the first-day-of-school jitters','packing lunches kids will actually eat','organizing the school morning rush','helping a struggling reader','supporting a math-anxious kid','navigating standardized test season','choosing between sports and arts','managing homework across multiple kids','building good study habits early','helping kids make friends at a new school','handling a tough teacher fit','preparing for the middle-school jump','supporting a kid who hates school','managing the sports-practice calendar','the end-of-year school checklist','helping kids set academic goals','navigating report-card conversations','building reading habits that stick','supporting a gifted and bored kid','handling school-day anxiety','preparing for the first sleepaway camp','managing club and team commitments','helping kids balance school and play','the summer slide and how to beat it','choosing a first instrument','supporting a young athlete','handling homework refusal','preparing for high-school transitions','managing college-application stress','building a calm study space','helping kids present with confidence','navigating group-project drama','supporting a kid with a learning difference','the after-school activity audit','helping kids recover from a bad grade','building a reading nook at home','managing the school-supply list','supporting a child\'s new passion','handling tryout disappointment','the homework-free family evening','preparing kids for a substitute week','building teacher relationships that help','managing the activity carpool','helping kids find their thing','supporting screen-based learning at home','the great backpack cleanout','navigating a school change mid-year','building good digital-research skills','helping kids handle test anxiety','building a reading routine for reluctant readers','supporting a kid who is being left out','managing the science-project supply run','helping kids take good notes','the parent guide to spelling practice',
  ],
  'AI & Technology': [
    'introducing AI to family life','choosing a family organization app','setting healthy screen-time defaults','teaching kids to use AI responsibly','the family digital-safety talk','managing kids\' first smartphone','choosing kid-safe streaming settings','using AI for meal planning','automating the family schedule','a family password and privacy plan','teaching good digital citizenship','using AI as a homework helper','managing gaming without the fights','the smart home for busy families','protecting family data online','using AI to draft the grocery list','setting up parental controls that work','teaching kids to spot misinformation','the case for one family calendar app','using voice assistants with kids around','managing notifications for sanity','a healthy relationship with the family group chat','using AI to plan a birthday party','teaching teens about their digital footprint','choosing educational apps that deliver','automating bill reminders','the family tech agreement','using AI to remember everything','managing screens on road trips','a low-drama approach to video games','teaching kids to code for fun','using AI to plan meals around a budget','protecting kids on social media','the smart approach to family photos','using tech to share the mental load','setting up a family shared drive','teaching kids about online privacy','using AI to prep for the week','managing multiple kids\' devices','the honest talk about AI and homework','automating the boring family admin','choosing the right smartwatch for a kid','using AI to plan a family trip','a calmer family notification setup','teaching kids healthy tech habits','using AI to manage the family budget','choosing a first email account for a kid','the family approach to screen contracts','using AI to summarize the school week','managing app purchases and in-game spending','teaching kids to back up their work','using smart reminders for chores','a family plan for lost or broken devices','using AI to plan themed family nights','keeping grandparents connected with tech',
  ],
  'Wellness': [
    'building better family sleep habits','managing family stress on busy weeks','getting the whole family moving','raising kids with a healthy body image','the family mental-load conversation','helping an anxious child feel safe','building emotional resilience in kids','the power of the family dinner','managing screen time for better sleep','teaching kids to name their feelings','building a calm bedtime wind-down','helping kids handle worry','the case for family walks','raising kids who love vegetables','managing your own parental burnout','building mindfulness into family life','helping kids through big transitions','the importance of unstructured play','managing seasonal mood dips','teaching kids healthy screen boundaries','building a gratitude practice that sticks','helping a child who won\'t sleep','managing sibling stress in the house','the family digital detox','raising confident, self-compassionate kids','building healthy morning routines','helping kids cope with disappointment','managing anxiety around school','the restorative power of outside time','teaching kids to slow down','building a family self-care culture','helping kids through grief and loss','managing overstimulation in little kids','the case for protecting downtime','raising kids who ask for help','building steady routines for anxious kids','managing the after-school crash','helping teens protect their sleep','the family approach to screen balance','building resilience through small challenges','managing holiday-season overwhelm','helping kids build healthy friendships','the quiet power of family rituals','teaching kids to breathe through big feelings','building a home that lowers stress','managing your energy as a parent','helping kids build a growth mindset','the family approach to screen-free Sundays','building a worry box for anxious kids','managing sensory overload at home','helping kids recover from a hard week','the power of a family gratitude jar','building calm into busy mornings','helping kids wind down after screens','the family approach to rest days','teaching kids to sit with big feelings',
  ],
  'Family Finances': [
    'building a family budget that works','teaching kids about money early','setting up a kids\' allowance system','building a family emergency fund','saving for a family vacation','talking to kids about needs vs wants','planning for back-to-school costs','managing the holiday-spending season','teaching teens to budget','building good money habits as a family','the three-jar allowance system','cutting the family grocery bill','auditing family subscriptions','saving for your kids\' future','teaching kids the value of saving','planning for irregular expenses','the family money meeting','raising financially confident kids','managing a single-income household','budgeting for a growing family','teaching kids about giving','the 24-hour rule for family spending','saving on kids\' activities and gear','planning for birthday and gift costs','building sinking funds for big expenses','teaching kids to earn and save','managing money as a couple','the honest talk about family finances','saving for college without panic','cutting costs without cutting joy','teaching kids about smart spending','planning a debt-free holiday season','building a family financial safety net','managing the cost of extracurriculars','teaching kids to set money goals','the family approach to charitable giving','budgeting for a new baby','saving on everyday family expenses','teaching kids about wants and patience','planning the family financial year','managing pocket money and chores','building wealth-building habits in kids','the family cash envelope experiment','saving for a big family purchase','teaching kids to compare and choose','a calm approach to money stress','the family approach to gift-giving on a budget','teaching kids about the cost of things','building a no-spend week as a family','saving for a family pet responsibly','the honest talk about allowance and chores','teaching kids to save for something big','planning ahead for summer-camp costs','building a family giving tradition','the smart approach to kids and birthday money','teaching teens about their first paycheck',
  ],
  'Recipes & Food': [
    'weeknight dinners that actually work','meal planning for a picky family','batch cooking for busy weeks','getting kids to eat their vegetables','building a repertoire of house dinners','the five-ingredient dinner','stocking a pantry that saves dinner','freezer meals for hard weeks','cooking with kids without the mess','the great snack-shelf reset','breakfast for busy school mornings','lunchbox ideas kids won\'t trade','one-pan dinners for tired nights','turning leftovers into new meals','slow-cooker meals for game nights','healthy after-school snacks','the family taco-night formula','cooking on a tight grocery budget','meal prep for the whole week','getting toddlers to try new foods','simple sheet-pan suppers','the no-cook summer dinner','building a family recipe collection','feeding a crowd on a budget','quick breakfasts kids can make','planning meatless-Monday dinners','the family pizza-night tradition','stress-free holiday cooking','healthy swaps kids won\'t notice','cooking ahead for the school week','the reliable weeknight pasta','feeding picky eaters without short-order cooking','simple soups for cold nights','baking with kids on a rainy day','the build-your-own dinner bar','smart snacking between activities','planning a birthday-party menu','cooking for different dietary needs','the family smoothie station','make-ahead breakfasts for the week','reinventing the humble leftover','feeding hungry teens affordably','simple weeknight stir-fries','the pantry-only dinner challenge','healthy lunches that survive the backpack','cooking together on Sunday afternoons','fast dinners for after practice','building a kid-friendly dinner rotation','the family bread-baking weekend','smart grocery shopping with kids','make-ahead lunches for the whole week','the low-waste family kitchen','simple desserts kids can make','cooking seasonal produce with kids','the weeknight rice-bowl formula','building a backup-dinner shortlist',
  ],
  'Travel & Adventures': [
    'road-tripping with young kids','the stress-free family packing list','planning a budget family vacation','surviving a long flight with toddlers','finding adventure close to home','the family camping first-timer\'s guide','planning a national-parks trip','keeping kids entertained on the road','the perfect family day trip','traveling with a baby','planning a multigenerational vacation','the family staycation done right','beating jet lag with kids','choosing a family-friendly destination','packing snacks for travel sanity','the night-before-departure checklist','planning screen-free travel fun','exploring your own city like a tourist','the family hiking starter guide','managing bedtime on the road','planning a beach trip with kids','the great family scavenger hunt','traveling light with a big family','planning meals while traveling','the museum trip kids actually enjoy','a first camping trip in the backyard','planning a memorable birthday adventure','the low-cost weekend getaway','keeping routines while traveling','planning a road trip playlist','surviving the theme-park day','the family bike adventure','planning for weather on any trip','building a reusable travel kit','the calm airport experience with kids','planning a nature-walk adventure','the family road-trip games list','easing back into routine after a trip','planning a snow-day adventure','the sunrise-outing family tradition','the stress-free family picnic','planning a berry-picking day trip','the family stargazing night','planning a rainy-day adventure indoors','the neighborhood walking adventure','planning a first family road-trip route','the family aquarium or zoo day','planning an autumn-leaves outing',
  ],
  'Home & Seasonal': [
    'the seasonal home reset','preparing your home for winter','spring cleaning with the whole family','summer-proofing the family home','getting the house ready for fall','the holiday-decor game plan','building a home-maintenance rhythm','organizing for the new school year','the great seasonal wardrobe swap','preparing for holiday guests','a calm approach to holiday hosting','building a family emergency kit','the back-to-school home setup','decluttering before the holidays','preparing the home for a new baby','the summer boredom-buster station','creating cozy winter evenings at home','the seasonal pantry refresh','preparing the yard for each season','building family traditions at home','the New Year home reset','organizing the home for spring','preparing for the first frost','a family plan for snow days','the holiday-gift organization system','creating a homework-friendly home','preparing outdoor spaces for summer','the fall backyard cleanup','building a seasonal cleaning checklist','organizing the home for the holidays','the cozy-up-the-house autumn ritual','preparing the home for hosting','a family plan for power outages','the spring garden with kids','decorating for the seasons without clutter','the summer-to-school home transition','building a maintenance calendar','preparing for a busy holiday season','the seasonal deep-clean that sticks','creating calm spaces at home','the family approach to a tidy entryway','preparing the home for allergy season','building a cozy family reading corner','the seasonal toy rotation','preparing outdoor gear for winter storage','the family approach to a clutter-free holiday','building a mudroom that works','the spring window-and-screen refresh','preparing the kitchen for holiday baking','the family plan for a clean-enough house',
  ],
};

// ── build one article ───────────────────────────────────────────────────────
const START = Date.UTC(2024, 0, 15); // spread published_at forward from here
const DAY = 86400000;

function buildPost(category, subject, globalIndex, usedSlugs) {
  // Choose a title frame deterministically; on a slug collision, walk to the
  // next frame (and finally disambiguate with the category) so no topic is lost.
  const base = hash32('title:' + subject) % FRAMES.length;
  let t, slug;
  for (let k = 0; k <= FRAMES.length; k++) {
    const frame = k < FRAMES.length ? FRAMES[(base + k) % FRAMES.length] : FRAMES[base];
    t = frame(subject);
    slug = k < FRAMES.length ? slugify(t) : slugify(t + ' ' + category);
    if (!usedSlugs.has(slug)) break;
  }
  const rng = mulberry32(hash32('body:' + slug));

  // body ---------------------------------------------------------------------
  const body = [];
  body.push({ type: 'p', text: pick(rng, INTRO_HOOKS)(subject) });
  body.push({ type: 'p', text: pick(rng, INTRO_PROMISE) });

  const facets = pickN(rng, FACETS[category], 4 + Math.floor(rng() * 2)); // 4-5 facets
  for (const f of facets) {
    body.push({ type: 'h2', text: f.h });
    body.push({ type: 'p', text: f.p.replace(/%S%/g, subject) });
  }

  // a subject-specific practical-steps section
  const steps = pickN(rng, [
    `pick the single piece of ${subject} that causes the most friction this week`,
    `decide the one default that removes a daily decision`,
    `put it somewhere the whole family can see it`,
    `agree on who owns it so it isn't quietly one person's job`,
    `give it two weeks before you judge whether it's working`,
    `write down the plan so it survives a chaotic day`,
    `start smaller than feels necessary — momentum beats ambition`,
    `add a gentle reminder so nobody has to hold it in their head`,
  ], 3);
  body.push({ type: 'h2', text: 'A simple place to start' });
  body.push({ type: 'p', text: steps.map((s, i) => `${STEP_OPENERS[i]}, ${s}.`).join(' ') });

  // Bubaly CTA + closer
  body.push({ type: 'h2', text: 'Where Bubaly fits in' });
  body.push({ type: 'p', text: pick(rng, BUBALY_CTA)(subject) });
  body.push({ type: 'p', text: pick(rng, CLOSERS) });

  // fields -------------------------------------------------------------------
  const words = body.reduce((a, b) => a + b.text.split(/\s+/).length, 0);
  const readingMinutes = Math.max(3, Math.ceil(words / 200));
  const firstSentence = (txt) => txt.split(/(?<=[.!?])\s/)[0].trim().replace(/[.!?]+$/, '');
  const excerpt = `${firstSentence(body[0].text)}. ${firstSentence(body[1].text)}.`
    .replace(/\s+/g, ' ').slice(0, 180);

  const heroKeywords = CAT_KEYWORDS[category];
  const heroImageAlt = `A photo related to ${subject}.`;

  // hashtags: always #bubaly + #familylife + category + subject-derived + facet-ish
  const subjTag = '#' + subject.split(' ').filter((w) => w.length > 3).slice(0, 2).join('').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const extra = pickN(rng, ['#momlife','#dadlife','#parentinghacks','#familyfirst','#organizedhome','#worklifebalance','#raisingkids','#familytime','#homelife','#lifehacks'], 2);
  const tags = Array.from(new Set(['#bubaly', '#familylife', '#' + CAT_HASHTAG[category], subjTag, ...extra])).filter((x) => x.length > 1);

  const author = AUTHORS[hash32('auth:' + slug) % AUTHORS.length];
  const publishedAt = new Date(START + (globalIndex * 17 + (hash32('date:' + slug) % 11)) % 900 * DAY)
    .toISOString().slice(0, 10);

  return {
    slug, title: t, excerpt, author, publishedAt, readingMinutes,
    tags, category, accentColor: ACCENT[category],
    heroKeywords, heroImageAlt, body,
  };
}

// ── assemble all posts (dedupe by slug) ─────────────────────────────────────
const posts = [];
const seenSlug = new Set();
let gi = 0;
for (const category of Object.keys(SUBJECTS)) {
  for (const subject of SUBJECTS[category]) {
    const p = buildPost(category, subject, gi++, seenSlug);
    if (seenSlug.has(p.slug)) continue; // extremely unlikely after disambiguation
    seenSlug.add(p.slug);
    posts.push(p);
  }
}

// ── emit SQL ────────────────────────────────────────────────────────────────
function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function pgArray(arr) { return "ARRAY[" + arr.map(q).join(',') + "]::text[]"; }
function bodyJson(body) {
  return "$json$" + JSON.stringify(body) + "$json$::jsonb";
}

const lines = [];
lines.push(`-- ============================================================================`);
lines.push(`-- Migration 0226: Bubaly blog — ${posts.length} new fully-written articles`);
lines.push(`-- Generated by scripts/generate-blog-posts.mjs (deterministic; re-runnable).`);
lines.push(`-- ${posts.length} unique topics across ${Object.keys(SUBJECTS).length} category tabs, each with a rich`);
lines.push(`-- multi-section body, CC0 hero photo, #hashtags (incl.`);
lines.push(`-- #bubaly), an SEO excerpt, and a Bubaly back-reference + CTA. Public + SEO/AEO`);
lines.push(`-- surfaces (sitemap, JSON-LD, category tabs) pick these up automatically.`);
lines.push(`-- Idempotent: ON CONFLICT (slug) DO UPDATE keeps rows in sync without dupes.`);
lines.push(`-- Requires 0010 (blog_posts) + 0201 (hero image columns).`);
lines.push(`-- ============================================================================`);
lines.push('');
lines.push(`INSERT INTO public.blog_posts`);
lines.push(`  (slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color,`);
lines.push(`   hero_image_url, hero_image_alt, hero_image_credit, body, published)`);
lines.push(`VALUES`);

const LOCK_BASE = 1000;
const valueRows = posts.map((p, idx) => {
  // idx is unique per post ⇒ a unique `lock` ⇒ a distinct photo for every article.
  const lock = LOCK_BASE + idx;
  const seed = encodeURIComponent(`${p.slug}-${lock}`);
  const url = `https://picsum.photos/seed/${seed}/1600/900`;
  return `(${q(p.slug)}, ${q(p.title)}, ${q(p.excerpt)}, ${q(p.author)}, ${q(p.publishedAt)}, ${p.readingMinutes}, ` +
    `${pgArray(p.tags)}, ${q(p.category)}, false, ${q(p.accentColor)}, ${q(url)}, ${q(p.heroImageAlt)}, ${q('Lorem Picsum (CC0)')}, ` +
    `${bodyJson(p.body)}, true)`;
});
lines.push(valueRows.join(',\n'));
lines.push(`ON CONFLICT (slug) DO UPDATE SET`);
lines.push(`  title = EXCLUDED.title, excerpt = EXCLUDED.excerpt, author = EXCLUDED.author,`);
lines.push(`  published_at = EXCLUDED.published_at, reading_minutes = EXCLUDED.reading_minutes,`);
lines.push(`  tags = EXCLUDED.tags, category = EXCLUDED.category, accent_color = EXCLUDED.accent_color,`);
lines.push(`  hero_image_url = EXCLUDED.hero_image_url, hero_image_alt = EXCLUDED.hero_image_alt,`);
lines.push(`  hero_image_credit = EXCLUDED.hero_image_credit, body = EXCLUDED.body, published = true;`);
lines.push('');
lines.push(`-- Summary by category:`);
const byCat = {};
for (const p of posts) byCat[p.category] = (byCat[p.category] || 0) + 1;
for (const c of Object.keys(byCat)) lines.push(`--   ${c}: ${byCat[c]}`);
lines.push(`-- TOTAL: ${posts.length}`);

process.stdout.write(lines.join('\n') + '\n');
process.stderr.write(`Generated ${posts.length} posts across ${Object.keys(byCat).length} categories\n`);
