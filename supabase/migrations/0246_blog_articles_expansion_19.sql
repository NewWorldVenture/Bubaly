-- FamilyOS :: 0246 Blog articles — expansion batch 19
-- Two per category across all six /blog tabs. Topics vetted against all 236
-- existing slugs. Every hero image is a NEW curl-verified unique Unsplash photo
-- (maintains the 0242 no-duplicate invariant). Honest category alt text.
-- Idempotent ON CONFLICT (slug) DO UPDATE. SEO/AEO, #bubaly hashtags, Bubaly
-- backlink handled in code.

INSERT INTO public.blog_posts
  (slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color,
   hero_image_url, hero_image_alt, hero_image_credit, body, published)
VALUES

-- ═══ PARENTING ═══════════════════════════════════════════════════════════════
(
  'helping-your-kid-make-good-decisions',
  'Helping Your Kid Learn to Make Good Decisions',
  'Decision-making is a muscle, and kids build it only by making real decisions. Letting them choose — and sometimes choose wrong — is how good judgment grows.',
  'Jessica Miller', '2026-05-17', 6, ARRAY['decision making','independence','child development'], 'Parenting', true, '#7c5dff',
  'https://images.unsplash.com/photo-1540479859555-17af45c78602?auto=format&fit=crop&w=1600&q=80',
  'A warm parenting moment in everyday family life', 'Unsplash',
  $json$[
    {"type":"p","text":"One day your kid will face big decisions with no parent there to decide for them — about friends, risks, money, values, their future. Decision-making is a muscle, and like any muscle it only grows through use. The kids who make wise choices as teens and adults are usually the ones who got to practice making real decisions, including poor ones, throughout childhood. Letting them choose is how good judgment is built."},
    {"type":"h2","text":"Give them real choices early"},
    {"type":"p","text":"Start young with age-appropriate decisions: what to wear, which activity, how to spend their allowance, how to solve a small problem. These low-stakes choices are practice reps for the judgment they'll need later. A parent who decides everything raises a kid with no decision-making experience; one who hands over developmentally-appropriate choices raises a kid who's been practicing all along. Widen the scope of their choices as they grow and show they can handle it."},
    {"type":"h2","text":"Let them learn from poor choices"},
    {"type":"p","text":"The most valuable decision-making lessons often come from decisions that don't work out. When a kid makes a safe-but-poor choice and experiences the natural result, they learn more than any lecture teaches. Resist rescuing them from every mistake or saying ''I told you so.'' The kid who spent their money unwisely, or chose the activity that flopped, is learning real judgment. Safe failures now build the wisdom to make big decisions well later."},
    {"type":"h2","text":"Teach a decision-making process"},
    {"type":"p","text":"Beyond just letting them choose, coach the how: identifying options, weighing pros and cons, considering consequences, checking it against their values, and reflecting afterward on how it went. Talking through decisions together (''what are your choices? what might happen with each?'') gives kids a repeatable framework for thinking things through rather than acting on impulse. A kid armed with a decision process, and practice using it, is equipped for the choices that really matter."},
    {"type":"p","text":"Your kid will face big decisions alone someday, and good judgment is built through practice. Give them real choices early, let them learn from the poor ones, and teach a decision-making process — and you'll raise someone equipped to choose wisely when it counts and you're not there."}
  ]$json$::jsonb, true
),
(
  'the-magic-words-that-defuse-a-power-struggle',
  'The Magic Words That Defuse a Power Struggle',
  'When a kid digs in and a battle looms, the instinct is to push harder. A few simple phrase-shifts sidestep the struggle entirely — giving control without giving in.',
  'Marcus Bennett', '2026-05-16', 5, ARRAY['discipline','communication','child development'], 'Parenting', false, '#7c5dff',
  'https://images.unsplash.com/photo-1541519227354-08fa5d50c44d?auto=format&fit=crop&w=1600&q=80',
  'A warm parenting moment in everyday family life', 'Unsplash',
  $json$[
    {"type":"p","text":"You know the moment: your kid digs in, you dig in, and a full power struggle looms over shoes, screens, or bedtime. The instinct is to push harder and assert authority — which usually escalates the battle. But a few simple shifts in how you phrase things can sidestep the struggle entirely, giving a kid a sense of control without you giving in on what matters. These small verbal moves defuse an astonishing number of battles."},
    {"type":"h2","text":"Offer choices within the boundary"},
    {"type":"p","text":"The most powerful move is offering choices inside a non-negotiable limit. Instead of ''put your shoes on now'' (a command to resist), try ''do you want to put on the red shoes or the blue ones?'' Bedtime is happening either way, but ''do you want two books or one before bed?'' hands the kid control over the how. Most power struggles are really about a kid's need for autonomy; give them real choices within your boundary and the fight evaporates."},
    {"type":"h2","text":"''When...then'' beats ''no, until''"},
    {"type":"p","text":"How you frame a condition changes everything. ''You can't play until you clean up'' invites resistance; ''When your toys are away, then you can play'' states the same thing as a positive sequence the kid can act on. This ''first this, then that'' framing feels less like a threat and more like a simple order of operations, and kids comply with it far more readily. A small reword turns a standoff into a clear path forward."},
    {"type":"h2","text":"Sidestep the fight with collaboration and play"},
    {"type":"p","text":"Other magic moves: turning a task into a game or a challenge (''I bet you can't get dressed before I count to twenty!''), inviting collaboration (''what's your plan for getting this done?''), or simply acknowledging their feeling before the boundary (''I know you don't want to stop — and it's time to go''). Each sidesteps the head-to-head battle by engaging the kid rather than commanding them. You keep the boundary; you just skip the war."},
    {"type":"p","text":"Power struggles usually come from a kid's need for control, so the way out is giving control without giving in. Offer choices within the boundary, use ''when-then'' framing, and lean on play and collaboration — and you'll defuse the battles before they start, holding your limits while skipping the fight."}
  ]$json$::jsonb, true
),

