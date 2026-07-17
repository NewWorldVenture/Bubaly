-- FamilyOS :: 0226 Blog articles — expansion batch 1
-- ----------------------------------------------------------------------------
-- Adds original, editorially-voiced articles to public.blog_posts across all six
-- categories, matching the 0202 format (JSON body blocks, Unsplash hero + alt +
-- credit, tags, accent color). Idempotent: ON CONFLICT (slug) DO UPDATE, so
-- re-running refreshes content without duplicating rows. Hero images reuse the
-- production-verified Unsplash pool (free, known-good — no broken images).
-- SEO/AEO is handled in code (lib/blog/structured-data.ts → BlogPosting +
-- BreadcrumbList + speakable on every article; sitemap already lists all slugs).

INSERT INTO public.blog_posts
  (slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color,
   hero_image_url, hero_image_alt, hero_image_credit, body, published)
VALUES

-- ═══ PARENTING ═══════════════════════════════════════════════════════════════
(
  'the-five-minute-family-meeting',
  'The 5-Minute Family Meeting That Prevents 90% of Weekly Chaos',
  'Most family stress isn''t a values problem — it''s a logistics problem. One tiny weekly ritual fixes an astonishing amount of it.',
  'Jessica Miller', '2026-07-12', 5, ARRAY['routines','communication','mental load'], 'Parenting', true, '#7c5dff',
  'https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?auto=format&fit=crop&w=1600&q=80',
  'A family sitting together at a kitchen table on a bright morning',
  'Unsplash',
  $json$[
    {"type":"p","text":"Here is a suspiciously boring secret about calm families: most of them are not calmer people. They just get surprised less. The Tuesday dentist appointment doesn't ambush them at 8:40 a.m., because somebody said it out loud on Sunday. That's the whole trick — and it fits in five minutes."},
    {"type":"h2","text":"What actually goes in a family meeting"},
    {"type":"p","text":"Not feelings. Not chores you're mad about. Just the week. Walk the next seven days out loud: who's going where, who needs a ride, what's due, what's for dinner on the two nights that always fall apart. You're not solving problems; you're removing surprises. Ninety percent of household friction is a scheduling collision nobody saw coming."},
    {"type":"h2","text":"Keep it to five minutes on purpose"},
    {"type":"p","text":"The instant a family meeting becomes a grievance tribunal, everyone stops coming. Set a literal timer. Cover the week, name the one thing most likely to go wrong, decide who owns it, and stop. Short and reliable beats long and dreaded every single time."},
    {"type":"h2","text":"Let the kids run it"},
    {"type":"p","text":"A seven-year-old reading 'Thursday: swim, remember goggles' out loud will defend that plan like a border. Ownership is the point. When kids help build the week, the week stops being a set of rules imposed on them and becomes something they helped make."},
    {"type":"p","text":"Do it Sunday evening, same couch, same five minutes. Within a month the Monday-morning scramble quietly disappears — not because anyone got more organized, but because nobody got ambushed."}
  ]$json$::jsonb, true
),
(
  'because-i-said-so-is-a-trap',
  'Why "Because I Said So" Is a Trap (and What to Say Instead)',
  'The nuclear option feels powerful in the moment. It''s also training your kid to need you in the room to make good choices.',
  'Marcus Bennett', '2026-07-11', 6, ARRAY['discipline','communication','child development'], 'Parenting', false, '#7c5dff',
  'https://images.unsplash.com/photo-1476703993599-0035a21b17a9?auto=format&fit=crop&w=1600&q=80',
  'A parent kneeling to talk at eye level with a young child outdoors',
  'Unsplash',
  $json$[
    {"type":"p","text":"''Because I said so'' ends the argument. That's exactly the problem — it ends the argument instead of ending the behavior. Your kid learns that the rule lives in your mouth, not in the world. Take you out of the room and the rule leaves with you."},
    {"type":"h2","text":"The reason IS the lesson"},
    {"type":"p","text":"''Hold my hand in the parking lot because cars can't see someone your height'' teaches a child something they can use in a parking lot you're not standing in. The reason travels. The command doesn't. You're not being soft by explaining — you're installing judgment that keeps working when you're not looking."},
    {"type":"h2","text":"You can be warm and immovable"},
    {"type":"p","text":"Giving a reason is not opening a negotiation. ''We leave now because the movie starts at seven'' is a fact, not a debate. Say it once, warmly, then act. Kids don't actually need you to win the argument; they need the boundary to hold. Reason plus follow-through beats volume every time."},
    {"type":"h2","text":"Save the phrase for real emergencies"},
    {"type":"p","text":"There's a time for instant obedience — a bike swerving toward a road, a hot stove, a stranger's dog. Keep ''do it now, I'll explain after'' in reserve for those moments. It only works as an emergency signal if it isn't your default setting for putting on shoes."},
    {"type":"p","text":"The goal was never a kid who obeys you. It's an adult who makes good calls in a parking lot, at a party, at 2 a.m. in a dorm. Every reason you give now is a small deposit into that account."}
  ]$json$::jsonb, true
),

