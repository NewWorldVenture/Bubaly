-- FamilyOS :: 0230 Blog articles — expansion batch 5
-- ----------------------------------------------------------------------------
-- Fifth wave of original, editorially-voiced articles for public.blog_posts,
-- two per category across all six topics, matching the established format
-- (JSONB body blocks, production-verified free Unsplash hero images, tags,
-- accent color). Idempotent: ON CONFLICT (slug) DO UPDATE. SEO/AEO handled in
-- code (lib/blog/structured-data.ts); sitemap lists all slugs automatically.

INSERT INTO public.blog_posts
  (slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color,
   hero_image_url, hero_image_alt, hero_image_credit, body, published)
VALUES

-- ═══ PARENTING ═══════════════════════════════════════════════════════════════
(
  'the-special-time-ritual',
  'Special Time: The 10 Minutes That Fix Most Behavior Problems',
  'A surprising amount of ''acting out'' is a bid for connection. Ten minutes of undivided, child-led attention is a stronger tool than any consequence.',
  'Jessica Miller', '2026-06-28', 6, ARRAY['connection','discipline','child development'], 'Parenting', true, '#7c5dff',
  'https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?auto=format&fit=crop&w=1600&q=80',
  'A parent giving a child full attention at a table',
  'Unsplash',
  $json$[
    {"type":"p","text":"When a kid is whining, clinging, or melting down over nothing, the behavior is often a message we're misreading: the tank of connection is running low, and negative attention beats no attention. Before you reach for a consequence, try the counterintuitive fix — pour connection in. The tool is called Special Time, and ten minutes of it can defuse behavior that hours of correction can't."},
    {"type":"h2","text":"What makes it ''special''"},
    {"type":"p","text":"Special Time has strict, simple rules: a set amount (even ten minutes), the child leads, and you follow — no correcting, no teaching, no phone. If they want to play the game wrong, you play it wrong. You narrate what they're doing with warm interest and let them steer completely. In a life where adults direct almost everything, that reversal is powerful, and kids can feel the difference immediately."},
    {"type":"h2","text":"Why it works better than consequences"},
    {"type":"p","text":"A lot of misbehavior is a child testing whether they still matter, whether the connection is secure. Special Time answers that question with an emphatic yes, before the testing escalates. A connected kid has far less need to act out to get your eyes on them. You're not rewarding bad behavior; you're removing the reason for it — filling the tank so it stops running dry."},
    {"type":"h2","text":"Protect it, even when they don''t ''deserve'' it"},
    {"type":"p","text":"The hardest and most important part: Special Time isn't a reward to be revoked on a bad day — it's a need, and it's needed most on the hard days. Keep it sacred, ideally daily, no matter what. A predictable island of undivided attention that can't be lost gives a kid a security that steadies everything else. It's the opposite of ''be good and then I'll pay attention.''"},
    {"type":"p","text":"Ten minutes, child-led, no phone, every day. It's a tiny investment against a huge amount of behavior — and it's the rare parenting tool that gets easier the more you use it."}
  ]$json$::jsonb, true
),
(
  'let-natural-consequences-teach',
  'Let Natural Consequences Do the Teaching (You Don''t Have To)',
  'You can lecture a kid about the forgotten jacket, or you can let the cold morning do it. One of these actually changes behavior.',
  'Marcus Bennett', '2026-06-27', 5, ARRAY['discipline','responsibility','child development'], 'Parenting', false, '#7c5dff',
  'https://images.unsplash.com/photo-1476703993599-0035a21b17a9?auto=format&fit=crop&w=1600&q=80',
  'A parent calmly watching a child learn from experience',
  'Unsplash',
  $json$[
    {"type":"p","text":"Your kid refuses to wear a jacket. You can fight about it, nag about it, and end up carrying the jacket yourself — or you can let them walk out without it and discover, personally, that mornings are cold. The second path feels like doing nothing. It's actually letting the most effective teacher there is do the lesson: reality, delivered without a single word from you."},
    {"type":"h2","text":"Reality is more convincing than a lecture"},
    {"type":"p","text":"A natural consequence is what happens on its own when a kid makes a choice — cold without a jacket, hungry after skipping the packed lunch, a toy left out that gets stepped on. These lessons stick precisely because they aren't imposed by a parent to argue with. There's no ''you're being unfair'' when the consequence is simply how the world works. The kid connects cause and effect themselves, and that connection is the whole point."},
    {"type":"h2","text":"Your job is to get out of the way"},
    {"type":"p","text":"The hard part isn't the technique; it's your own urge to rescue. Every instinct says to hand over the jacket, remind them ten more times, save them from the small discomfort. But rescuing erases the lesson. As long as it's safe, stepping back and letting the consequence land — without an ''I told you so'' — is often the most useful thing a parent can do. The restraint is the parenting."},
    {"type":"h2","text":"Know the limits"},
    {"type":"p","text":"Natural consequences are a tool, not a doctrine. They don't apply when the outcome is dangerous, when it hurts someone else, or when it's too far off for a young kid to connect (you don't let a five-year-old ''learn'' about traffic). For those, you set firm limits. Save natural consequences for the low-stakes stuff — the jacket, the homework, the forgotten cleats — where a little discomfort is a cheap, unforgettable teacher."},
    {"type":"p","text":"You don't have to win every argument or teach every lesson yourself. Sometimes the kindest, most effective move is to step back and let a cold morning make your point for you."}
  ]$json$::jsonb, true
),