-- ═══ ORGANIZATION ════════════════════════════════════════════════════════════
(
  'the-one-minute-rule',
  'The One-Minute Rule: The Tiny Habit That Prevents Clutter',
  'Most clutter and chaos is just postponed one-minute tasks piling up. A single rule — if it takes under a minute, do it now — quietly keeps a home in order.',
  'Priya Anand', '2026-05-17', 4, ARRAY['home systems','habits','decluttering'], 'Organization', true, '#3b82f6',
  'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?auto=format&fit=crop&w=1600&q=80',
  'A calm, organized home scene', 'Unsplash',
  $json$[
    {"type":"p","text":"So much household clutter and chaos is really just a pile of tiny postponed tasks — the coat not hung, the dish not rinsed, the mail not sorted, the wrapper not tossed. Each would take under a minute, but deferred and multiplied, they become the mess that overwhelms a home. The One-Minute Rule is the disarmingly simple antidote: if a task takes less than a minute, do it right now, not later."},
    {"type":"h2","text":"Small tasks, done now, never pile up"},
    {"type":"p","text":"The rule's power is in prevention. Hanging the coat, wiping the counter, putting the shoe away, replying to the quick message — each takes seconds, and doing it immediately means it never joins the pile that later demands a big cleanup. The mess in most homes isn't from big messes; it's from an accumulation of tiny undone things. Handle each the moment it arises, and the accumulation simply never happens."},
    {"type":"h2","text":"It beats the deferral tax"},
    {"type":"p","text":"Deferring a one-minute task actually costs more than doing it. You pay to remember it, to see it nagging at you, and often to handle it later as part of a bigger dreaded cleanup — plus the low-grade mental weight in between. Doing it now, in the under-a-minute it takes, collapses all those costs into one. The One-Minute Rule feels slightly harder in each moment and dramatically easier across the day and week."},
    {"type":"h2","text":"Make it automatic, and teach it"},
    {"type":"p","text":"The rule works best as an ingrained reflex: catch yourself about to defer something quick, and instead just do it. With practice it becomes automatic, and your home stays in order almost effortlessly. It's also a wonderfully teachable habit for kids — ''if it takes less than a minute, do it now'' is simple enough for a child to adopt, turning the whole family into people who handle small things immediately rather than letting them pile up."},
    {"type":"p","text":"Most clutter is just one-minute tasks postponed and multiplied. Adopt the One-Minute Rule — if it takes under a minute, do it now — make it automatic, and teach it to the family, and you'll keep your home in order through tiny immediate actions instead of dreaded big cleanups."}
  ]$json$::jsonb, true
),
(
  'getting-organized-before-a-new-baby',
  'Getting Organized Before a New Baby Arrives',
  'A newborn upends everything, and the exhausted early weeks are no time to build systems. A little organizing before the baby comes pays off enormously after.',
  'Priya Anand', '2026-05-15', 5, ARRAY['organizing','new baby','home systems'], 'Organization', false, '#3b82f6',
  'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=1600&q=80',
  'A calm, organized home scene', 'Unsplash',
  $json$[
    {"type":"p","text":"A newborn upends everything — sleep, schedules, and any semblance of order — and the exhausted, foggy early weeks are absolutely not the time to be building household systems or hunting for things. A little organizing before the baby arrives, while you still have energy and time, pays off enormously in those overwhelming first months. Preparing your home and systems in advance is a gift to the sleep-deprived version of you that's coming."},
    {"type":"h2","text":"Set up the baby zones"},
    {"type":"p","text":"Organize the practical baby stations before you need them at 3 a.m. A well-stocked, logically arranged changing area; a feeding station with everything within reach; organized clothes sorted by size; a clear system for the gear. When you're exhausted and holding a crying newborn, having everything in a known, reachable place rather than scattered and unsorted makes an enormous difference. Set these zones up calmly now so they just work later."},
    {"type":"h2","text":"Simplify and stock the rest of the house"},
    {"type":"p","text":"Beyond the baby's things, prepare the whole household for a period of low capacity. Declutter and simplify so there's less to maintain, stock up on essentials and household supplies, and — hugely — fill the freezer with make-ahead meals so nobody has to cook from scratch in the early weeks. Getting ahead on the ordinary running of the home means the newborn chaos lands on a house that's already stocked, simplified, and ready to coast."},
    {"type":"h2","text":"Set up systems and support"},
    {"type":"p","text":"Prepare the systems and help you'll lean on: a plan for how tasks and night duties will be shared, a simple way to track feedings or appointments if you want one, and — critically — lined-up support (family, friends, meal trains, help you've arranged). The early weeks go far better when you've thought through who does what and accepted help in advance, rather than trying to figure it all out while running on no sleep."},
    {"type":"p","text":"A newborn's arrival is no time to build systems from scratch. Set up the baby zones, simplify and stock the whole house, and arrange your systems and support before the baby comes — and you'll hand the exhausted early-weeks version of yourself a home that's ready, so you can focus on the baby instead of the chaos."}
  ]$json$::jsonb, true
),