-- ═══ ORGANIZATION ════════════════════════════════════════════════════════════
(
  'the-one-touch-rule',
  'The One-Touch Rule: How to Stop Living in Piles',
  'Piles aren''t a clutter problem. They''re a decision-deferral problem. Here''s the one habit that dissolves them.',
  'Priya Anand', '2026-07-12', 5, ARRAY['decluttering','habits','home systems'], 'Organization', true, '#3b82f6',
  'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=1600&q=80',
  'A tidy, sunlit entryway with a small tray for keys and mail',
  'Unsplash',
  $json$[
    {"type":"p","text":"Every pile in your house is a stack of postponed decisions wearing a trench coat. The mail on the counter, the coat on the chair, the ''I'll deal with it later'' bin — none of them are messy, exactly. They're just deferred. The One-Touch Rule is the antidote: when a thing enters your hands, it goes to where it lives, not to a temporary purgatory."},
    {"type":"h2","text":"The pile is a tax you pay twice"},
    {"type":"p","text":"You handle the jacket when you take it off (touch one), then again when you finally hang it up (touch two), plus the low-grade guilt every time you walk past it in between. One-touch collapses three costs into one. It feels slightly harder in the moment and dramatically easier by Friday."},
    {"type":"h2","text":"Everything needs an address"},
    {"type":"p","text":"One-touch only works if the ''home'' is closer than the pile. If hanging the coat means a trip upstairs to a jammed closet, the chair wins every time. Put a hook by the door. Put a tray for keys and mail where you actually drop them. Design for the lazy version of yourself; they're the one who shows up on a Tuesday."},
    {"type":"h2","text":"Teach the whole house one sentence"},
    {"type":"p","text":"''Does this have a home?'' is the only decluttering question that matters. If yes, put it there now. If no, that's the real problem — give it one, or let it leave. A family that shares that one sentence keeps a house tidy without anyone becoming the household's full-time janitor."},
    {"type":"p","text":"You will not become a minimalist. You'll just stop paying rent, in attention, on objects that were only ever passing through."}
  ]$json$::jsonb, true
),
(
  'your-junk-drawer-is-a-cry-for-help',
  'Your Junk Drawer Is a Cry for Help: A 20-Minute Reset',
  'The junk drawer isn''t a failure of discipline. It''s a missing category. Give it a job and it stops being junk.',
  'Priya Anand', '2026-07-10', 4, ARRAY['decluttering','quick wins','home systems'], 'Organization', false, '#3b82f6',
  'https://images.unsplash.com/photo-1502086223501-7ea6ecd79368?auto=format&fit=crop&w=1600&q=80',
  'An organized drawer with small dividers holding everyday odds and ends',
  'Unsplash',
  $json$[
    {"type":"p","text":"Every home has one: the drawer where a single AA battery, four takeout menus, a mystery key, and a rubber band walk into a bar. We call it junk, but it's actually the most honest drawer in the house — it holds everything that doesn't have a category yet. Twenty minutes fixes it, and unlike most organizing projects, it stays fixed."},
    {"type":"h2","text":"Dump, don't sort"},
    {"type":"p","text":"Tip the whole thing onto the table. Sorting inside the drawer is how junk drawers survive for a decade — you keep negotiating with the mess instead of confronting it. On a flat surface, in daylight, the truth is obvious: most of it is trash, a little of it is treasure, and three things belong somewhere else entirely."},
    {"type":"h2","text":"The three-pile method"},
    {"type":"p","text":"Trash (dead pens, expired coupons, that lone screw). Belongs-elsewhere (the medicine, the spare charger, the receipt). And actually-useful-here (tape, scissors, the good pen, a working battery). Only the third pile earns a ticket back into the drawer."},
    {"type":"h2","text":"Add dividers, or it comes back"},
    {"type":"p","text":"Loose items in a drawer will always drift back into chaos — physics guarantees it. Cheap dividers or even a few small boxes give each survivor a lane. The junk drawer becomes the utility drawer, which is what it always wanted to be. It just needed you to admit it had a purpose."},
    {"type":"p","text":"Do the same twenty-minute reset on the linen closet, the bathroom cabinet, the car console. Small, bounded, and done in one sitting beats a whole-house overhaul you'll abandon by lunch."}
  ]$json$::jsonb, true
),

