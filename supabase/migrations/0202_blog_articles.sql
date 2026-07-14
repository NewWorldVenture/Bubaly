-- ============================================================================
-- Migration 0202: The blog, fully written — 20 complete articles with photos
-- Every cover-story stub becomes a real, fun, fully-fleshed article, and new
-- articles round out coverage: 3–4 per category across Parenting, Organization,
-- School & Activities, AI & Technology, Wellness, and Family Finances.
-- Hero photos are free-license Unsplash CDN images (hotlinking is supported by
-- Unsplash; each URL verified live), topic-matched to the story.
-- Idempotent: INSERT ... ON CONFLICT (slug) DO UPDATE upgrades the 9 existing
-- stub rows in place and inserts the 11 new ones. Requires 0201 (image columns).
-- ============================================================================

INSERT INTO public.blog_posts
  (slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color,
   hero_image_url, hero_image_alt, hero_image_credit, body, published)
VALUES

-- ═══ AI & TECHNOLOGY ═════════════════════════════════════════════════════════
(
  'an-ai-chief-of-staff-for-your-home',
  'The AI Family Assistant: A New Way to Stay Ahead of Everything',
  'Chatbots answer questions. A chief of staff gets things done. Here''s what happens when your household finally gets one.',
  'Jessica Miller', '2026-07-10', 7, ARRAY['ai','product','mental load'], 'AI & Technology', true, '#7c5dff',
  'https://images.unsplash.com/photo-1584697964358-3e14ca57658b?auto=format&fit=crop&w=1600&q=80',
  'A parent raising her arms in triumph at a tidy desk — on top of everything for once',
  'Unsplash',
  $json$[
    {"type":"p","text":"Somewhere around the third permission slip of the week, most parents have the same thought: I am running a small company, and nobody hired a staff. There's a CEO (you), a CFO (also you), a head of logistics (you again), and a customer-success team (you, at 2 a.m., searching for a lost stuffed rabbit)."},
    {"type":"p","text":"Chatbots were supposed to help. And they do — if what you needed was a very confident paragraph. Ask a chatbot to 'add soccer every Tuesday' and you get advice about adding soccer every Tuesday. What you actually needed was for soccer to BE on the calendar. That distinction — words versus records — is the whole idea behind an AI chief of staff for your home."},
    {"type":"h2","text":"From words to records"},
    {"type":"p","text":"A chief of staff doesn't hand the CEO an essay. They quietly restructure the week. The same standard should apply at home: when you say 'Emma has a dentist appointment Thursday at 3', the right response is not a summary of dental hygiene. It's a calendar event, a reminder the night before, a note that Thursday's carpool needs cover, and — if it's feeling ambitious — a heads-up that the dentist is next door to the dry cleaner where your jacket has been living since March."},
    {"type":"p","text":"Every request should end in a record: an event, a list item, a reminder, a paid bill. If nothing in your family's system changed, nothing actually happened."},
    {"type":"h2","text":"The proactive front door"},
    {"type":"p","text":"The second difference is direction. You have to go to a chatbot. A chief of staff comes to you: three things need a decision, two things were handled while you slept, one thing will become a problem on Friday unless someone acts by Wednesday. That morning triage — decide, delegated, deadline — takes ninety seconds and replaces the low hum of am-I-forgetting-something that parents carry around like a phone on 4%."},
    {"type":"h2","text":"Trust is a dial, not a switch"},
    {"type":"p","text":"Nobody should hand their household to an algorithm on day one. The sane model is an approval loop: the assistant proposes, you tap yes or no, and over time it earns autonomy on the boring stuff. Reordering the dish soap? Auto-approved. Rescheduling grandma's birthday dinner? That will always be a human decision, and any system that thinks otherwise should be unplugged with prejudice."},
    {"type":"h2","text":"What it feels like after a month"},
    {"type":"p","text":"The strange part isn't the time you save, although the average family coordination load — researchers put it north of ten hours a week — drops noticeably. The strange part is the quiet. The 9 p.m. couch conversation stops being a logistics stand-up and goes back to being a conversation. You stop being the family's single point of failure, because the system remembers so you don't have to."},
    {"type":"p","text":"You'll still forget things. You're human; that's your best feature. But now, something's got your back — and it never sleeps, never sighs, and never asks who's supposed to bring the orange slices."}
  ]$json$::jsonb, true
),
(
  'ai-family-life',
  '5 Ways AI Can Make Family Life So Much Easier',
  'From meal planning to homework triage, AI is quietly becoming the most useful appliance in the house — no counter space required.',
  'The Bubaly Team', '2026-03-04', 6, ARRAY['ai','practical'], 'AI & Technology', false, '#7c5dff',
  'https://images.unsplash.com/photo-1476703993599-0035a21b17a9?auto=format&fit=crop&w=1600&q=80',
  'A mother on the couch with her two young children, sharing a tablet together',
  'Unsplash',
  $json$[
    {"type":"p","text":"Forget the robot butler. The way AI actually shows up in family life is smaller, quieter, and much more useful: it's the thing that turns 'what's for dinner?' from a nightly crisis into a solved problem. Here are five places it genuinely earns its keep."},
    {"type":"h2","text":"1. Meal planning that plans around YOUR week"},
    {"type":"p","text":"Any app can suggest recipes. The useful trick is suggesting Tuesday-speed recipes on Tuesday — because it can see that Tuesday has soccer until 6 — and saving the ambitious braise for Sunday. Bonus: the grocery list writes itself from the plan, sorted by aisle, minus the things already in your pantry."},
    {"type":"h2","text":"2. The school-email translator"},
    {"type":"p","text":"School newsletters are 400 words of warm community spirit wrapped around two actionable facts. AI is extremely good at finding those two facts — picture day is Thursday, the field trip form is due Friday — and turning them into a reminder and a calendar event before you've finished your coffee."},
    {"type":"h2","text":"3. Homework help that doesn't do the homework"},
    {"type":"p","text":"The good setup isn't 'write my essay.' It's 'quiz me on chapter 7', 'explain photosynthesis like I'm nine', and 'check my reasoning without giving me the answer.' Used that way, AI is the world's most patient study partner — one who never says 'we JUST went over this.'"},
    {"type":"h2","text":"4. The memory you wish you had"},
    {"type":"p","text":"Shoe sizes. The pediatrician's phone number. Which kid is allergic to what, and which cousin already got a birthday card this year. None of it is hard; there's just an enormous amount of it. A family knowledge base that answers questions in plain language is worth more than any single feature — it's the end of asking your partner a question they also don't know the answer to."},
    {"type":"h2","text":"5. The early-warning system"},
    {"type":"p","text":"The best one: AI that reads the week ahead and flags collisions while they're still cheap to fix. Two birthday parties, one Saturday. A permission slip due the morning after a late game. Rain forecast for the day of the car wash fundraiser. Ten minutes of foresight on Sunday beats an hour of scrambling on Thursday."},
    {"type":"p","text":"None of this is science fiction. It's mostly just paying attention — at a scale and consistency no tired human can match. Let the machine hold the details, so you can hold the kid."}
  ]$json$::jsonb, true
),
(
  'ai-homework-helper-not-a-cheat-code',
  'AI and Homework: Helper, Not Cheat Code',
  'Your kid is going to use AI for schoolwork. The only question is whether they learn anything on the way. A house policy that works.',
  'Sam Rivera', '2026-05-27', 6, ARRAY['ai','school','homework'], 'AI & Technology', false, '#7c5dff',
  'https://images.unsplash.com/photo-1531482615713-2afd69097998?auto=format&fit=crop&w=1600&q=80',
  'A mentor sitting beside a student at a computer, working through a problem together',
  'Unsplash',
  $json$[
    {"type":"p","text":"Let's start with the uncomfortable truth: your kid already knows AI can do their homework. Their friends know. The kid who sits behind them in math knows. Pretending otherwise is like pretending calculators don't exist and hoping nobody checks their backpack."},
    {"type":"p","text":"So the family policy can't be 'never.' It has to be smarter than that — because the difference between AI-as-tutor and AI-as-ghostwriter is the difference between learning and laundering."},
    {"type":"h2","text":"The one-question test"},
    {"type":"p","text":"Here's the rule we suggest taping to the fridge: after using AI, could you redo the work without it? If yes, it was a tutor. If no, it was a vending machine for answers, and the only thing purchased was a future problem — usually scheduled to arrive during a test, when the vending machine stays home."},
    {"type":"h2","text":"Green-light uses"},
    {"type":"p","text":"Explain it differently. A kid who didn't get fractions from the textbook might get them from a pizza analogy, then a money analogy, then a Lego analogy — instantly, without anyone getting frustrated. That patience is AI's superpower. Quiz me. Turning notes into practice questions is one of the most evidence-backed study methods there is. Check my work. Getting feedback on a draft — 'what's unclear? where is my argument weak?' — is exactly what good teachers do, and there's never enough teacher to go around."},
    {"type":"h2","text":"Red-light uses"},
    {"type":"p","text":"Write it for me. Solve it and I'll copy it down. Summarize the book I was supposed to read. Every one of these produces homework and prevents learning — a magic trick where the thing that disappears is the point."},
    {"type":"h2","text":"Make it visible, not forbidden"},
    {"type":"p","text":"The families this goes well for treat AI use like driving: supervised first, then licensed. Younger kids use it at the kitchen table, out loud — 'let's ask it to explain this again, differently.' Older kids earn solo use by showing their process. Forbidding it entirely just moves it to a friend's phone, where nobody is teaching judgment."},
    {"type":"p","text":"The goal was never to keep AI away from your kids. It's to raise kids who use it the way they'd use any power tool — with respect, skill, and both hands on the work."}
  ]$json$::jsonb, true
),