-- ═══ SCHOOL & ACTIVITIES ═════════════════════════════════════════════════════
(
  'helping-your-kid-build-focus',
  'Helping Your Kid Build Focus in a Distracted World',
  'Attention is a skill, and the modern world is actively eroding it. Deliberately helping kids build focus may be one of the most important things you can do.',
  'Elena Rodriguez', '2026-05-17', 6, ARRAY['school','focus','learning'], 'School & Activities', true, '#10b981',
  'https://images.unsplash.com/photo-1545205597-3d9d02c29597?auto=format&fit=crop&w=1600&q=80',
  'A school and learning moment', 'Unsplash',
  $json$[
    {"type":"p","text":"The ability to focus — to sustain attention on one thing, resist distraction, and think deeply — underlies almost all learning and achievement. And the modern world, engineered for constant interruption and instant stimulation, is actively eroding it in kids (and adults). Deliberately helping your child build focus and attention may be one of the most important and countercultural things you can do for their success and wellbeing. It's a skill, and skills can be strengthened."},
    {"type":"h2","text":"Protect against the attention-eroders"},
    {"type":"p","text":"The first step is defensive: reducing the constant stimulation that trains a brain to crave distraction. Fast-paced media, notification-filled devices, and endless entertainment can shorten attention spans and make focused work feel unbearable by comparison. Limiting the highly-stimulating stuff, protecting quieter downtime, and not letting a kid's brain get accustomed to constant novelty preserves their capacity for deep attention. You're guarding the focus muscle from the things that atrophy it."},
    {"type":"h2","text":"Give focus room to grow"},
    {"type":"p","text":"Attention builds through activities that require and reward sustained focus — reading, building, puzzles, art, deep imaginative play, absorbing hobbies, practicing a skill. The more a kid engages in these single-focus, screen-free pursuits, the stronger their concentration grows. Even boredom helps, forcing the mind to settle and engage. Providing plenty of opportunity and time for this kind of focused engagement, rather than filling every moment with passive stimulation, is how the muscle develops."},
    {"type":"h2","text":"Set up the environment and the habits"},
    {"type":"p","text":"Support focus with the right conditions: a distraction-free space for homework and focused work (phone elsewhere), single-tasking rather than multitasking, and realistic expectations for their age. Teach simple focus habits — working in focused bursts, taking real breaks, minimizing interruptions. And mind the basics that underpin attention: sleep, movement, and nutrition all dramatically affect a kid's ability to concentrate. A rested, well-fed kid in a distraction-free setting can focus in ways a depleted, distracted one can't."},
    {"type":"p","text":"Focus is a foundational skill the modern world is eroding. Protect kids from the attention-destroyers, give them room for deep focused activities, and set up the environment and habits that support concentration — and you'll help your child build the deep attention that underlies real learning and achievement."}
  ]$json$::jsonb, true
),
(
  'the-case-for-arts-education',
  'The Case for Arts Education (Even When Schools Cut It)',
  'Art, music, drama, and dance are often first on the chopping block — dismissed as extras. But the arts build skills and capacities nothing else can, and kids need them.',
  'Elena Rodriguez', '2026-05-15', 6, ARRAY['arts','learning','creativity'], 'School & Activities', false, '#10b981',
  'https://images.unsplash.com/photo-1546015720-b8b30df5aa27?auto=format&fit=crop&w=1600&q=80',
  'A school and learning moment', 'Unsplash',
  $json$[
    {"type":"p","text":"When budgets tighten, the arts — music, visual art, drama, dance — are often first on the chopping block, dismissed as frills next to the ''real'' subjects. But this badly undervalues what the arts do for kids. Arts education builds skills, capacities, and joy that nothing else replicates, and children need it — whether their school provides it or you seek it out yourself. The arts aren't extras; they're a core part of a full education."},
    {"type":"h2","text":"The arts build transferable skills"},
    {"type":"p","text":"Beyond their own value, the arts develop capacities that transfer everywhere: creativity and innovative thinking, discipline and practice, problem-solving, focus, fine motor skills, and the confidence of self-expression and performance. Learning an instrument, creating art, or acting in a play teaches persistence, iteration, and how to bring an idea into being — skills that serve kids in every field. Research repeatedly links arts involvement to broader academic and developmental benefits. The ''frill'' is actually foundational."},
    {"type":"h2","text":"A vital outlet for expression"},
    {"type":"p","text":"The arts give kids something the core academic subjects can't: a means to express, process, and explore their inner world and emotions. For many children, art or music or drama is where they find their voice, work through feelings, and experience the deep satisfaction of creating. This emotional and expressive dimension is genuinely important for wellbeing and identity. A kid without any creative outlet is missing a vital channel for being fully themselves."},
    {"type":"h2","text":"Seek it out if school won''t provide it"},
    {"type":"p","text":"If your child's school has cut the arts, you can still ensure they get this education — through community classes, lessons, arts programs, or simply making creativity a valued part of home life with supplies, instruments, and encouragement. And where you can, advocate for the arts in your school. However you provide it, giving kids access to creative, artistic experiences is worth the effort. Don't let a budget line deprive your child of what the arts uniquely offer."},
    {"type":"p","text":"The arts are often dismissed as extras and cut first, but they build transferable skills, provide a vital outlet for expression, and bring genuine joy. Whether through school or your own efforts, make sure your kid gets arts education — it's a core part of raising a whole, capable, expressive person."}
  ]$json$::jsonb, true
),