-- ═══ SCHOOL & ACTIVITIES ═════════════════════════════════════════════════════
(
  'the-sunday-backpack-ritual',
  'The Sunday Backpack Ritual That Ends Monday-Morning Panic',
  'Monday mornings aren''t chaotic because mornings are hard. They''re chaotic because Sunday didn''t do its job.',
  'Elena Rodriguez', '2026-07-12', 5, ARRAY['school','routines','back to school'], 'School & Activities', true, '#10b981',
  'https://images.unsplash.com/photo-1506784983877-45594efa4cbe?auto=format&fit=crop&w=1600&q=80',
  'A packed backpack and planner laid out on a table the night before',
  'Unsplash',
  $json$[
    {"type":"p","text":"The Monday-morning meltdown — the missing shoe, the unsigned form, the ''I have a project due TODAY?'' — is almost never a Monday problem. It's a Sunday-evening problem that waited until Monday to introduce itself. The fix is a ten-minute ritual, done together, before the week begins."},
    {"type":"h2","text":"Empty the backpack completely"},
    {"type":"p","text":"Every Sunday, dump it out. The bottom of a school backpack is where permission slips go to die and where last week's banana becomes a science experiment. Empty it, and you'll find the field-trip form, the reading log, and the note from the teacher that Monday-you was going to discover in the worst possible way."},
    {"type":"h2","text":"Look forward, not just back"},
    {"type":"p","text":"Backpack out, planner open: what's actually happening this week? A test, a costume day, a permission slip, cleats needed by Wednesday. This is where a shared family calendar earns its keep — the ''special'' days get seen while there's still time to buy the poster board, not at 9 p.m. the night before."},
    {"type":"h2","text":"Stage the launch pad"},
    {"type":"p","text":"Repack the bag, set out Monday's clothes, park everything by the door. A ''launch pad'' — one spot that holds the backpack, the shoes, the water bottle, the signed form — turns a frantic scavenger hunt into a grab-and-go. The morning version of you will weep with gratitude."},
    {"type":"p","text":"Kids can run the entire ritual by age eight. The goal isn't a perfect week — it's a week nobody has to sprint into."}
  ]$json$::jsonb, true
),
(
  'one-passion-one-team',
  'How Many Activities Is Too Many? The "One Passion, One Team" Rule',
  'A calendar packed with enrichment can quietly become a calendar with no room to be a kid. Here''s a simple ceiling.',
  'Elena Rodriguez', '2026-07-09', 6, ARRAY['activities','balance','overscheduling'], 'School & Activities', false, '#10b981',
  'https://images.unsplash.com/photo-1495364141860-b0d03eccd065?auto=format&fit=crop&w=1600&q=80',
  'Kids playing freely in a park at golden hour',
  'Unsplash',
  $json$[
    {"type":"p","text":"Somewhere along the way, ''well-rounded'' turned into ''fully booked.'' Soccer and piano and coding and Kumon and travel ball, all for a nine-year-old whose actual developmental job this year is, in large part, to be bored occasionally and figure out what to do about it. More activities is not more childhood. Sometimes it's less."},
    {"type":"h2","text":"The hidden cost is the drive"},
    {"type":"p","text":"Every activity has a shadow schedule: the drive there, the drive back, the snack eaten in a parking lot, the homework done at a red light. Two activities can quietly consume five evenings. When you count the logistics, the ''enrichment'' often crowds out the dinner table it was supposed to sit beside."},
    {"type":"h2","text":"The one-passion, one-team rule"},
    {"type":"p","text":"A workable ceiling for a lot of families: one thing they love (the passion — an instrument, art, a sport they''d do for free) and one thing that teaches showing up for others (the team). That's two commitments, room to breathe, and still plenty of range. Everything past that, audit hard."},
    {"type":"h2","text":"Protect the empty square"},
    {"type":"p","text":"Guard at least one totally unscheduled afternoon a week like it's an activity itself — because it is. Unstructured time is where kids invent games, get pleasantly bored, and practice being a person without a coach. It doesn't photograph well for the group chat, but it's doing real work."},
    {"type":"p","text":"Ask the kid, not the college brochure: which of these would you be sad to lose? Their answer is usually shorter, and wiser, than your calendar."}
  ]$json$::jsonb, true
),