-- ═══ ORGANIZATION ════════════════════════════════════════════════════════════
(
  'taming-the-paper-pile',
  'Taming the Paper Pile: A System for Mail, School Forms, and Documents',
  'Paper is the clutter that breeds fastest and matters most — miss one form and there''s a real cost. Here''s a system that catches it all.',
  'Priya Anand', '2026-06-28', 5, ARRAY['home systems','organizing','paperwork'], 'Organization', true, '#3b82f6',
  'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=1600&q=80',
  'A tidy entryway with a sorted tray for incoming mail and papers',
  'Unsplash',
  $json$[
    {"type":"p","text":"Paper is a special kind of clutter: it arrives daily, unbidden, in a relentless stream of mail, school forms, receipts, and flyers — and unlike a stray toy, a missed piece can cost you. A permission slip that vanishes, a bill that goes unpaid, a form due yesterday. Most homes have no system for it, so it collects in a doom pile on the counter. A simple flow fixes that for good."},
    {"type":"h2","text":"Handle it once, at the door"},
    {"type":"p","text":"The single biggest fix is to process paper the moment it enters, standing over the recycling bin. The vast majority — junk mail, flyers, catalogs — is trash and should never touch a surface. Sorting at the door, immediately, stops the pile before it starts. The counter stays clear because the junk never gets to land on it in the first place."},
    {"type":"h2","text":"Give the survivors three homes"},
    {"type":"p","text":"Whatever survives the recycling bin falls into three buckets. Action needed (a form to sign, a bill to pay) goes in a single visible tray you check daily. Keep (documents, records) gets filed — a small accordion folder is plenty for most families. Reference-briefly (an invitation, a schedule) goes on the command center until it's past. Three destinations, decided instantly, and nothing floats loose."},
    {"type":"h2","text":"Go paperless where you can"},
    {"type":"p","text":"The best paper system is less paper. Switch bills and statements to email, snap a photo of the school flyer and recycle the original, opt out of junk mail. And for the documents that truly matter — records, forms, warranties — a digital household binder means they're searchable and safe, not buried in a drawer you'll ransack in a panic the day you need them."},
    {"type":"p","text":"Paper will keep arriving every single day. Build the door-to-tray-to-file flow once, and the doom pile on your counter simply stops forming — along with the small emergencies it used to hide."}
  ]$json$::jsonb, true
),
(
  'the-donation-station',
  'The Always-Open Donation Box: Decluttering Without the Project',
  'Decluttering as a big event is exhausting and rare. A permanent box by the door turns it into a passive, effortless trickle.',
  'Priya Anand', '2026-06-26', 4, ARRAY['decluttering','habits','minimalism'], 'Organization', false, '#3b82f6',
  'https://images.unsplash.com/photo-1502086223501-7ea6ecd79368?auto=format&fit=crop&w=1600&q=80',
  'A neatly organized space with a designated box for giving away items',
  'Unsplash',
  $json$[
    {"type":"p","text":"Most people treat decluttering as a massive, dreaded project — a whole weekend of pulling everything out and agonizing over each item. No wonder it happens once a year, if that. There's a lazier, far more sustainable approach: stop making it a project and make it a permanent, always-open pathway out of your home. Enter the donation box that lives by the door and never leaves."},
    {"type":"h2","text":"Give ''out'' a permanent address"},
    {"type":"p","text":"Put a box or bin in a convenient spot — a closet, the garage, the mudroom — and declare it the donation box. From now on, the instant you come across something you don't use, don't love, or the kids have outgrown, it goes straight in. No sorting session required, no decision about ''when.'' The moment of realizing you're done with something becomes the moment it leaves your possession."},
    {"type":"h2","text":"Decluttering becomes passive"},
    {"type":"p","text":"This reframes the whole thing. Instead of a rare, exhausting purge, letting go becomes a constant, effortless trickle — a shirt here, a toy there, a gadget you finally admit you'll never use. The box quietly fills through normal life. You're decluttering all the time without ever ''decluttering,'' which is exactly why it actually keeps happening."},
    {"type":"h2","text":"Close the loop"},
    {"type":"p","text":"The only rule that makes it work: when the box is full, it goes. Put a standing reminder on the calendar, or just make ''drop-off day'' automatic when it overflows. A full box that never leaves is just new clutter. But a box that reliably empties itself into the donation bin every few weeks is a permanent pressure-release valve on your entire home."},
    {"type":"p","text":"Stop scheduling decluttering as an event you'll dread and skip. Give ''out'' a permanent home by the door, and let your house quietly lighten itself all year long."}
  ]$json$::jsonb, true
),