-- ═══ AI & TECHNOLOGY ═════════════════════════════════════════════════════════
(
  'setting-up-parental-controls-that-work',
  'Setting Up Parental Controls That Actually Work',
  'Parental controls are powerful but imperfect — and useless if set up wrong or relied on alone. Here''s how to use them as one layer of a bigger strategy.',
  'Jessica Miller', '2026-05-17', 6, ARRAY['ai','safety','screen time'], 'AI & Technology', true, '#6366f1',
  'https://images.unsplash.com/photo-1547082299-de196ea013d6?auto=format&fit=crop&w=1600&q=80',
  'A family navigating technology together', 'Unsplash',
  $json$[
    {"type":"p","text":"Parental controls — the filters, time limits, and monitoring tools built into devices, apps, and networks — are genuinely useful for keeping kids safer online. But they're also imperfect, easily misconfigured, and dangerous to rely on as your only defense. Used well, as one layer within a bigger strategy of conversation and trust, they're valuable. Used as a set-and-forget substitute for engagement, they give false comfort. Here's how to make them actually work."},
    {"type":"h2","text":"Set them up thoughtfully, on every layer"},
    {"type":"p","text":"Parental controls exist at multiple levels — the device, the operating system, individual apps, your home network, and dedicated family-safety tools — and they work best in combination. Take the time to configure them properly for your child's age: content filters, screen-time limits, app restrictions, safe-search, and privacy settings. A thoughtfully layered setup catches far more than any single control. Many families underuse the powerful tools already built into the devices they own; it's worth learning them."},
    {"type":"h2","text":"They''re a tool, not a guarantee"},
    {"type":"p","text":"The critical mindset: no parental control is foolproof. Kids find workarounds, filters miss things, and tools fail. Treating controls as an impenetrable wall breeds a false security that's more dangerous than no controls at all, because it replaces vigilance. Think of them as one helpful layer — a seatbelt, not a force field — that reduces risk while you stay engaged. They buy safety margin; they don't remove the need for your involvement."},
    {"type":"h2","text":"Pair controls with conversation and trust"},
    {"type":"p","text":"The most important complement to any control is an open relationship. Talk with your kids about why the controls exist (safety, not distrust), teach them to navigate the online world wisely, and make it safe for them to come to you about anything they encounter. As kids grow and demonstrate responsibility, controls should loosen, shifting from external restriction toward internalized judgment. The goal isn't a permanently locked-down kid; it's one who learns to make good choices, with controls as training wheels along the way."},
    {"type":"p","text":"Parental controls are a valuable layer, not a complete solution. Set them up thoughtfully across every level, treat them as a tool rather than a guarantee, and pair them with real conversation and trust — and they'll genuinely help keep your kids safer while you raise them toward their own good judgment."}
  ]$json$::jsonb, true
),
(
  'when-your-kid-sees-something-bad-online',
  'When Your Kid Sees Something They Shouldn''t Online',
  'Despite every precaution, most kids will eventually encounter something disturbing online. How you respond in that moment matters more than the exposure itself.',
  'Marcus Bennett', '2026-05-15', 6, ARRAY['ai','safety','emotional health'], 'AI & Technology', false, '#6366f1',
  'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=1600&q=80',
  'A family navigating technology together', 'Unsplash',
  $json$[
    {"type":"p","text":"Here's a hard reality no parent likes to face: despite filters, controls, and best efforts, most kids will eventually stumble onto something disturbing online — violent, scary, sexual, or otherwise inappropriate content. It's almost inevitable in a connected childhood. What matters most isn't preventing every exposure (impossible), but how you respond when it happens. Your reaction in that moment shapes whether your kid is harmed or supported, and whether they'll come to you next time."},
    {"type":"h2","text":"Make it safe to tell you"},
    {"type":"p","text":"The single most important thing is that your kid feels safe coming to you when they see something upsetting — before it happens. If they fear punishment (losing the device) or an overreaction, they'll hide it and process the disturbing content alone. Establish clearly and often: ''If you ever see something online that scares or confuses you, tell me right away — you won't be in trouble.'' A kid who trusts they can tell you is a kid you can actually help."},
    {"type":"h2","text":"Stay calm and reassuring"},
    {"type":"p","text":"When your child does come to you (or you discover it), your calm matters enormously. A panicked, angry, or shaming reaction teaches them it was a catastrophe and that telling you was a mistake. Instead, stay steady and reassuring: thank them for telling you, let them know they did nothing wrong, and help them feel safe. Your composed, supportive response helps a child process a disturbing experience rather than being traumatized by it — and keeps the door open for the future."},
    {"type":"h2","text":"Help them process and move forward"},
    {"type":"p","text":"Talk through what they saw at their level — answer questions honestly, correct misunderstandings, and help them make sense of it without dwelling or over-explaining. Reassure them, provide context appropriate to their age, and watch for lingering distress. Use it as a gentle learning moment about the online world and how to handle such things (closing it, telling you). The goal is a child who feels supported and equipped, not scared and alone, and who knows what to do if it happens again."},
    {"type":"p","text":"Most kids will eventually see something they shouldn't online — it's nearly unavoidable. Make it safe for them to tell you, respond with calm reassurance rather than panic, and help them process and move forward — and you'll turn an inevitable exposure into a moment of support and learning rather than harm."}
  ]$json$::jsonb, true
),