-- ═══ AI & TECHNOLOGY ═════════════════════════════════════════════════════════
(
  'the-family-group-chat-is-where-plans-die',
  'The Family Group Chat Is Where Plans Go to Die. Here''s the Fix.',
  'A group chat is a great place to say ''dentist Thursday'' and a terrible place for anyone to remember it. The difference matters.',
  'Jessica Miller', '2026-07-11', 6, ARRAY['ai','organization','mental load'], 'AI & Technology', true, '#6366f1',
  'https://images.unsplash.com/photo-1531482615713-2afd69097998?auto=format&fit=crop&w=1600&q=80',
  'A phone showing a busy messaging thread on a kitchen counter',
  'Unsplash',
  $json$[
    {"type":"p","text":"The family group chat is a beautiful liar. It feels like coordination — messages flying, plans forming, thumbs-up raining down. But a chat is a river, not a record. ''Dentist Thursday 3pm'' floats past at 9 a.m. and by dinner it's twelve messages downstream, under a meme and a photo of the dog. Everyone saw it. Nobody kept it."},
    {"type":"h2","text":"Chat is for talking; a system is for remembering"},
    {"type":"p","text":"The core mistake is asking a conversation to also be a database. Conversations are ephemeral by design — that's what makes them feel human. But ''Emma has practice at 5'' needs to become a calendar event with a reminder, not a sentence that scrolls away. The moment a plan is only in the chat, it's already half-forgotten."},
    {"type":"h2","text":"Every message that plans something should end in a record"},
    {"type":"p","text":"This is exactly where an AI family assistant earns its keep: you say the sentence once, and it turns into the thing — an event on the shared calendar, a reminder the night before, an item on the right person's list. The chat stays a chat. The plan becomes a fact. Words become records."},
    {"type":"h2","text":"Keep the chat for what it''s great at"},
    {"type":"p","text":"Don't kill the group chat — it's where the jokes and the ''running late, love you'' live, and those matter. Just stop trusting it with your logistics. Let it be the family's living room and give the schedule its own filing cabinet. The two jobs were never meant to be the same app."},
    {"type":"p","text":"You'll know it worked when nobody says ''wait, when is that again?'' — because the answer stopped living in a river."}
  ]$json$::jsonb, true
),
(
  'screen-time-isnt-the-enemy-screen-drift-is',
  'Screen Time Isn''t the Enemy — "Screen Drift" Is',
  'The number of minutes matters far less than whether anyone chose them. Here''s the distinction that actually helps.',
  'Marcus Bennett', '2026-07-08', 6, ARRAY['screen time','digital wellbeing','parenting'], 'AI & Technology', false, '#6366f1',
  'https://images.unsplash.com/photo-1489710437720-ebb67ec84dd2?auto=format&fit=crop&w=1600&q=80',
  'A child and parent looking at a tablet together on a couch',
  'Unsplash',
  $json$[
    {"type":"p","text":"Parents ask the wrong question about screens: ''how many minutes?'' The better question is ''chosen or drifted?'' Forty-five minutes of a kid building something in a game with friends is a fundamentally different activity than forty-five minutes of autoplay carrying them from clip to clip like a leaf on a stream. Same minutes. Opposite experiences."},
    {"type":"h2","text":"Drift is designed"},
    {"type":"p","text":"Autoplay, infinite scroll, the next-episode countdown — these aren't accidents; they're the product. ''Screen drift'' is what happens when the software makes the next choice for you. The antidote isn't a stopwatch. It's restoring the decision: what are we doing, and when are we done? A chosen forty minutes ends cleanly. A drifted forty minutes never ends at all."},
    {"type":"h2","text":"Trade limits for landings"},
    {"type":"p","text":"Instead of a hard minute cap that triggers a meltdown mid-drift, give screens a landing: ''one more episode, then we cook dinner,'' decided out loud, before the show starts. Kids handle endings they helped set far better than endings that get yanked. You're teaching the skill the apps are built to erode — knowing when you're done."},
    {"type":"h2","text":"Model it, because they''re watching you scroll"},
    {"type":"p","text":"The most powerful screen-time lesson is the one where you put your own phone in a drawer at dinner. Kids don't do what we say about screens; they do what we do with them. Narrate your own landings — ''I'm going to stop scrolling and go for a walk'' — and you've taught more than any parental-controls dashboard ever could."},
    {"type":"p","text":"Aim for intention, not abstinence. A family that chooses its screens, together and out loud, has already won the part that matters."}
  ]$json$::jsonb, true
),