-- ═══ ORGANIZATION ════════════════════════════════════════════════════════════
(
  'sync-family-schedule',
  'How to Sync Your Family''s Schedule (Without the Chaos)',
  'One calendar, one weekly ritual, one rule about who owns what. A practical guide to getting five people to the right place, fed.',
  'The Bubaly Team', '2026-04-29', 6, ARRAY['organization','calendar'], 'Organization', false, '#3b82f6',
  'https://images.unsplash.com/photo-1506784983877-45594efa4cbe?auto=format&fit=crop&w=1600&q=80',
  'A weekly planner open on a desk beside a cup of coffee',
  'Unsplash',
  $json$[
    {"type":"p","text":"Every household runs on a hidden layer of coordination. When it works, nobody notices. When it fails, a seven-year-old is standing outside a locked dance studio and two adults are texting each other screenshots of the same email with increasing punctuation."},
    {"type":"p","text":"The fix is not trying harder. The fix is a system boring enough to survive your worst week. Here it is, in three rules."},
    {"type":"h2","text":"Rule 1: One calendar or it didn't happen"},
    {"type":"p","text":"The moment your family has two calendars, you have zero calendars — you have two competing rumors about the future. Pick one shared family calendar and make it law: if an event isn't on it, the event does not exist. This sounds harsh until the first time someone says 'but I told you about it' and the answer is simply: the calendar disagrees. No argument, no scorekeeping. The calendar is the referee, and referees don't care who's tired."},
    {"type":"h2","text":"Rule 2: Every event has exactly one owner"},
    {"type":"p","text":"Shared responsibility is how things fall through cracks — 'I thought YOU were taking her' is the official anthem of family scheduling. Every event gets one name attached: the person who makes it happen. Ownership can trade ('swap you Thursday pickup for Saturday's party run'), but it can never be vacant. Color-code by person and the week becomes legible at a glance — including the glance that says one parent's color is doing 80% of the driving. That's not a calendar problem, but the calendar will make you have the conversation."},
    {"type":"h2","text":"Rule 3: The fifteen-minute Sunday summit"},
    {"type":"p","text":"Once a week, everyone looks at the same week together. Coffee helps. The agenda never changes: What's coming? What conflicts? Who's stretched? Kids old enough to have activities are old enough to attend — a ten-year-old who hears the logistics of their own hobbies starts volunteering information ('oh, coach moved practice') instead of deploying it as a surprise weapon at bedtime."},
    {"type":"h2","text":"Let the machine do the nagging"},
    {"type":"p","text":"Reminders are the one job you should fully delegate to software: the night-before nudge, the leave-now-for-pickup alert, the recurring skeleton of practices and lessons. Humans are terrible at remembering at the right moment and excellent at resenting whoever reminds them. Software doesn't mind being the nag. Let it."},
    {"type":"p","text":"None of this is glamorous. That's the point. A synced family schedule isn't a productivity flex — it's the infrastructure under a calmer house, where the argument about Thursday simply never starts."}
  ]$json$::jsonb, true
),
(
  'meal-planning-that-actually-sticks',
  'Meal Planning That Actually Sticks',
  'Most meal plans die by Wednesday. Here''s the lazy, durable version: theme nights, a self-writing grocery list, and zero guilt.',
  'Maya Chen', '2026-05-20', 5, ARRAY['meals','routines','groceries'], 'Organization', false, '#3b82f6',
  'https://images.unsplash.com/photo-1606787366850-de6330128bfc?auto=format&fit=crop&w=1600&q=80',
  'A colorful overhead spread of fresh food on a table',
  'Unsplash',
  $json$[
    {"type":"p","text":"Meal planning systems fail for one reason: they're designed by the Sunday version of you — optimistic, well-rested, briefly convinced the family will enjoy a lentil week. Then Wednesday-you meets reality at 5:45 p.m. with one hungry kid hanging off the cart and no memory of why there's fennel in the fridge."},
    {"type":"p","text":"The durable system is built for Wednesday-you. It has three parts."},
    {"type":"h2","text":"Theme nights: decide once, coast forever"},
    {"type":"p","text":"Monday: pasta. Tuesday: tacos. Wednesday: soup or sandwiches. Thursday: stir-fry. Friday: pizza. Saturday: new experiment. Sunday: the big cook. You're not choosing WHAT to eat each day anymore — you're choosing WHICH taco. That's a much smaller decision, and small decisions survive bad days. Kids, who claim to crave novelty, secretly love it: taco Tuesday is a tiny holiday that arrives every single week."},
    {"type":"h2","text":"The list that writes itself"},
    {"type":"p","text":"The grocery list should be a byproduct of the plan, not a second chore. Pick the week's meals, and the ingredients land on the list automatically — grouped by aisle, deduplicated, minus what the pantry already holds. The best version learns your staples: it knows you buy milk and bananas every single week and stops making you say so. Ten years of remembering to write down milk is a hundred hours of your life. Take them back."},
    {"type":"h2","text":"Plan five, not seven"},
    {"type":"p","text":"Here's the guilt-removal clause: never plan all seven nights. Life eats one dinner a week — a birthday party, a late practice, a day that simply defeats you — and leftovers deserve the other. A five-night plan that survives IS a perfect week. A seven-night plan that collapses feels like failure, and feelings are why systems get abandoned."},
    {"type":"h2","text":"Let the family vote"},
    {"type":"p","text":"Once a week, let everyone nominate and vote on the experiment night. The data will humble you (your signature dish polling below buttered noodles) but participation buys buy-in: a kid who voted for the meal has a harder time filing a complaint about it. Democracy: it works, even at dinner."},
    {"type":"p","text":"That's the whole system. No macros, no mason jars, no reinvention of your palate. Just fewer decisions, made once, at a calm moment — which, it turns out, is what 'organized' actually means."}
  ]$json$::jsonb, true
),
(
  'the-sunday-reset',
  'The 20-Minute Sunday Reset (That Saves Your Whole Week)',
  'Not a deep clean. Not a life overhaul. Twenty minutes, five stations, and Monday-you will think a professional came through.',
  'Maya Chen', '2026-06-24', 5, ARRAY['routines','home','organization'], 'Organization', false, '#3b82f6',
  'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=1600&q=80',
  'A clean, bright kitchen counter ready for the week',
  'Unsplash',
  $json$[
    {"type":"p","text":"There are two kinds of Monday mornings. In one, you're excavating a permission slip from under a pizza box while yelling 'SHOES' in a tone you swore you'd never use. In the other, the backpacks are by the door, the calendar has been glanced at, and — this is the wild part — everyone is fine."},
    {"type":"p","text":"The difference is not virtue. It's twenty minutes on Sunday, spent at five stations. Set a timer; when it dies, you're done, wherever you are. The timer is what makes this survivable."},
    {"type":"h2","text":"Station 1: The landing zone (4 min)"},
    {"type":"p","text":"Whatever surface catches things when people walk in — clear it. Mail triaged, keys hooked, the mystery cables relocated to the mystery cable drawer. This surface sets the tone for the house; when it's clear, the whole entryway exhales."},
    {"type":"h2","text":"Station 2: Backpacks and bags (4 min)"},
    {"type":"p","text":"Every school bag gets opened — yes, all compartments; be brave. Sign what needs signing, trash the granola bar shrapnel, repatriate the library books. Kids over six do their own while you supervise like a friendly customs agent. What you find in there on Sunday costs nothing. The same discovery on Thursday at 7:40 a.m. costs everything."},
    {"type":"h2","text":"Station 3: The calendar glance (4 min)"},
    {"type":"p","text":"Look at the week together with whoever runs it with you. You're hunting exactly three things: conflicts (two things, one timeslot), gaps (who covers Thursday?), and prep (the costume needed for Friday's play — known about tonight, or discovered Thursday at bedtime?). Three minutes of looking prevents three hours of scrambling."},
    {"type":"h2","text":"Station 4: The fridge triage (4 min)"},
    {"type":"p","text":"Evict the science experiments, front-line the leftovers, and let the gaps write the start of your grocery list. You'll also rediscover tomorrow's lunch ingredients you forgot you had — a small win with excellent timing."},
    {"type":"h2","text":"Station 5: The launch pad (4 min)"},
    {"type":"p","text":"Tomorrow's exit, staged tonight: bags by the door, shoes paired, water bottles filled, the field-trip form IN the bag rather than 'somewhere.' Morning-you has the executive function of a raccoon in a bright kitchen. Sunday-you is a genius. Let the genius set the table."},
    {"type":"p","text":"That's it. Twenty minutes, no deep cleaning, no self-improvement. Do it three Sundays in a row and the kids start doing stations without being asked — not because they've grown as people, but because even they can feel the difference between a launched Monday and a crashed one."}
  ]$json$::jsonb, true
),