-- ═══ SCHOOL & ACTIVITIES ═════════════════════════════════════════════════════
(
  'beat-the-summer-slide',
  'Beating the Summer Slide Without Turning Summer Into School',
  'Kids can lose months of learning over a long break — but the fix isn''t worksheets by the pool. It''s sneaking learning into the fun.',
  'Elena Rodriguez', '2026-06-28', 6, ARRAY['school','summer','learning'], 'School & Activities', true, '#10b981',
  'https://images.unsplash.com/photo-1495364141860-b0d03eccd065?auto=format&fit=crop&w=1600&q=80',
  'Kids playing and exploring outdoors in summer',
  'Unsplash',
  $json$[
    {"type":"p","text":"Teachers have a name for what happens over a long summer: the ''summer slide,'' the real and measurable loss of reading and math skills when kids' brains go idle for months. It's enough that classes often spend weeks in the fall just re-teaching. But the fix isn't a summer of worksheets that makes everyone miserable — it's weaving small doses of learning into a summer that still feels like summer."},
    {"type":"h2","text":"Reading is the whole ballgame"},
    {"type":"p","text":"If you do one thing, protect daily reading. It's the single biggest lever against the slide, and it doesn't have to look like homework — comics, graphic novels, magazines about their obsession, audiobooks on a road trip, a library summer program with prizes all count. The goal is that their eyes and ears keep meeting words every day. Let them choose what; you just protect the habit."},
    {"type":"h2","text":"Math is hiding in real life"},
    {"type":"p","text":"You don't need a math workbook when the world is full of it. Cooking is fractions and measurement. A lemonade stand is money and profit. A road trip is distance, time, and speed. Baseball stats are averages. Board games are counting and probability. Point the math out as it naturally appears, and kids keep those skills warm without ever sitting down to ''do math.''"},
    {"type":"h2","text":"Curiosity counts as learning too"},
    {"type":"p","text":"Summer's real gift is time for the kind of learning school has no room for: a deep dive into dinosaurs, a backyard bug study, building something, a museum afternoon, learning to cook one real dish. This self-directed, passion-driven exploration builds thinking skills and a love of learning that no packet ever could — and it's the part they'll actually remember about the summer."},
    {"type":"p","text":"Keep them reading, let math show up in real life, and feed their curiosity. That's enough to arrive in September sharp — without stealing the summer that makes childhood worth having."}
  ]$json$::jsonb, true
),
(
  'the-twenty-minute-reading-habit',
  'The 20-Minute Reading Habit That Beats Any Reading Log',
  'Mandated reading logs can turn books into a chore. A simple, cozy, daily habit does more for a young reader than any signature line.',
  'Elena Rodriguez', '2026-06-26', 5, ARRAY['reading','literacy','routines'], 'School & Activities', false, '#10b981',
  'https://images.unsplash.com/photo-1427504494785-3a9ca7044f45?auto=format&fit=crop&w=1600&q=80',
  'Shelves of colorful books inviting a young reader',
  'Unsplash',
  $json$[
    {"type":"p","text":"The research on reading is almost boringly consistent: kids who read a little every day, for pleasure, pull ahead of kids who don't — in vocabulary, in comprehension, in school and beyond. The tricky part is that the tool schools often use to enforce it, the nightly reading log with a parent signature, can quietly turn the joy into a chore. The habit matters; the paperwork can backfire."},
    {"type":"h2","text":"Make it a cozy ritual, not a task"},
    {"type":"p","text":"Twenty minutes of daily reading lands completely differently depending on how it's framed. As a logged assignment to be timed and signed, it's homework. As a warm, screen-free wind-down — in bed, under a blanket, with a snack, maybe alongside a parent reading their own book — it's a treat. Same twenty minutes, opposite relationship with books. Aim for the ritual, and the log takes care of itself."},
    {"type":"h2","text":"Let them read ''junk''"},
    {"type":"p","text":"The fastest way to kill a reading habit is to police what counts. Comics, joke books, the same dinosaur book for the ninetieth time, a series adults find dull — it all builds the exact same reading muscles. A kid reading what they love every night becomes a reader. A kid forced through ''quality'' books they hate learns that reading is punishment. Choice is the engine; protect it fiercely."},
    {"type":"h2","text":"Guard the time like it matters"},
    {"type":"p","text":"A daily habit only survives if it has a protected slot. Anchor the twenty minutes to something that already happens every day — right before lights-out is perfect, because kids will happily read to delay sleep. Bookend the day with it, keep it consistent, and it becomes as automatic as brushing teeth. Consistency, not intensity, is what turns twenty minutes into a lifelong reader."},
    {"type":"p","text":"Skip the stress about the log. Build a cozy, daily, anything-goes reading habit, and you'll grow a reader — which is the thing the log was only ever trying to measure."}
  ]$json$::jsonb, true
),