-- ═══ WELLNESS ════════════════════════════════════════════════════════════════
(
  'the-ten-minute-reset',
  'The 10-Minute Reset: A Parent''s Guide to Not Losing It at 6 PM',
  'The witching hour isn''t a character flaw. It''s a predictable energy crash — and predictable things can be planned for.',
  'Dr. Sarah Kim', '2026-07-12', 5, ARRAY['stress','self-care','routines'], 'Wellness', true, '#f59e0b',
  'https://images.unsplash.com/photo-1554224154-26032ffc0d07?auto=format&fit=crop&w=1600&q=80',
  'A parent taking a calm breath by a window with a warm drink',
  'Unsplash',
  $json$[
    {"type":"p","text":"There is a specific hour — call it 6 p.m., though yours may vary — when everyone in the house runs out of gas at once. The kids are hungry and feral, dinner isn't ready, the day's patience is spent, and the smallest thing (a spilled cup, a whined ''I'm booooored'') detonates. This isn't a parenting failure. It's a blood-sugar-and-fatigue collision, and it arrives on schedule."},
    {"type":"h2","text":"Name the hour, defang it"},
    {"type":"p","text":"Half the power of the witching hour is that it feels like a surprise attack. It isn't. Once you can say ''oh, it's the 6 p.m. crash,'' you stop taking it personally and start managing it. Predictable problems are the easy kind — they let you pre-load the fix."},
    {"type":"h2","text":"The pre-emptive snack is not a bribe"},
    {"type":"p","text":"A small protein snack at 5 handed to a hangry child is not spoiling dinner; it's air-traffic control. Half the meltdowns at 6 are just low blood sugar wearing a tantrum costume. Feed the crash before it lands. This goes for the adults too — a handful of nuts for you is cheaper than an apology later."},
    {"type":"h2","text":"Ten minutes of lowered expectations"},
    {"type":"p","text":"During the crash, drop the standards on purpose. Screens are fine for ten minutes. Dinner can be scrambled eggs. Nobody is learning a lesson right now; everyone is just trying to reach bedtime intact. Give yourself a genuine reset — a glass of water, three slow breaths at the sink, one song — and stop trying to win a battle whose only prize is more battle."},
    {"type":"p","text":"You're not a calmer person on the good nights. You just fed the crash before it fed on you."}
  ]$json$::jsonb, true
),
(
  'sleep-is-the-whole-familys-superpower',
  'Sleep Is the Whole Family''s Superpower (and How to Protect It)',
  'Almost every ''behavior problem'' has a quiet co-author, and it''s bedtime. Protect sleep and half the hard days get easier.',
  'Dr. Sarah Kim', '2026-07-09', 6, ARRAY['sleep','wellness','routines'], 'Wellness', false, '#f59e0b',
  'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?auto=format&fit=crop&w=1600&q=80',
  'A cozy, dim bedroom set up for a calm bedtime',
  'Unsplash',
  $json$[
    {"type":"p","text":"If a supplement did for kids what sleep does — steadier moods, sharper focus, fewer meltdowns, a stronger immune system — you'd see it on every morning show. Sleep is that supplement, it's free, and most families are quietly under-dosing the whole household, adults included. The tired parent and the tired kid are usually starring in the same bad evening."},
    {"type":"h2","text":"The problem is rarely bedtime — it''s the hour before it"},
    {"type":"p","text":"You can't sprint from a screen and a bright kitchen straight into sleep; nobody can, at any age. The body needs a runway. A predictable wind-down — lights dimming, screens parked, the same three cozy steps in the same order — signals ''we're landing.'' The routine is the runway. Skip it and you're asking a revved-up brain to slam on the brakes."},
    {"type":"h2","text":"Anchor the wake-up, not just the bedtime"},
    {"type":"p","text":"Here's the counterintuitive part: a consistent wake time does more for sleep than a strict bedtime. Waking at wildly different hours on weekends gives the whole family a low-grade jet lag by Monday. Hold the morning anchor within an hour, even on Saturday, and bedtimes start falling into place on their own."},
    {"type":"h2","text":"Guard it like the appointment it is"},
    {"type":"p","text":"Sleep loses every negotiation because it's silent — nothing dramatic happens when a bedtime slips by twenty minutes, until it's happened forty nights in a row. Put the wind-down on the family calendar with the same weight as soccer or a work call. Protected sleep isn't strict; it's the kindest thing on the schedule."},
    {"type":"p","text":"Fix the sleep first, then look at the ''behavior.'' You'll be surprised how many problems were just fatigue in a trench coat."}
  ]$json$::jsonb, true
),