-- ═══ PARENTING ═══════════════════════════════════════════════════════════════
(
  'quality-time',
  'How to Create More Quality Time (Without More Time)',
  'You don''t need more hours. You need to stop letting logistics eat the ones you have. Small moves that change everything.',
  'The Bubaly Team', '2026-03-18', 6, ARRAY['parenting','wellness','connection'], 'Parenting', false, '#f97316',
  'https://images.unsplash.com/photo-1476234251651-f353703a034d?auto=format&fit=crop&w=1600&q=80',
  'A parent and child reading a book together outdoors',
  'Unsplash',
  $json$[
    {"type":"p","text":"Here's a math problem no parent enjoys: kids are home for roughly 940 Saturdays between birth and leaving for college, and you've already used some of them. The instinct that follows is to DO more — book the trip, plan the craft, schedule the memories. The instinct is wrong."},
    {"type":"p","text":"Quality time doesn't respond to scheduling the way meetings do. It shows up in the margins — and the margins are exactly what family logistics keep eating."},
    {"type":"h2","text":"The 9 p.m. audit"},
    {"type":"p","text":"Tonight, notice what you and your partner talk about after the kids are down. If it's carpools, forms, and who's taking Thursday — that's not conversation, that's a shift handover. The couples who feel like teammates aren't having fewer logistics; they've moved logistics OUT of prime time. A fifteen-minute Sunday planning ritual (with the calendar, not from memory) buys back every weeknight from the operations meeting your relationship never applied to host."},
    {"type":"h2","text":"Downgrade the moments, upgrade the presence"},
    {"type":"p","text":"Kids don't experience childhood in highlights. They experience it in Tuesdays. The twenty-minute drive to practice is quality time — if you're not mentally rehearsing tomorrow's schedule. The trick isn't being around more; it's being fully somewhere, briefly, and often. Ten present minutes beat two distracted hours, and every kid can tell the difference with terrifying accuracy."},
    {"type":"h2","text":"Institutionalize one tiny ritual"},
    {"type":"p","text":"The families that feel close usually have one absurdly small tradition with perfect attendance: pancake Saturday, the walk after dinner, high-low at bedtime (best moment of the day, worst moment of the day). Rituals are quality time with the decision-making removed — nobody has to plan them, so nobody can drop them. Pick one. Guard it like it's a meeting with someone important, because it is."},
    {"type":"h2","text":"Let something be handled"},
    {"type":"p","text":"The deepest reason presence is hard isn't your phone. It's the open loops — the permission slip, the dentist you keep meaning to book, the gift for Saturday's party. An open loop is a background process, and background processes drain the battery. Whether it's a shared system, a better split with your partner, or software that watches the week for you: every loop you close is presence you get back for free."},
    {"type":"p","text":"You can't add hours. You can stop strip-mining the ones you have. The Saturdays are counting down either way — the only variable is whether you're actually there for them."}
  ]$json$::jsonb, true
),
(
  'taming-the-family-mental-load',
  'Taming the Family Mental Load',
  'The invisible work of running a household is real work. Here''s how to see it, split it, and stop being the only server that never reboots.',
  'Jessica Miller', '2026-04-08', 6, ARRAY['organization','parenting','mental load'], 'Parenting', false, '#f97316',
  'https://images.unsplash.com/photo-1495364141860-b0d03eccd065?auto=format&fit=crop&w=1600&q=80',
  'A hand holding a small alarm clock — the mental load is always running',
  'Unsplash',
  $json$[
    {"type":"p","text":"There's a moment every over-loaded parent knows: you're finally in bed, the house is quiet, and your brain — with no warning — announces that the swim permission slip is due tomorrow, you're out of birthday wrapping paper, and someone's shoes no longer fit. Congratulations. You are the family server, and you do not get to reboot."},
    {"type":"p","text":"That's the mental load: not the doing, but the KNOWING. Tracking, anticipating, remembering, noticing. It's real work, it's exhausting, and in most households it silently piles onto one person — usually the one reading this article and nodding."},
    {"type":"h2","text":"Step 1: Make the invisible visible"},
    {"type":"p","text":"You can't split what nobody can see. For one week, dump every household 'known' into one shared place — every appointment to book, form to sign, size to track, gift to buy, thing to notice. The list will be shocking. Good. It's supposed to be. Most partners aren't refusing to help; they genuinely cannot see work that lives inside someone else's head. Externalize it and the conversation changes from 'you never help' (a fight) to 'here are 60 items; pick your 30' (a plan)."},
    {"type":"h2","text":"Step 2: Hand over whole loops, not tasks"},
    {"type":"p","text":"Here's where most redistributions fail: one person keeps the THINKING and delegates the DOING. 'Can you call the dentist? The number is on the fridge, we need two cleanings, mornings are better, not Wednesday.' You didn't delegate — you hired a hands-free device. Real relief means handing over the whole loop: 'Dental is yours now. Appointments, reminders, the weird insurance form — all of it.' The owner notices, decides, and executes. Nobody has to remember to remind the rememberer."},
    {"type":"h2","text":"Step 3: Give the load a place to live that isn't a skull"},
    {"type":"p","text":"Whatever system you use — a shared app, a family board, an assistant that watches the calendar and nags the right person automatically — the test is the same: when something is IN the system, the person who used to carry it can actually stop thinking about it. That release is the entire point. A reminder that fires at the right moment, at the right human, is one less item spinning in anyone's 2 a.m. brain."},
    {"type":"h2","text":"The payoff is not efficiency"},
    {"type":"p","text":"Families that split the mental load don't just run smoother — they're NICER. Resentment has a very specific fuel: invisible, unacknowledged, unshared work. Drain the fuel and everything else gets easier: the couch conversation, the Saturday morning, the tone of the whole house. The load never disappears. Kids keep outgrowing shoes. But carried by two adults and a good system instead of one silent hero? It's just logistics. And logistics can be handled."}
  ]$json$::jsonb, true
),
(
  'the-allowance-experiment',
  'The Allowance Experiment: How Our Kids Started Fighting Over Chores',
  'We turned the chore chart into an economy. Within two weeks the children were negotiating like tiny commodity traders. A field report.',
  'Sam Rivera', '2026-06-03', 6, ARRAY['parenting','chores','money'], 'Parenting', false, '#f97316',
  'https://images.unsplash.com/photo-1611371805429-8b5c1b2c34ba?auto=format&fit=crop&w=1600&q=80',
  'A close-up of a classic board game money track — the family economy in miniature',
  'Unsplash',
  $json$[
    {"type":"p","text":"For years, our chore chart was a monument to failed governance. Stickers were tried. Sticker inflation set in. Threats were issued, then commuted. The dishwasher remained a mystery to everyone under five feet tall."},
    {"type":"p","text":"Then we stopped running chores as a moral program and started running them as an economy. Everything changed in fourteen days."},
    {"type":"h2","text":"The setup: base pay plus bounties"},
    {"type":"p","text":"Two tiers. Tier one: citizenship — making your bed, clearing your plate, not treating the floor as a closet. Unpaid, non-negotiable; you live here. Tier two: bounties — real jobs with posted rates. Unload the dishwasher: 50 cents. Fold a laundry basket: a dollar. Weed the flower bed: two dollars, because suffering deserves compensation. The rates were public, the ledger was shared, and payment was instant on inspection. Instant matters: a seven-year-old's trust in delayed compensation is roughly zero, and honestly, fair."},
    {"type":"h2","text":"What happened next"},
    {"type":"p","text":"Week one: cautious participation. Week two: our daughter cornered the laundry market. She'd discovered that folding while watching a show was, in her words, 'free money,' and began checking the hamper levels like a floor trader. Her brother, incensed, pivoted to the dishwasher and then attempted to SUBCONTRACT it to her for 30 cents, pocketing the spread. We had produced middle management. We let it stand: negotiation, pricing, and the discovery that money is earned by being useful — that WAS the lesson."},
    {"type":"h2","text":"The three rules that kept it fair"},
    {"type":"p","text":"One: never pay for citizenship, or you'll soon be paying a toll to get your own child to a dinner table. Two: quality control before payment — a half-folded basket earns half, which taught 'done properly' faster than any lecture. Three: their money is THEIRS. The first purchase will be regrettable. Let it be. A nine-dollar mistake at nine years old is the cheapest financial education on the market; the same lesson at 29 has interest rates."},
    {"type":"h2","text":"Was it worth it?"},
    {"type":"p","text":"The house is cleaner. The whining is quieter — you can't argue with a posted rate the way you can argue with a parent's mood. And the kids now understand something school won't teach for another decade: work has value, value is negotiable, and the laundry, like the market, never truly closes."}
  ]$json$::jsonb, true
),
(
  'the-birthday-machine',
  'The Birthday Machine: Never Get Ambushed by a Party Again',
  'Gift, card, RSVP, outfit that fits, Saturday that isn''t double-booked — a checklist that turns birthday chaos into a repeatable system.',
  'Maya Chen', '2026-04-22', 5, ARRAY['parenting','planning','celebrations'], 'Parenting', false, '#f97316',
  'https://images.unsplash.com/photo-1587616211892-f743fcca64f9?auto=format&fit=crop&w=1600&q=80',
  'Children celebrating at a colorful birthday party',
  'Unsplash',
  $json$[
    {"type":"p","text":"The birthday party ambush is a genre. It begins with a crumpled invitation discovered in a backpack — dated eleven days ago, RSVP due yesterday — and ends with you at a gas station on Saturday morning buying a gift card and a candy bar shaped like an apology."},
    {"type":"p","text":"Kids' social calendars are denser than most executives': a class of 24 generates up to 24 parties a year, and that's before cousins, neighbors, and teammates. You cannot feel your way through that volume. You need a machine."},
    {"type":"h2","text":"Intake: the invitation goes in the system, instantly"},
    {"type":"p","text":"The rule that changes everything: an invitation is processed the moment it's found — not set on the counter to ripen. Processed means three things, ninety seconds total: the party goes on the family calendar (with the venue), the RSVP is sent (parties are almost always yes or no on the spot; agonizing adds nothing), and a gift task is created with a deadline three days BEFORE the party. The counter is where invitations go to become emergencies."},
    {"type":"h2","text":"The gift shelf: buy once, panic never"},
    {"type":"p","text":"Veteran parents know this one: a closet shelf stocked twice a year with six to eight universal-appeal gifts in the local going rate. Craft kits, LEGO, art supplies, a good puzzle. Add a folder of birthday cards and a roll of one neutral wrapping paper. Saturday-morning gift emergencies simply cease to exist as a category — you shop your own closet at a calm moment instead of a checkout line at an anxious one."},
    {"type":"h2","text":"The week-of sweep"},
    {"type":"p","text":"During your Sunday calendar glance, any party in the next seven days gets a 60-second audit: Gift wrapped? Card signed — by the CHILD, an underrated detail? Do we know where the venue is? Does the party outfit still fit? (Kids grow in secret. The blazer that fit in March is a crop top by June.) Any 'no' becomes a weekday errand instead of a weekend crisis."},
    {"type":"h2","text":"Your own kid's party: same machine, bigger flywheel"},
    {"type":"p","text":"Hosting compresses into the same checklist run in reverse at T-minus-4-weeks (venue, list, invites), 2 weeks (cake, food, favors), and 2 days (confirm headcount, stage supplies). Save the checklist after the first run. Next year, you're not planning a party — you're re-running a program with a different theme on top."},
    {"type":"p","text":"None of this makes birthdays magical. The cake and the shrieking do that part. The machine just makes sure the adults get to ENJOY the magic instead of sprinting through it with a gas-station gift bag."}
  ]$json$::jsonb, true
),