-- ═══ AI & TECHNOLOGY ═════════════════════════════════════════════════════════
(
  'the-first-phone-contract',
  'The First Smartphone: Why You Need a Contract Before You Need the Phone',
  'Handing a kid a smartphone is handing them the whole internet. A simple written agreement, made before day one, saves a thousand later fights.',
  'Jessica Miller', '2026-06-28', 6, ARRAY['ai','screen time','teens'], 'AI & Technology', true, '#6366f1',
  'https://images.unsplash.com/photo-1531482615713-2afd69097998?auto=format&fit=crop&w=1600&q=80',
  'A smartphone on a table, ready for a family agreement',
  'Unsplash',
  $json$[
    {"type":"p","text":"Handing a child their first smartphone is a bigger moment than it looks. You're not giving them a phone; you're giving them a 24/7 portal to the entire internet, every game, every social platform, and every stranger on it, to carry in their pocket. The families who navigate this well almost all do one thing first: they set the terms in writing, together, before the phone is ever unboxed."},
    {"type":"h2","text":"Agree on the rules while it''s still hypothetical"},
    {"type":"p","text":"It's far easier to agree on limits before the phone exists than to claw them back after. A simple written contract — where it charges at night (not the bedroom), when it's away (meals, homework, bedtime), which apps are allowed, that you'll periodically check in — lands as fair and collaborative when it's set up front. Imposed later, the same rules feel like a punishment and a betrayal."},
    {"type":"h2","text":"Frame it as responsibility, not restriction"},
    {"type":"p","text":"The contract works best framed as a partnership: the phone is a privilege that grows with demonstrated responsibility, and the rules exist to keep them safe while they learn. Involve the kid in writing it — let them argue for reasonable freedoms — so they have ownership. A teen who helped set the terms is far more likely to honor them than one handed a list of nos."},
    {"type":"h2","text":"Put the hardest stuff in writing"},
    {"type":"p","text":"Use the contract to open the conversations that matter most, before there's a crisis: what to do if a stranger messages them, that nothing online is ever truly private, why they should never share certain photos, that they can always come to you about anything they see without getting in trouble. Naming these on day one makes them normal to discuss, so your kid actually comes to you when something goes wrong."},
    {"type":"p","text":"Write the agreement before you buy the phone. It turns a dreaded source of endless conflict into a clear, shared understanding — and gives your kid the guardrails they genuinely need while learning to handle the most powerful device they'll ever own."}
  ]$json$::jsonb, true
),
(
  'your-kids-digital-footprint-starts-with-you',
  'Your Kid''s Digital Footprint Starts With You',
  'Long before a child opens their first account, a trail already exists — the one their parents posted. ''Sharenting'' deserves a second thought.',
  'Marcus Bennett', '2026-06-26', 6, ARRAY['ai','privacy','safety'], 'AI & Technology', false, '#6366f1',
  'https://images.unsplash.com/photo-1489710437720-ebb67ec84dd2?auto=format&fit=crop&w=1600&q=80',
  'A parent thoughtfully holding a phone with a child nearby',
  'Unsplash',
  $json$[
    {"type":"p","text":"Most kids today have a digital footprint before they can walk — not one they made, but one their parents did. The birth announcement, the bath photos, the first-day-of-school sign held up to the camera, the funny meltdown story. It's all loving and normal, and it's also a permanent, searchable record about a person who never got asked. ''Sharenting'' is worth a pause, not a panic."},
    {"type":"h2","text":"The internet doesn''t forget, and it doesn''t ask"},
    {"type":"p","text":"A photo posted today can outlive the platform, get scraped, get screenshotted, and resurface in fifteen years when your kid is applying to college or a job. The child in the picture had no say and can't take it back. That's the core issue: you're making a permanent, public decision on behalf of someone who will one day have their own opinion about it. A little foresight now spares them a lot later."},
    {"type":"h2","text":"A few simple filters before you post"},
    {"type":"p","text":"You don't have to go dark — just run a quick check. Would your kid be embarrassed by this at fourteen? Does it reveal identifying details (school name, home, full birthdate, anything in a bathroom or bath)? Are you posting it for them or for your own likes? Lock down your audience to people you actually know, skip the truly private stuff, and when in doubt, share it in a group chat instead of a public feed."},
    {"type":"h2","text":"Model the consent you want them to learn"},
    {"type":"p","text":"Here's the quiet payoff: how you handle their image teaches them how to handle everyone's. Ask an older kid ''is it okay if I post this?'' and honor a no. You're modeling digital consent — the exact habit you'll want them to have before they post about their friends someday. A kid who grew up being asked is far more likely to ask."},
    {"type":"p","text":"Share the joy of your family — just remember there's a real person in the photo who'll inherit the footprint. A moment's thought before you post is one of the first privacy lessons you'll ever teach, and you teach it by living it."}
  ]$json$::jsonb, true
),