-- ═══ WELLNESS ════════════════════════════════════════════════════════════════
(
  'teaching-kids-positive-self-talk',
  'Teaching Kids Positive Self-Talk: The Inner Voice That Lasts',
  'The way kids learn to talk to themselves becomes the inner voice they carry for life. Helping them build a kinder, more resilient self-talk is a profound gift.',
  'Dr. Sarah Kim', '2026-05-17', 6, ARRAY['self-esteem','emotional health','wellness'], 'Wellness', true, '#f59e0b',
  'https://images.unsplash.com/photo-1549488344-1f9b8d2bd1f3?auto=format&fit=crop&w=1600&q=80',
  'A calm family-wellbeing moment', 'Unsplash',
  $json$[
    {"type":"p","text":"Every kid develops an inner voice — the running self-talk that narrates their experience, and that becomes, over a lifetime, either a harsh inner critic or a supportive inner ally. The way children learn to talk to themselves in childhood tends to stick for life, shaping their confidence, resilience, and mental health. Helping kids build a kinder, more constructive inner voice is one of the most profound and lasting gifts a parent can give."},
    {"type":"h2","text":"Notice the inner critic"},
    {"type":"p","text":"Kids absorb self-talk patterns young, and negative ones can take root early — ''I'm stupid,'' ''I can't do anything right,'' ''I always mess up.'' Listen for how your child talks about themselves, especially after failures or frustrations. When you hear harsh self-talk, gently challenge it: ''That's your inner critic talking. Is that really true? What would you say to a friend who felt that way?'' Bringing awareness to the inner voice is the first step to reshaping it."},
    {"type":"h2","text":"Model and reframe"},
    {"type":"p","text":"Kids learn self-talk largely from hearing yours. When you narrate your own kind, resilient inner voice out loud — ''this is hard, but I can figure it out,'' ''I made a mistake, and that's okay, I'll try again'' — you model the tone you want them to internalize. And help them reframe: turning ''I can't do this'' into ''I can't do this yet,'' a harsh judgment into a kinder truth. Over time, this coaching reshapes the automatic voice in their head."},
    {"type":"h2","text":"Balance kindness with realism"},
    {"type":"p","text":"Positive self-talk isn't empty cheerleading or denying difficulty — it's realistic and compassionate. The goal isn't a kid who thinks ''I'm the best at everything,'' but one who can face a setback with ''that was hard and I struggled, and I can learn and keep going.'' Teaching self-compassion — treating oneself with the kindness you'd offer a friend, especially when failing — builds genuine resilience. A kind but honest inner voice is what carries a person through life's inevitable difficulties."},
    {"type":"p","text":"The inner voice a kid builds in childhood becomes the one they carry for life. Notice the inner critic, model and reframe toward kindness, and balance compassion with realism — and you'll help your child grow a supportive inner ally instead of a harsh critic, a gift that shapes their confidence and resilience for decades."}
  ]$json$::jsonb, true
),
(
  'why-parents-need-friends-too',
  'Why Parents Need Friends Too',
  'In the all-consuming years of raising kids, parents'' own friendships quietly wither. But a parent''s social wellbeing isn''t a luxury — it''s part of a healthy family.',
  'Dr. Sarah Kim', '2026-05-15', 5, ARRAY['self-care','mental health','wellness'], 'Wellness', false, '#f59e0b',
  'https://images.unsplash.com/photo-1550345332-09e3ac987658?auto=format&fit=crop&w=1600&q=80',
  'A calm family-wellbeing moment', 'Unsplash',
  $json$[
    {"type":"p","text":"In the all-consuming years of raising kids, one thing quietly withers for many parents: their own friendships. Between work, childcare, and exhaustion, adult friendships slide to the bottom of the priority list and slowly fade. But a parent's social connection isn't a luxury to feel guilty about — it's a genuine part of a healthy person and, by extension, a healthy family. Parents need friends too, and it matters more than it seems."},
    {"type":"h2","text":"Isolation takes a real toll"},
    {"type":"p","text":"Humans are wired for connection, and parents who become socially isolated pay a real price — higher stress, loneliness, and greater risk of depression and burnout. The intense demands of parenting can quietly cut adults off from the friendships that sustain them, leaving them depleted and alone even in a full house. Recognizing that your own social wellbeing genuinely matters — that friendship is a need, not a frivolity — is the first step to protecting it."},
    {"type":"h2","text":"Friends refill the parent"},
    {"type":"p","text":"Friendships give parents things nothing else does: adult connection and conversation, support and perspective from people who understand, laughter, and a sense of self beyond the parenting role. A parent with a supportive social circle is more resilient, less lonely, and better resourced to handle the demands of family life. You can't pour endlessly from an empty cup, and friendship is one of the things that refills it. Tending your friendships makes you a better, steadier parent."},
    {"type":"h2","text":"Make it a priority, imperfectly"},
    {"type":"p","text":"Maintaining friendships as a busy parent takes intention, because it won't happen by default. Make some effort to stay connected — a regular call, an occasional get-together, friendships with other parents that fit into family life, or simply not canceling the rare plans you make. It won't look like your pre-kid social life, and that's fine; even modest, consistent connection matters. And model for your kids that friendship and self-care remain important throughout life, not just in childhood."},
    {"type":"p","text":"In the busy years of raising kids, parents' friendships quietly fade — but social connection isn't a luxury, it's part of being a healthy person and parent. Recognize that isolation takes a toll, that friends refill you, and make connection a priority, imperfectly — for your own wellbeing and your family's."}
  ]$json$::jsonb, true
),