-- ═══ SCHOOL & ACTIVITIES ═════════════════════════════════════════════════════
(
  'last-day-school-checklist',
  'The Last-Day-of-School Checklist: Don''t Miss a Thing',
  'Library books, art projects, teacher thank-yous, and the summer-camp forms hiding in plain sight — the complete end-of-year sweep.',
  'The Bubaly Team', '2026-06-10', 5, ARRAY['school','checklist','summer'], 'School & Activities', false, '#10b981',
  'https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?auto=format&fit=crop&w=1600&q=80',
  'A hand writing out a checklist in a notebook',
  'Unsplash',
  $json$[
    {"type":"p","text":"The last week of school is a strange weather system: part celebration, part logistics hurricane, part archaeological dig through nine months of backpack sediment. Things surface. Some of them are permission slips from October. One of them is always a sandwich."},
    {"type":"p","text":"Here's the complete sweep, organized so nothing ambushes you in July."},
    {"type":"h2","text":"The returns: get ahead of the fines"},
    {"type":"p","text":"Library books — school AND classroom library; they're different systems with different consequences. Textbooks and loaner instruments. The sports uniform (the school will invoice you in September with the patience of a debt collector). Any classroom borrow that migrated home: the class novel, the recorder, the pet rock that is somehow school property. Do one dedicated sweep of bedrooms and the car; this is where school property goes to summer."},
    {"type":"h2","text":"The retrievals: what comes home matters too"},
    {"type":"p","text":"Art projects and the writing portfolio — future-you will treasure exactly three pieces per year, so photograph the rest and recycle guilt-free while the child sleeps. Medications kept at the nurse's office (EpiPens, inhalers — these expire and are expensive to forget). Lost and found: go look. Physically. Your missing hoodie inventory is there, and it does not carry over."},
    {"type":"h2","text":"The people: two thank-yous that count"},
    {"type":"p","text":"A short handwritten note from your kid to their teacher beats any mug ever fired in a kiln — teachers keep those notes for decades. And get contact info for two or three friends' parents NOW, while everyone is standing at the same pickup line. In August, when your child is desperate to see 'Jake from class,' you will otherwise discover that Jake has no last name and lives nowhere."},
    {"type":"h2","text":"The paperwork: future-you's survival kit"},
    {"type":"p","text":"The final report card, filed where next year's enrollment forms can find it. Summer reading list and any assigned work — calendar a weekly rhythm NOW, because the version of this discovered on August 20th is a very different experience. Camp forms, swim-lesson registrations, fall sports sign-ups that inexplicably close in June: this is the week they all converge. Fifteen minutes with the calendar beats a summer of waitlists."},
    {"type":"h2","text":"The one that always escapes"},
    {"type":"p","text":"Update the emergency contacts and pickup lists at any summer program — camps don't inherit the school's records, and the grandparent doing Tuesday pickups needs to be on the list BEFORE Tuesday. It's a two-minute phone call in June and a locked-lobby standoff in July."},
    {"type":"p","text":"Then it's done: the backpack is empty, the fines are dodged, the thank-you is delivered. Go start the summer — you've officially earned the popsicle."}
  ]$json$::jsonb, true
),
(
  'activity-overload',
  'Activity Overload: How Many After-School Activities Is Too Many?',
  'Soccer, piano, coding club, swim. Somewhere between enrichment and exhaustion there''s a line — here''s how to find yours.',
  'Jessica Miller', '2026-06-17', 6, ARRAY['school','activities','balance'], 'School & Activities', false, '#10b981',
  'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?auto=format&fit=crop&w=1600&q=80',
  'A young athlete crouched at the starting blocks of a running track',
  'Unsplash',
  $json$[
    {"type":"p","text":"Somewhere in the last generation, childhood acquired a commute. The average enrolled kid now runs a schedule that would make a consultant flinch: soccer Mondays, piano Tuesdays, coding Wednesdays, swim Thursdays, and a Saturday that starts with shin guards at 7 a.m. The family car has become a shuttle service with snacks."},
    {"type":"p","text":"Activities are genuinely good — that's what makes this hard. Sports teach resilience, music rewires brains, clubs build friendships. The problem isn't any single yes. It's the compound interest of all of them."},
    {"type":"h2","text":"The three-question audit"},
    {"type":"p","text":"For each activity, ask: Does the kid actually want to go? Watch the body language on the drive there, not the recital smile — kids perform enthusiasm for parents long after the real thing has died. Is there still white space? Unstructured, boring, nothing-scheduled time isn't wasted childhood; it's where self-direction gets built. A week with zero boredom is a week with zero practice at filling it. And who is this for? The honest one. Sometimes an activity survives because quitting feels like OUR failure — the sunk-cost fallacy wearing a tiny uniform."},
    {"type":"h2","text":"A rule of thumb that mostly works"},
    {"type":"p","text":"One physical thing, one non-physical thing, per kid, per season — and for every activity added, something visible on the calendar gets removed. Families who cap it this way don't raise less accomplished kids; they raise kids who go DEEP on fewer things, which is what mastery actually looks like. Ten activities sampled shallowly is a résumé. Two loved for years is a life."},
    {"type":"h2","text":"Watch the system load, not just the kid"},
    {"type":"p","text":"Put every activity — practices, games, gear, fees, drive time — on the shared family calendar and look at the WEEK, not the child. A kid can be thriving while the family around them is redlining: dinner in the car four nights out of five, siblings raised at the edge of each other's practices, parents who've become dispatchers who occasionally hug. The child's enrichment is not free if the household is paying for it in connection."},
    {"type":"h2","text":"Quitting season is a feature"},
    {"type":"p","text":"Hold a review twice a year — end of fall, end of spring — where every activity has to re-earn its slot. Not mid-season (commitments get finished; that's non-negotiable), but at the natural break. Making 'we don't re-up by default' the family norm removes all the drama from stopping. The kid isn't a quitter. The season simply ended, the way seasons do."},
    {"type":"p","text":"The goal was never an impressive childhood. It's a good one — with room in it to breathe, to be bored, and to occasionally eat dinner at an actual table, all four chairs full."}
  ]$json$::jsonb, true
),
(
  'the-library-card-upgrade',
  'The Library Card: The Most Underrated Free Upgrade in Family Life',
  'Museum passes, movie nights, summer programs, and infinite books — the boring old library card is secretly a family cheat code.',
  'Sam Rivera', '2026-04-01', 5, ARRAY['school','free','reading'], 'School & Activities', false, '#10b981',
  'https://images.unsplash.com/photo-1427504494785-3a9ca7044f45?auto=format&fit=crop&w=1600&q=80',
  'Tall library shelves lined with colorful books',
  'Unsplash',
  $json$[
    {"type":"p","text":"Family life is expensive, and most of the advice about it is a list of things to buy. So here is the rare opposite: the single highest-value item in your wallet is probably the one you got for free and forgot about. The library card has been quietly leveling up for a decade while nobody was watching, and the modern version is barely recognizable."},
    {"type":"h2","text":"It's a streaming service now"},
    {"type":"p","text":"Most library systems bundle free apps that stream audiobooks, ebooks, movies, and music to whatever device your family already owns. The audiobook angle alone is a parenting cheat code: a kid who 'hates reading' but devours audiobooks in the car is, in fact, reading — comprehension research says so — and the entire backlist of everything is free. The 40-minute activity commute you were already driving just became a book club."},
    {"type":"h2","text":"It's a ticket booth"},
    {"type":"p","text":"The best-kept secret in the building: museum and attraction passes. Many libraries lend free or steeply discounted family passes to zoos, science centers, and museums — the same outing that costs a family of four the better part of $100 at the door. They're bookable like books. Almost nobody knows. Ask the front desk 'what passes do you have?' and watch a whole season of weekend plans fall out of the answer."},
    {"type":"h2","text":"It's a summer program you didn't have to plan"},
    {"type":"p","text":"Summer reading challenges — with actual prizes, progress charts, and events — are a done-for-you motivation system that runs all July. Add story times, LEGO clubs, teen maker labs, and homework help, and the library is quietly the cheapest enrichment vendor in town, with a per-activity cost of exactly zero and no carpool politics."},
    {"type":"h2","text":"The kid with their own card"},
    {"type":"p","text":"Here's the developmental trick hiding in the bureaucracy: get each kid their OWN card as soon as the library allows. A library card is the first document of trust most kids ever hold — their name, their checkouts, their (tiny, forgivable) fines. Kids who choose their own books read more; kids who manage their own returns learn deadlines with training wheels on. It's independence with a barcode."},
    {"type":"p","text":"Total cost of everything above: zero dollars. Somewhere in your town there's a building full of free childhood upgrades with your family's name on them. Go swipe the card."}
  ]$json$::jsonb, true
),