-- ═══ WELLNESS ════════════════════════════════════════════════════════════════
(
  'the-family-gratitude-habit',
  'The Family Gratitude Habit: A 2-Minute Ritual That Rewires the Mood',
  'Gratitude isn''t just a nicety — it measurably shifts how a brain scans the world. A tiny nightly ritual can change the whole family''s baseline.',
  'Dr. Sarah Kim', '2026-06-28', 5, ARRAY['gratitude','wellness','routines'], 'Wellness', true, '#f59e0b',
  'https://images.unsplash.com/photo-1554224154-26032ffc0d07?auto=format&fit=crop&w=1600&q=80',
  'A family sharing a calm, warm moment together',
  'Unsplash',
  $json$[
    {"type":"p","text":"Gratitude gets dismissed as a soft, feel-good nicety, but the research is surprisingly hard-edged: regularly noticing what's good measurably shifts mood, sleep, and how the brain scans the world — toward the positive instead of the threatening. The best part is how little it takes. A two-minute family ritual, done consistently, can nudge everyone's baseline toward contentment, kids included."},
    {"type":"h2","text":"Make it a tiny, fixed ritual"},
    {"type":"p","text":"The key is small and consistent. At dinner or at bedtime, everyone shares one good thing from their day — a ''rose,'' a highlight, one thing they're thankful for. Two minutes, every day, same time. It's short enough that nobody dreads it and regular enough that it becomes a habit. The magic isn't in any single answer; it's in the daily repetition training everyone's attention."},
    {"type":"h2","text":"Why it rewires attention"},
    {"type":"p","text":"Here's the mechanism: knowing you'll be asked ''what was good today?'' quietly changes how you move through the day — you start noticing and mentally filing the good moments as they happen, because you'll want one to share. Over time, the brain gets better at spotting the positive by default. You're not faking happiness; you're training the mind to catch what it usually lets slip past."},
    {"type":"h2","text":"It doubles as a daily check-in"},
    {"type":"p","text":"The ritual sneaks in a second benefit: a reliable window into everyone's inner world. What a kid picks as their ''best thing'' — or their honest ''hardest thing,'' if you add that too — tells you what mattered to them today, and opens the door to the conversation that might not have happened otherwise. It's connection and mood-training in the same two minutes."},
    {"type":"p","text":"You can't hand your family a sunnier temperament, but you can build a two-minute habit that gently trains everyone to notice the good. Do it nightly, and watch the family's default setting slowly shift."}
  ]$json$::jsonb, true
),
(
  'the-family-mental-health-check-in',
  'Beyond ''How Was School?'': Questions That Actually Open Kids Up',
  'The daily ''fine'' isn''t stonewalling — it''s a bad question getting a lazy answer. Better questions unlock what your kid is really carrying.',
  'Dr. Sarah Kim', '2026-06-26', 6, ARRAY['mental health','communication','connection'], 'Wellness', false, '#f59e0b',
  'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?auto=format&fit=crop&w=1600&q=80',
  'A cozy, calm setting for an unhurried conversation',
  'Unsplash',
  $json$[
    {"type":"p","text":"''How was school?'' ''Fine.'' Every parent knows this exchange, and most read the ''fine'' as a wall. Usually it isn't. It's a vague question getting the vague answer it invites, often at a bad moment when the kid is tired and depleted. With a few tweaks — better questions, better timing — that same kid will tell you things the daily interrogation never surfaced."},
    {"type":"h2","text":"Ask specific, answerable questions"},
    {"type":"p","text":"''How was school?'' is too big to answer. Shrink it: ''What made you laugh today?'' ''What was the hardest part of your day?'' ''Who did you sit with at lunch?'' ''Did anything annoy you?'' Specific questions give a kid a real door to walk through instead of a blank wall to shrug at. The narrower and more concrete the question, the more real the answer tends to be."},
    {"type":"h2","text":"Timing beats technique"},
    {"type":"p","text":"Kids rarely open up on demand, face-to-face, the moment they walk in drained. They open up sideways — in the car, on a walk, at bedtime, while doing something else — when there's no pressure and no eye contact to make it feel like an interrogation. Some of the best conversations happen shoulder-to-shoulder in the dark at bedtime. Go where the words already want to come out, and stop expecting them at the front door."},
    {"type":"h2","text":"Listen more than you fix"},
    {"type":"p","text":"When a kid does open up about something hard, the fastest way to close the door is to leap in with solutions, judgment, or a lecture. Just listen. ''That sounds really hard, tell me more'' keeps them talking; ''well, what you should do is...'' ends it. Kids share more with parents who receive it calmly than with parents who react. Being a safe place to unload is what earns you the next conversation, and the one after that."},
    {"type":"p","text":"The ''fine'' isn't the problem — the question is. Ask smaller, ask at the right time, and mostly just listen, and you'll find your kid has a lot more to say than a one-word answer ever suggested."}
  ]$json$::jsonb, true
),