-- ═══ FAMILY FINANCES ═════════════════════════════════════════════════════════
(
  'defining-your-familys-money-values',
  'Defining Your Family''s Money Values',
  'Most families never talk about what money is actually for. Naming your money values — as parents and together — gives every financial decision a compass.',
  'David Okafor', '2026-05-17', 6, ARRAY['money mindset','values','family finances'], 'Family Finances', true, '#f43f5e',
  'https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=1600&q=80',
  'A family money and planning scene', 'Unsplash',
  $json$[
    {"type":"p","text":"Most families manage money reactively, decision by decision, without ever stepping back to ask the bigger question: what is money actually for, in our family? Defining your money values — the principles and priorities that guide how you earn, spend, save, and give — gives every financial decision a compass. It turns money from a source of stress and conflict into a tool aligned with what your family genuinely cares about."},
    {"type":"h2","text":"Values make decisions easier"},
    {"type":"p","text":"When you're clear on your money values, countless decisions get simpler. If you value experiences over things, security over status, generosity, or family time, that clarity guides spending and cuts through the noise of what everyone else is doing. Instead of agonizing over each purchase or being swayed by comparison and marketing, you can ask ''does this fit our values?'' A defined set of priorities is a filter that makes financial choices clearer and more consistent."},
    {"type":"h2","text":"Get aligned as partners first"},
    {"type":"p","text":"Money conflict between partners often stems from unspoken, mismatched values — one values saving and security, the other experiences or generosity, and they clash without understanding why. Talking through your individual money values and aligning on shared family ones prevents a huge amount of friction. When both partners understand what each other cares about and agree on the family's financial priorities, money becomes a shared project rather than a battleground. This conversation is worth having explicitly."},
    {"type":"h2","text":"Pass the values to your kids"},
    {"type":"p","text":"Kids absorb money values from how the family operates, so being intentional about them shapes your children's financial character. When your family clearly values and demonstrates things like living within your means, generosity, thoughtful spending, or saving for goals, kids internalize those principles. Talking openly about your money values, and living them visibly, hands your children a financial compass of their own — one that will guide them long after they leave home."},
    {"type":"p","text":"Most families never define what money is for, and drift decision by decision. Naming your money values gives every choice a compass, aligns you as partners, and passes a financial character to your kids. Have the conversation, and let your values — not comparison or impulse — guide your family's money."}
  ]$json$::jsonb, true
),
(
  'raising-kids-who-arent-wasteful',
  'Raising Kids Who Aren''t Wasteful',
  'In a world of abundance and disposability, wastefulness is the default. Teaching kids to value and not waste resources builds both financial sense and character.',
  'David Okafor', '2026-05-15', 5, ARRAY['money skills','values','sustainability'], 'Family Finances', false, '#f43f5e',
  'https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=1600&q=80',
  'A family money and planning scene', 'Unsplash',
  $json$[
    {"type":"p","text":"Modern kids grow up amid abundance and disposability — food that gets tossed, things bought and forgotten, a general sense that there's always more where that came from. In this environment, wastefulness is the default, and it costs families money and teaches kids to devalue resources. Teaching children not to be wasteful — to value, use, and not squander what they have — builds both practical financial sense and genuine character."},
    {"type":"h2","text":"Waste is invisible money"},
    {"type":"p","text":"A huge amount of household money leaks out as waste — food thrown away, things bought and unused, resources squandered through carelessness. Helping kids see this connection (that the wasted food or the forgotten purchase is real money in the trash) teaches an important financial lesson. When kids understand that not wasting is essentially the same as saving, and see how it adds up, they start to value resources rather than treating them as endlessly disposable. Frugality and anti-waste are two sides of one coin."},
    {"type":"h2","text":"Teach valuing and using fully"},
    {"type":"p","text":"Raising non-wasteful kids is largely about teaching them to value and fully use what they have: finishing food rather than tossing it, taking care of belongings so they last, using things up before buying more, and appreciating rather than always craving the next thing. These habits, modeled and gently taught, counter the disposable mindset. A kid who's learned to value and care for their possessions and resources wastes far less, saving money and developing a genuine appreciation for what they have."},
    {"type":"h2","text":"Model it and connect it to bigger values"},
    {"type":"p","text":"Kids learn anti-waste habits mostly by watching, so model valuing resources yourself — not wasting food, taking care of things, being thoughtful about consumption. And you can connect not-wasting to bigger values many kids care about: caring for the planet, gratitude for what we have, and consideration for those with less. Framing anti-waste as part of being a responsible, grateful, considerate person gives it meaning beyond money, and helps it take root as genuine character."},
    {"type":"p","text":"In a world of abundance and disposability, wastefulness is the default and it costs real money. Teach kids that waste is invisible money, help them value and fully use what they have, and model it while connecting it to bigger values — and you'll raise children with both financial sense and the character to not squander what they're given."}
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