-- ═══ WELLNESS ════════════════════════════════════════════════════════════════
(
  'healthy-family-habits',
  'Healthy Family Habits That Stick (Even on Busy Weeks)',
  'Forget the overhaul. The habits that survive real life are small, attached to things you already do, and impossible to fail.',
  'The Bubaly Team', '2026-03-25', 6, ARRAY['wellness','habits'], 'Wellness', false, '#f59e0b',
  'https://images.unsplash.com/photo-1502086223501-7ea6ecd79368?auto=format&fit=crop&w=1600&q=80',
  'Kids playing with a ball outdoors among the trees',
  'Unsplash',
  $json$[
    {"type":"p","text":"Every January, thousands of families adopt a Wellness Plan with the structural integrity of a sandcastle. Daily smoothies. 6 a.m. family runs. Screen-free evenings, forever. By February, the blender is a monument and everyone is quietly relieved."},
    {"type":"p","text":"The plans don't fail because families are weak. They fail because they were designed for a fictional week — one with no late meetings, no sick kids, no rain. The habits that survive are built differently. Three principles do most of the work."},
    {"type":"h2","text":"Shrink it until it's impossible to fail"},
    {"type":"p","text":"The habit isn't 'family walks.' It's 'we step outside after dinner.' Some nights that becomes forty minutes around the neighborhood; some nights it's four minutes of standing in the driveway pointing at the moon. Both count. Both KEEP THE STREAK — and the streak, not the workout, is the actual asset. A habit small enough to survive your worst Wednesday will quietly compound for years, which is more than can be said for any ambitious plan that requires you to be a better person first."},
    {"type":"h2","text":"Attach it to something that already happens"},
    {"type":"p","text":"Don't schedule new habits into empty slots — your family doesn't have empty slots. Weld them onto fixtures that already exist. Vegetables get eaten first WHILE everyone's hungriest, not negotiated last. Water bottles get filled WHEN the dishwasher gets unloaded. The gratitude question ('what was good today?') happens AT the dinner table, because the table already happens. Habits with a host survive. Orphan habits die in the calendar."},
    {"type":"h2","text":"Make it visible, make it shared"},
    {"type":"p","text":"A habit tracked on a shared chart — physical or digital — recruits the most powerful enforcement mechanism ever discovered: a seven-year-old who notices YOU skipped. Family habits stick better than personal ones precisely because everyone is simultaneously participant and referee. The goal isn't surveillance; it's that lovely, low-stakes accountability where the kid slides the checklist across the table with one eyebrow raised."},
    {"type":"h2","text":"The menu, not the mandate"},
    {"type":"p","text":"Pick from this list; do not attempt this list: outside after dinner. Fruit or veg first at every meal. Screens dock in the kitchen at 8. One family water pitcher refilled morning and night. High-low at bedtime. Weekend pancake walk. Choose TWO. Run them until they're boring — boring means they've become infrastructure. Then, and only then, add a third."},
    {"type":"p","text":"Health, for a family, was never going to be a program. It's a handful of tiny defaults, welded to the day, small enough to survive the week you're actually having."}
  ]$json$::jsonb, true
),
(
  'screen-time-truce',
  'The Screen-Time Truce: A Peace Deal Your Family Can Actually Keep',
  'Stop fighting the same battle every night. Negotiate it once, write it down, and let the agreement — not the parent — be the bad guy.',
  'Jessica Miller', '2026-07-01', 6, ARRAY['wellness','screens','kids'], 'Wellness', false, '#f59e0b',
  'https://images.unsplash.com/photo-1560253023-3ec5d502959f?auto=format&fit=crop&w=1600&q=80',
  'Kids with headsets focused on their computer screens',
  'Unsplash',
  $json$[
    {"type":"p","text":"In most houses, screen time isn't a policy — it's a nightly renegotiation conducted at the worst possible moment, between a tired adult and a skilled eight-year-old litigator whose entire caseload is this one issue. The parent wins on authority, the kid wins on stamina, and everyone loses on mood."},
    {"type":"p","text":"The fix isn't a stricter rule. It's moving the negotiation: once, in daylight, with everyone calm — then never again at 8:47 p.m."},
    {"type":"h2","text":"Negotiate the treaty in peacetime"},
    {"type":"p","text":"Hold a family meeting when nobody is mid-episode. Put three questions on the table: when are screens fine, when are they never fine, and what happens when time's up? Kids agree to — and defend! — rules they helped draft; the same limit imposed unilaterally becomes tyranny by Wednesday. Write the final deal down and post it. When the whining starts, you don't argue. You point. 'That's the treaty. You signed it.' The paper is the bad guy now. The paper doesn't mind."},
    {"type":"h2","text":"Zones beat minutes"},
    {"type":"p","text":"Minute-counting turns parents into meter maids and teaches kids exactly one skill: clock-watching. Zones are sturdier and don't require enforcement math: no screens at the table. No screens in bedrooms overnight — every device sleeps in the kitchen dock, adults' phones included (this clause will be inspected). No screens during the golden hour before school. Inside the open zones? Let go a little. A kid who owns the decision inside clear fences is learning self-regulation. A kid micromanaged by the minute is learning to appeal."},
    {"type":"h2","text":"The content clause"},
    {"type":"p","text":"Not all screen time is the same substance. Building a world in Minecraft with a cousin, video-calling grandma, and autoplaying an infinite feed are three different activities that happen to share a rectangle. Most families' real problem isn't total minutes — it's the feed. So rank it in the treaty: creating > connecting > watching-something-chosen > autoplay. Trade up freely, trade down reluctantly."},
    {"type":"h2","text":"The exit ramp"},
    {"type":"p","text":"The meltdown at time's-up has a boring neurological cause: hard stops mid-dopamine are genuinely painful. Build the off-ramp into the deal — a ten-minute warning, then 'finish the level / end the episode', then done. And the most powerful clause of all: what comes NEXT is named in advance. 'Screens off, then we shoot hoops' lands completely differently than 'screens off,' full stop, staring into the void. Kids don't hate ending; they hate ending into nothing."},
    {"type":"p","text":"You'll still have hard nights — it's parenting, not physics. But when the deal is shared, written, and fair, you stop being the villain of the evening. You're just the co-signer of a very reasonable treaty, pointing calmly at page one."}
  ]$json$::jsonb, true
),
(
  'family-game-night-comeback',
  'The Great Family Game Night Comeback',
  'Cheaper than therapy, more honest than small talk: why 40 minutes around a board is the highest-yield ritual in the house.',
  'Sam Rivera', '2026-05-06', 5, ARRAY['wellness','connection','play'], 'Wellness', false, '#f59e0b',
  'https://images.unsplash.com/photo-1610890716171-6b1bb98ffd09?auto=format&fit=crop&w=1600&q=80',
  'A colorful strategy board game mid-play, pieces scattered across the board',
  'Unsplash',
  $json$[
    {"type":"p","text":"Somewhere between the streaming queue and the activity schedule, family game night quietly died in most houses — and it's worth staging the comeback, because 40 minutes around a board delivers things no other ritual in family life can: eye contact, negotiation, gracious losing, ungracious losing (also useful data), and the specific joy of watching a small child destroy a confident adult at their own game."},
    {"type":"h2","text":"Why it works when conversation doesn't"},
    {"type":"p","text":"Ask a ten-year-old 'how was school?' and you'll receive the word 'fine,' possibly a shrug. But shoulder-to-shoulder over a game, with hands busy and stakes deliciously fake, kids TALK. Psychologists call it side-by-side communication; parents call it the only known method for learning what actually happened in fourth grade. The game is a decoy. The conversation is the loot."},
    {"type":"h2","text":"Match the game to the family you actually have"},
    {"type":"p","text":"Game night dies from ambition: someone buys a three-hour strategy epic and the six-year-old sets fire to the rulebook by turn two. Work the ladder instead. Ages 4–6: cooperative games, where everyone wins or loses together and nobody flips the board. Ages 7–10: the classics plus fast card games — this is prime 'beat dad legitimately' territory, developmentally priceless. Tweens and teens: social deduction and bluffing games, because lying to your family with permission is, apparently, hilarious. Mixed ages: team up. A kindergartner paired with a parent versus the world is a happy kindergartner."},
    {"type":"h2","text":"Institutionalize it or lose it"},
    {"type":"p","text":"A ritual that isn't scheduled is a suggestion, and suggestions lose to homework. Same night, same time, on the family calendar with a reminder like any other commitment — because it IS one. Attach it to food (pizza-and-games Friday has survived in millions of houses for a reason), let the winner pick next week's game, and keep sessions SHORT. Always end while it's still fun. Leave them wanting the sequel."},
    {"type":"h2","text":"Losing is the curriculum"},
    {"type":"p","text":"One more thing, and it's the real one: game night is where kids practice losing while the stakes are cardboard. The kid who storms off at eight, tries again at nine, and shrugs-and-shuffles at ten just built a skill that will outlast every trophy in the house. You cannot lecture resilience into a child. You can, however, beat them at cards and hand them the deck."}
  ]$json$::jsonb, true
),
(
  'boredom-is-a-feature',
  'Boredom Is a Feature: In Defense of the Unscheduled Summer',
  'The magic words are ''I''m bored'' — and the magic is in what happens ten minutes after you refuse to fix it.',
  'Maya Chen', '2026-07-06', 5, ARRAY['wellness','summer','play'], 'Wellness', false, '#f59e0b',
  'https://images.unsplash.com/photo-1489710437720-ebb67ec84dd2?auto=format&fit=crop&w=1600&q=80',
  'A boy playing joyfully in a sprinkler in golden summer light',
  'Unsplash',
  $json$[
    {"type":"p","text":"At some point in July, it happens: a child appears in your doorway, radiating accusation, and delivers the two most feared words in modern parenting. 'I'm. Bored.' The modern reflex is to treat this as a service outage — grab the calendar, book the camp, deploy the tablet, restore entertainment as quickly as possible."},
    {"type":"p","text":"Here's the case for doing approximately nothing."},
    {"type":"h2","text":"Boredom is the on-ramp, not the breakdown"},
    {"type":"p","text":"Developmental researchers have been saying this for years, quietly, while the activity-industrial complex shouted over them: boredom is where self-direction gets built. The itchy, unpleasant gap between 'nothing is happening' and 'I made something happen' is a muscle, and it only grows under load. A kid whose every hour is programmed never has to lift it. The discomfort is not a bug in the summer. It IS the summer."},
    {"type":"h2","text":"The ten-minute rule"},
    {"type":"p","text":"When the boredom complaint arrives, resist the fix for ten minutes. That's it — that's the whole technique. The first three minutes produce dramatic sighing and floor-lying of theatrical quality. Somewhere around minute seven, the shift: a blanket becomes a fort roof, the dog acquires a job, an elaborate economy of painted rocks emerges in the driveway. What a kid builds out of their own boredom holds their attention ten times longer than anything handed to them — because it's THEIRS."},
    {"type":"h2","text":"Boring-parent starter kit"},
    {"type":"p","text":"You're allowed one move: making raw materials quietly available and then leaving. A stack of cardboard boxes by the recycling. Sidewalk chalk on the porch step. The sprinkler, attached, unactivated, a suggestion. Painter's tape (roads on the floor, targets on the fence, infinite uses, zero cleanup rage). Note the trick: none of these come with instructions. Materials, not missions."},
    {"type":"h2","text":"Hold one anchor, free the rest"},
    {"type":"p","text":"Total anarchy scares kids as much as it scares adults — the sweet spot is a day with ONE fixed point. Morning swim lesson, then nothing. Library run at four, before it: nothing. The anchor gives the day a shape; the nothing gives it a soul. That's the ratio the best summers have always run on, back to whenever childhood was invented."},
    {"type":"p","text":"There will be whining. Outlast it. On the other side of 'I'm bored' is the thing you actually wanted for them all along: a kid who knows how to start something. It just needs ten uncomfortable minutes to boot."}
  ]$json$::jsonb, true
),