-- ═══ FAMILY FINANCES ═════════════════════════════════════════════════════════
(
  'needs-versus-wants',
  'Needs vs. Wants: The Money Lesson That Starts at the Grocery Store',
  'The single most useful money distinction a kid can learn isn''t taught in a lecture. It''s taught in a hundred small moments in the cereal aisle.',
  'David Okafor', '2026-06-28', 5, ARRAY['money skills','budgeting','kids'], 'Family Finances', true, '#f43f5e',
  'https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=1600&q=80',
  'A child learning to sort money choices with coins and jars',
  'Unsplash',
  $json$[
    {"type":"p","text":"If a kid absorbs just one financial concept before they leave home, let it be the difference between a need and a want. It's the foundation every budget stands on, the distinction that separates adults who live within their means from those who don't — and it isn't taught in a single lecture. It's taught in a hundred small, concrete moments, most of them in the aisles of a grocery store."},
    {"type":"h2","text":"Use real, in-the-moment examples"},
    {"type":"p","text":"Abstract definitions bounce off kids; live examples stick. In the store: ''We need food for dinner — that's a need. This particular brand of cookies is a want.'' At home: ''You need clothes for winter; you want that specific expensive logo on them.'' Naming the difference out loud, again and again, in real decisions, is how the concept moves from a definition they can recite to an instinct they actually use."},
    {"type":"h2","text":"Let them feel the trade-off with their own money"},
    {"type":"p","text":"The lesson gets real teeth when it's the kid's own money on the line. When they're spending from their own allowance, needs versus wants stops being an abstraction and becomes a genuine choice: this want means giving up that one, or draining the savings they were building. Feeling that trade-off in their own wallet teaches prioritization far better than any parental explanation of it ever could."},
    {"type":"h2","text":"Model it honestly yourself"},
    {"type":"p","text":"Kids learn the most from watching you navigate the line. Narrate your own calls: ''I really want this, but it's not in the budget this month, so I'm waiting,'' or ''this is worth it to us, so we're choosing to spend on it.'' Seeing a parent consciously distinguish needs from wants — and sometimes say no to their own wants — teaches that this is a lifelong practice, not a rule that only applies to children."},
    {"type":"p","text":"You don't need a curriculum to teach the most important money lesson there is. You need the cereal aisle, a little narration, and the patience to name needs and wants until your kid can tell them apart on their own."}
  ]$json$::jsonb, true
),
(
  'the-birthday-money-plan',
  'What to Do With Birthday Money: Turning a Windfall Into a Lesson',
  'A wad of birthday cash is a teachable moment disguised as a gift. Handled well, it plants habits that outlast whatever they buy.',
  'David Okafor', '2026-06-26', 5, ARRAY['money skills','saving','kids'], 'Family Finances', false, '#f43f5e',
  'https://images.unsplash.com/photo-1560253023-3ec5d502959f?auto=format&fit=crop&w=1600&q=80',
  'A family celebrating a birthday together',
  'Unsplash',
  $json$[
    {"type":"p","text":"A birthday or holiday often lands a kid with more cash at once than they've ever held — a small windfall practically burning a hole in their pocket. The instinct is to let them blow it all immediately, or to quietly ''save it for them'' into oblivion. Both miss the opportunity. A windfall is one of the richest teachable moments in a kid's financial year, if you handle it with a little intention."},
    {"type":"h2","text":"Apply the split, even to gift money"},
    {"type":"p","text":"If your family uses a spend-save-give split, gift money is a perfect chance to practice it with real stakes. Some to spend now (the fun is real and shouldn't be erased), some to save toward a bigger goal, some to give. Applying the framework to a windfall reinforces that all money — earned or gifted — gets thoughtfully divided, not just instantly spent. The bigger the sum, the more the lesson sticks."},
    {"type":"h2","text":"Let them make a real spending choice"},
    {"type":"p","text":"Resist the urge to control the ''spend'' portion. Let them choose, even if they pick something you think is junk. A kid who buys a toy that breaks in a day learns a genuine lesson about value that no lecture delivers — and it's a cheap lesson to learn at eight rather than a costly one at twenty-eight. The autonomy, including the freedom to choose poorly, is where the learning lives."},
    {"type":"h2","text":"Make the ''save'' portion visible and aimed"},
    {"type":"p","text":"Saving a chunk of birthday money is far more motivating when it's aimed at something they actually want and can watch getting closer. Tie it to a real goal — the bigger toy, the game, the thing they've been eyeing — and show the windfall jumping them toward it. Suddenly saving isn't deprivation; it's a shortcut to something they want, and the windfall becomes a lesson in how saving accelerates a goal."},
    {"type":"p","text":"Birthday money will come every year. Treat each windfall as a chance to practice spending, saving, and giving with real stakes, and you'll turn a pile of cash into habits worth far more than whatever it buys."}
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