-- ═══ FAMILY FINANCES ═════════════════════════════════════════════════════════
(
  'should-chores-pay',
  'The Allowance Debate: Should Chores Pay?',
  'Tie money to chores and you might teach ''I only help if paid.'' Skip it and you miss a great money lab. There''s a third way.',
  'David Okafor', '2026-07-11', 6, ARRAY['allowance','money skills','chores'], 'Family Finances', true, '#f43f5e',
  'https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=1600&q=80',
  'A child putting coins into three labeled jars',
  'Unsplash',
  $json$[
    {"type":"p","text":"Every parent eventually hits the allowance fork in the road. Pay for chores, and you risk raising a kid who asks ''how much?'' before helping carry the groceries. Don't pay, and you skip one of the best hands-on money lessons available before adulthood. The good news: the two camps are arguing about a false choice."},
    {"type":"h2","text":"Separate ''membership'' from ''enterprise''"},
    {"type":"p","text":"Some chores are dues — you do them because you live here and this is our home. Making your bed, clearing your plate, feeding the dog: unpaid, non-negotiable, the price of membership. That protects the value ''we help each other'' from becoming a transaction. Nobody pays you to be part of a family."},
    {"type":"h2","text":"Then open the job board"},
    {"type":"p","text":"Above the baseline, offer paid ''enterprise'' work — washing the car, weeding the beds, a big garage sort. These are optional, they pay, and they teach the actual lesson: money comes from creating value someone wanted. A kid who chooses to earn is learning something a mandatory chart never teaches — initiative."},
    {"type":"h2","text":"Make the money visible and divisible"},
    {"type":"p","text":"Whatever they earn, split it the moment it lands: some to spend, some to save toward a real goal, some to give. Three jars, or three buckets in a family wallet, turn an abstract lesson into a physical one. Watching the ''save'' jar crawl toward a wanted thing teaches patience better than any lecture on it."},
    {"type":"p","text":"The debate was never allowance-yes or allowance-no. It's membership for belonging, enterprise for earning — and a kid who learns the difference is ahead of a lot of adults."}
  ]$json$::jsonb, true
),
(
  'the-zero-dollar-family-fun-budget',
  'The $0 Family Fun Budget: 30 Ideas That Cost Nothing',
  'Kids don''t remember the expensive days. They remember the fun ones — and fun is almost never the thing that costs money.',
  'David Okafor', '2026-07-08', 5, ARRAY['budget','family fun','frugal'], 'Family Finances', false, '#f43f5e',
  'https://images.unsplash.com/photo-1560253023-3ec5d502959f?auto=format&fit=crop&w=1600&q=80',
  'A family laughing together during a simple picnic in the backyard',
  'Unsplash',
  $json$[
    {"type":"p","text":"Ask an adult for their happiest childhood memory and you'll almost never hear about a theme park. You'll hear about a blanket fort, a pancake breakfast for dinner, a dad who did a funny voice, a night the power went out and it turned into an adventure. The expensive days blur. The free ones stick. That's not a consolation prize — it's a budgeting superpower."},
    {"type":"h2","text":"Fun is mostly novelty, and novelty is free"},
    {"type":"p","text":"The magic ingredient in a memorable day isn't cost; it's a small break from the ordinary. Breakfast for dinner. A backwards day where you eat dessert first. A living-room camp-out. A flashlight scavenger hunt after dark. Each costs nothing and each does the one thing kids crave — makes an ordinary Tuesday feel special."},
    {"type":"h2","text":"Nature is the original free entertainment"},
    {"type":"p","text":"A creek, a hill to roll down, a puddle after rain, a bug hunt, a bag for collecting ''treasures,'' clouds to name shapes in. Kids are wired to find the outdoors fascinating; we just have to bring them to it and then get out of the way. A two-hour ''expedition'' to the local park outscores most paid attractions."},
    {"type":"h2","text":"Make the free stuff a tradition"},
    {"type":"p","text":"The real trick is repetition. Friday pizza-and-a-movie on the floor. Saturday-morning pancakes. A first-day-of-summer water-balloon fight. When a free thing becomes ''what our family does,'' it stops being a cheap substitute and becomes the actual point — an identity the kids will hand to their own children someday."},
    {"type":"p","text":"Keep a running list on the fridge so ''I'm bored'' has a free answer ready. Thirty ideas that cost nothing will out-memory one that cost three hundred dollars — every single time."}
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
  published         = EXCLUDED.published,
  updated_at        = now();