-- ═══ FAMILY FINANCES ═════════════════════════════════════════════════════════
(
  'family-budget-basics',
  'Budgeting as a Family: 5 Simple Steps to Get Started',
  'No spreadsheets-of-shame, no austerity theater. A five-step framework that turns money from a monthly fight into a shared game plan.',
  'The Bubaly Team', '2026-03-11', 6, ARRAY['finances','budgeting'], 'Family Finances', false, '#ec4899',
  'https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=1600&q=80',
  'Receipts and a calculator on a table — budget night in progress',
  'Unsplash',
  $json$[
    {"type":"p","text":"Family budgeting has a branding problem. The word conjures a spreadsheet of shame, a lecture about lattes, and one tense adult reading grocery totals aloud like criminal charges. No wonder most families' official budget is 'we sort of know, roughly, probably.'"},
    {"type":"p","text":"But a budget is just a plan for money — and families who plan together fight about money dramatically less, not because there's more of it, but because there are fewer surprises. Here's the no-shame version, five steps."},
    {"type":"h2","text":"Step 1: Watch, don't judge (one month)"},
    {"type":"p","text":"Before changing anything, just LOOK. Track a full month of spending with zero interventions — most banking apps will categorize it for you. The goal is a photograph, not a verdict. Every family finds at least one 'wait, WHAT is that' category. (It's usually subscriptions. It's basically always subscriptions.)"},
    {"type":"h2","text":"Step 2: Sort into three buckets, not thirty categories"},
    {"type":"p","text":"Forty-line budgets die of administrative exhaustion by February. Use three buckets: Needs (housing, food, insurance, the non-negotiables), Wants (fun, takeout, the good snacks — this bucket is a feature, not a leak), and Future (savings, debt payoff, the emergency cushion). A common starting split is roughly half, a third, and the rest — but YOUR ratio matters less than KNOWING your ratio."},
    {"type":"h2","text":"Step 3: Hold a 20-minute money date, monthly"},
    {"type":"p","text":"Once a month, the adults look at the buckets together. Twenty minutes, snacks mandatory, agenda fixed: What surprised us? What's coming (birthdays, camp deposits, the car making That Noise)? One thing to adjust? That's it. Money stress thrives in silence and dies in schedules — the date, kept boring and regular, is the entire mechanism."},
    {"type":"h2","text":"Step 4: Automate the Future bucket"},
    {"type":"p","text":"Savings that depend on end-of-month willpower don't happen; end-of-month willpower is a myth, like the leftover Halloween candy. Automate a transfer on payday — even a small one. The families that build cushions aren't more disciplined; they've simply removed themselves from the loop. Start embarrassingly small. Raise it when it gets invisible."},
    {"type":"h2","text":"Step 5: Let the kids see (some of) it"},
    {"type":"p","text":"You don't owe children the mortgage details, but 'that's not in the budget this month — it goes on the maybe-list for next month' is one of the most quietly educational sentences a kid can hear. It teaches that money is finite, planned, and unemotional — not a mysterious force that sometimes says no angrily. Bonus: the maybe-list kills checkout-line negotiations dead. It's on the list. The list decides. The list is very fair."},
    {"type":"p","text":"That's the whole program: look, sort, meet, automate, include. No shame, no austerity theater — just a family that knows its own numbers and argues about them roughly never."}
  ]$json$::jsonb, true
),
(
  'teach-kids-about-money',
  'Pocket Money 2.0: Raising Kids Who Actually Get Money',
  'Spend, save, share: how three jars (or three digital buckets) quietly teach the financial skills school never will.',
  'Maya Chen', '2026-04-15', 6, ARRAY['finances','kids','allowance'], 'Family Finances', false, '#ec4899',
  'https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?auto=format&fit=crop&w=1600&q=80',
  'A seedling sprouting from a pile of coins — money that grows',
  'Unsplash',
  $json$[
    {"type":"p","text":"Schools will teach your child the quadratic formula, the parts of a cell, and the exports of countries they may never visit. The odds they'll teach them what compound interest does to a credit card balance: low. Money is the most-used, least-taught skill in adult life — which means the curriculum is you."},
    {"type":"p","text":"Good news: the entire course fits in three jars."},
    {"type":"h2","text":"The three jars"},
    {"type":"p","text":"Every dollar a kid receives — allowance, birthday loot, chore bounties — gets split across Spend, Save, and Share. A common split is 70/20/10, but the exact numbers matter less than the ritual of splitting. Spend is theirs, immediately, no lectures attached. Save has a NAMED target taped to it — 'the LEGO set', with a picture — because abstract saving is meaningless at eight, but watching a jar fill toward a picture is a progress bar made of money. Share goes to a cause the kid picks; the picking is where the lesson lives. Digital pocket-money apps mirror the same buckets for older kids — same physics, fewer coins in the couch."},
    {"type":"h2","text":"Let the bad purchase happen"},
    {"type":"p","text":"At some point your child will empty the Spend jar on an object of breathtaking uselessness — a toy that snaps by Thursday, a game abandoned in a week. Every parental fiber will scream 'that's a waste.' Say nothing. Buy nothing to fix it. The regret that follows a self-funded mistake is the single most effective financial lesson available anywhere, at any price, and it's on sale right now for $9. The same lesson later in life has four zeros on it and a payment plan."},
    {"type":"h2","text":"Pay interest, run sales, be the economy"},
    {"type":"p","text":"Want to teach compound growth without a whiteboard? Offer 'parent interest': 10% monthly on whatever stays in the Save jar. Watching money appear BECAUSE money sat still rewires a kid's brain about saving faster than any lecture. Occasionally run the opposite lesson: when the coveted item goes on sale, point it out and split the difference. Waiting has a price tag too — sometimes a negative one."},
    {"type":"h2","text":"Narrate your own money out loud"},
    {"type":"p","text":"The most powerful curriculum is ambient. 'We're comparing prices because these two are the same thing in different boxes.' 'We're waiting on that until next month's budget.' 'This one costs more but lasts longer — that's the math we're doing.' Kids learn money the way they learn language: mostly by overhearing fluent speakers. Be fluent, audibly."},
    {"type":"p","text":"Three jars, one tolerated bad purchase, a little fake interest, and a running narration. That's the whole syllabus — and it graduates adults who treat money as a tool they own, instead of a mystery that owns them."}
  ]$json$::jsonb, true
),
(
  'the-subscription-audit',
  'The Subscription Audit: Finding the $200 Leak in Your Family Budget',
  'Streaming, apps, boxes, forgotten trials — the average family bleeds thousands a year on autopilot. One evening fixes it.',
  'Jessica Miller', '2026-05-13', 5, ARRAY['finances','subscriptions','savings'], 'Family Finances', false, '#ec4899',
  'https://images.unsplash.com/photo-1554224154-26032ffc0d07?auto=format&fit=crop&w=1600&q=80',
  'Paperwork and a calculator mid-audit on a desk',
  'Unsplash',
  $json$[
    {"type":"p","text":"Somewhere in your bank statement, right now, there is a monthly charge for something nobody in your house could name. Maybe it's a streaming service from a show you finished in 2023. Maybe it's an app trial that quietly became a marriage. Maybe it's — and this is a real genre — a second cloud-storage plan duplicating the first cloud-storage plan."},
    {"type":"p","text":"Surveys keep finding the same embarrassing number: most people underestimate their subscription spend by roughly HALF, and for families the true figure often clears a couple hundred dollars a month. The fix is one evening, four moves, and a calendar trick."},
    {"type":"h2","text":"Move 1: The extraction"},
    {"type":"p","text":"Pull 90 days of statements — every card, both partners, plus the app-store subscriptions hiding inside phone bills (Apple and Google bury a shocking number of these). List every recurring charge, no matter how small. The $2.99s matter; they travel in packs. Seeing the full list in one place is genuinely shocking for most families, which is exactly the energy you want for move two."},
    {"type":"h2","text":"Move 2: The tribunal"},
    {"type":"p","text":"Each subscription faces three questions: Did anyone use it this month? Would anyone notice in 30 days if it vanished? Does it survive per-use math? (A $15 service used twice is $7.50 an episode — you can rent things for less.) Sort everything into Keep, Kill, and Downgrade. Downgrade is the sleeper category: annual plans you're paying monthly for, premium tiers nobody exploits, four streaming services where a rotating one would do."},
    {"type":"h2","text":"Move 3: The rotation"},
    {"type":"p","text":"The single best trick in the streaming era: stop holding services simultaneously and start holding them SERIALLY. One month of Service A to binge the thing; cancel; next month, Service B. Modern cancel/resubscribe flows take ninety seconds, your watchlist survives, and a family that rotates two services instead of stacking five saves several hundred dollars a year while watching MORE of what they actually wanted."},
    {"type":"h2","text":"Move 4: The tripwires"},
    {"type":"p","text":"Prevent the re-leak: every new trial gets a calendar reminder two days before it converts — this rule alone pays for the pizza you ate during the audit. Route subscriptions through one card so the next audit takes ten minutes. And put a recurring 'subscription sweep' on the family calendar every six months, because subscriptions are a garden and this particular weed grows back on autopilot."},
    {"type":"p","text":"One evening, one list, one slightly smug feeling every month afterward when the statement comes in lighter. As financial wins go, it's the rare one that requires no sacrifice at all — just the willingness to look."}
  ]$json$::jsonb, true
)

ON CONFLICT (slug) DO UPDATE SET
  title             = EXCLUDED.title,
  excerpt           = EXCLUDED.excerpt,
  author            = EXCLUDED.author,
  published_at      = EXCLUDED.published_at,
  reading_minutes   = EXCLUDED.reading_minutes,
  tags              = EXCLUDED.tags,
  category          = EXCLUDED.category,
  featured          = EXCLUDED.featured,
  accent_color      = EXCLUDED.accent_color,
  hero_image_url    = EXCLUDED.hero_image_url,
  hero_image_alt    = EXCLUDED.hero_image_alt,
  hero_image_credit = EXCLUDED.hero_image_credit,
  body              = EXCLUDED.body,
  published         = EXCLUDED.published;

-- Only one featured post: the chief-of-staff flagship.
UPDATE public.blog_posts
  SET featured = false
  WHERE slug <> 'an-ai-chief-of-staff-for-your-home' AND featured = true;
