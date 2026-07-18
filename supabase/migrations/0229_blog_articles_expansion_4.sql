-- FamilyOS :: 0229 Blog articles — expansion batch 4
-- ----------------------------------------------------------------------------
-- Fourth wave of original, editorially-voiced articles for public.blog_posts,
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
  'praise-the-effort-not-the-genius',
  'Praise the Effort, Not the Genius: The Two Words That Change How Kids Try',
  'Telling a kid they''re smart feels loving. It can also quietly teach them to avoid anything hard — because failing would mean they''re not.',
  'Jessica Miller', '2026-07-01', 6, ARRAY['growth mindset','child development','encouragement'], 'Parenting', true, '#7c5dff',
  'https://images.unsplash.com/photo-1484480974693-6ca0a78fb36b?auto=format&fit=crop&w=1600&q=80',
  'A parent encouraging a child at a table full of a project in progress',
  'Unsplash',
  $json$[
    {"type":"p","text":"''You're so smart!'' is one of the most natural things a loving parent says. It's also, according to a large body of research, one of the trickiest. Praising a child for a fixed trait — smart, talented, gifted — can quietly teach them that success should come easily, and that struggling means they must not have it after all. So they start avoiding hard things to protect the label."},
    {"type":"h2","text":"Praise the part they controlled"},
    {"type":"p","text":"The fix is to aim your praise at effort, strategy, and persistence — the things a child actually chose. ''You worked really hard on that.'' ''You tried three different ways until it clicked.'' ''You didn't give up when it got tough.'' This tells them that the doing is what you value, and the doing is something they can always summon again, unlike a trait they either have or don't."},
    {"type":"h2","text":"Why it changes their relationship with hard things"},
    {"type":"p","text":"A kid praised for being smart learns that hard tasks are threats — a chance to lose the label. A kid praised for effort learns that hard tasks are opportunities — the exact place where the praiseworthy thing (trying) happens. One child shrinks from challenge; the other leans in. Over years, that difference compounds into two completely different learners."},
    {"type":"h2","text":"Let struggle be normal, even good"},
    {"type":"p","text":"Narrate your own effort and even your failures out loud: ''this is hard, I'm going to keep working at it.'' When kids see that struggle is just part of learning, not evidence of inadequacy, they stop fearing it. Add the word ''yet'' — ''you can't do it yet'' — and you turn a verdict into a waypoint. The goal isn't a kid who feels smart; it's a kid who isn't afraid to try."},
    {"type":"p","text":"Swap two words — from ''you're smart'' to ''you worked hard'' — and you hand your child something better than confidence in a trait: confidence in their own effort."}
  ]$json$::jsonb, true
),
(
  'stop-comparing-your-kids',
  'The Invisible Scoreboard: Why Comparing Your Kids Backfires',
  'Even the gentlest comparison lands as a ranking. Kids keep a scoreboard you never meant to start — and everybody loses on it.',
  'Marcus Bennett', '2026-06-30', 5, ARRAY['siblings','emotional health','parenting'], 'Parenting', false, '#7c5dff',
  'https://images.unsplash.com/photo-1476703993599-0035a21b17a9?auto=format&fit=crop&w=1600&q=80',
  'A parent talking warmly with one child at eye level',
  'Unsplash',
  $json$[
    {"type":"p","text":"''Why can't you be more like your sister?'' is the obvious one, and most parents know to avoid it. But comparison sneaks in through gentler doors too: ''your brother already finished his homework,'' or even a bright ''look how well she shares!'' said within earshot. Kids run a constant, silent tally of where they rank — and every comparison, however small, feeds a scoreboard that only breeds resentment."},
    {"type":"h2","text":"Comparison turns siblings into rivals"},
    {"type":"p","text":"When kids are measured against each other, the family stops feeling like a team and starts feeling like a competition. The ''winner'' gets anxious about staying on top; the ''loser'' concludes they're the lesser child. Either way, the sibling becomes the yardstick they're failing against, which poisons the one relationship you most want them to have — the one that outlasts you."},
    {"type":"h2","text":"Measure each kid against themselves"},
    {"type":"p","text":"The antidote is to drop the sibling from the sentence entirely and compare a child only to their own past. ''You read that so much more smoothly than last month.'' ''You kept your temper this time — that's growth.'' This is motivating instead of threatening, because it points at their own progress, a race they can actually win without anyone else having to lose."},
    {"type":"h2","text":"Name what''s uniquely theirs"},
    {"type":"p","text":"Kids don't need to be equal; they need to be seen. Reflect back the specific, particular thing each child is — the funny one, the gentle one, the one who notices everything — without ranking those things against a sibling. When a kid feels genuinely known for who they are, the need to win the scoreboard fades, because they're no longer competing for a spot; they already have their own."},
    {"type":"p","text":"You'll never stop your kids from comparing themselves — but you can refuse to be the one keeping score."}
  ]$json$::jsonb, true
),

-- ═══ ORGANIZATION ════════════════════════════════════════════════════════════
(
  'the-family-command-center',
  'The Family Command Center: One Wall That Runs the Whole House',
  'The information a family needs is scattered across six phones and a fridge. Gather it onto one wall and the mental load drops overnight.',
  'Priya Anand', '2026-07-01', 5, ARRAY['home systems','organizing','mental load'], 'Organization', true, '#3b82f6',
  'https://images.unsplash.com/photo-1584697964358-3e14ca57658b?auto=format&fit=crop&w=1600&q=80',
  'A tidy, organized wall station with a calendar and notes',
  'Unsplash',
  $json$[
    {"type":"p","text":"Every family runs on information — the week's schedule, the permission slips, the grocery list, the ''don't forget'' notes — and in most homes that information is scattered everywhere and centralized nowhere. It lives on six different phones, three sticky notes, and one parent's overloaded memory. A command center fixes that by giving the household a single wall where the whole family's logistics live."},
    {"type":"h2","text":"One place beats six"},
    {"type":"p","text":"The core idea is centralization. Pick a high-traffic spot — a kitchen wall, the mudroom, the side of the fridge — and make it the one place everyone looks and updates. A shared calendar, an inbox tray for papers that need action, a running grocery list, a hook for keys. When there's one source of truth, ''I didn't know'' stops being a valid excuse for anyone, including the adults."},
    {"type":"h2","text":"Build it around what actually goes wrong"},
    {"type":"p","text":"Don't copy a magazine layout; build for your family's real failure points. Always losing permission slips? Add an ''action needed'' tray. Mornings chaotic? Post the routine checklist here. Forgetting what's for dinner? Add a little menu card. The command center should be a direct answer to the specific things that keep falling through the cracks in your house."},
    {"type":"h2","text":"Digital, analog, or both"},
    {"type":"p","text":"A physical wall is visible and unmissable, which is its superpower. But the best command centers pair it with a shared digital layer — a family calendar and lists everyone can see on their phones when they're not standing in the kitchen. The wall is for the household at home; the app is for the parent stuck at the office who still needs to know practice got moved."},
    {"type":"p","text":"Spend one afternoon building it, and you'll spend the next year not answering ''where do I need to be?'' forty times a week."}
  ]$json$::jsonb, true
),
(
  'meal-planning-for-people-who-hate-it',
  'Meal Planning for People Who Hate Meal Planning',
  'The problem was never that you''re disorganized. It''s that ''plan seven dinners'' is a genuinely miserable task. Here''s the lazy version that works.',
  'Priya Anand', '2026-06-29', 5, ARRAY['meal planning','home systems','routines'], 'Organization', false, '#3b82f6',
  'https://images.unsplash.com/photo-1606787366850-de6330128bfc?auto=format&fit=crop&w=1600&q=80',
  'A colorful overhead spread of fresh ingredients ready to cook',
  'Unsplash',
  $json$[
    {"type":"p","text":"The nightly ''what's for dinner'' dread is one of the most reliable stressors in family life, and most meal-planning advice makes it worse by demanding a beautiful, color-coded, seven-dinner spreadsheet. If you were the kind of person who'd maintain that, you'd already be doing it. Here's the version for the rest of us: less planning, fewer decisions, no spreadsheet."},
    {"type":"h2","text":"Theme the nights, don''t plan the meals"},
    {"type":"p","text":"Instead of deciding seven specific dinners each week, give each night a theme: Meatless Monday, Taco Tuesday, Pasta Wednesday, Leftovers Thursday, Pizza Friday. Now you're not staring at infinite options every night — you're just answering ''which pasta?'' The theme does 90% of the deciding, permanently, so you never have to make the exhausting from-scratch choice again."},
    {"type":"h2","text":"Keep a short list of ''house meals''"},
    {"type":"p","text":"Nobody actually needs variety every single night — families happily rotate the same dozen dinners. Write down the ten to fifteen meals your family reliably eats without complaint, keep the ingredients for them on hand, and pull from that list. This isn't boring; it's efficient. Save the culinary adventures for the weekend when you have the energy, and let weeknights run on autopilot."},
    {"type":"h2","text":"Decide once, shop once"},
    {"type":"p","text":"The real time-saver is batching the decision. Spend ten minutes once a week loosely mapping themes to your house meals, build the grocery list from that, and shop a single time. The goal isn't a gourmet week — it's never again standing in front of the fridge at 6 p.m. with no plan and three hungry kids. Decide on Sunday so weeknight-you doesn't have to."},
    {"type":"p","text":"You don't have to love cooking or planning. You just have to make the decision once, in advance, so it stops ambushing you every single evening."}
  ]$json$::jsonb, true
),

-- ═══ SCHOOL & ACTIVITIES ═════════════════════════════════════════════════════
(
  'the-science-fair-project',
  'How to Actually Help With a Science Fair Project (Without Doing It)',
  'The polished volcano everyone knows a parent built teaches a kid nothing. The messy one they did themselves teaches everything.',
  'Elena Rodriguez', '2026-07-01', 6, ARRAY['school','learning','projects'], 'School & Activities', true, '#10b981',
  'https://images.unsplash.com/photo-1427504494785-3a9ca7044f45?auto=format&fit=crop&w=1600&q=80',
  'Tall library shelves lined with colorful books for research',
  'Unsplash',
  $json$[
    {"type":"p","text":"Every science fair features a few suspiciously professional projects — laser-cut, perfectly lettered, clearly the work of an adult with a glue gun and a deadline. And every teacher can spot them instantly. The urge to rescue your kid's messy project is strong, but the polished version quietly robs them of the entire point. Your job isn't to build it. It's to help them build it."},
    {"type":"h2","text":"Be the guide, not the hands"},
    {"type":"p","text":"There's a bright line between guiding and doing. Guiding is asking questions — ''what do you think will happen?'', ''how could we test that?'', ''what went wrong there?'' Doing is picking up the scissors yourself. Stay on the guiding side, even when it's slower and the result is lumpier. The lumps are evidence of learning; the perfection would be evidence of yours."},
    {"type":"h2","text":"Let the mess be the lesson"},
    {"type":"p","text":"Real science is messy — the experiment fails, the hypothesis is wrong, the lettering is crooked. That's not a project going badly; that's a project going exactly right. A kid who runs a flawed experiment and figures out why it flopped has learned the actual scientific method. A kid handed a flawless one has learned that Mom does good work under pressure."},
    {"type":"h2","text":"Protect the ownership"},
    {"type":"p","text":"The prize isn't the ribbon; it's the kid standing at their board able to explain every part because they did every part. That confidence — ''I made this, I understand this'' — is worth infinitely more than a first-place finish on a project they can't explain. When you're tempted to take over ''just this once,'' remember you'd be trading their pride for a prettier poster."},
    {"type":"p","text":"Help all you want — with questions, encouragement, and a ride to the store. Just keep your hands off the volcano. The wobbly one they built is the one that taught them something."}
  ]$json$::jsonb, true
),
(
  'the-parent-teacher-partnership',
  'The Parent-Teacher Partnership: Getting on the Same Team Early',
  'The best time to build a relationship with your kid''s teacher is long before anything goes wrong. Here''s how to start on the same side.',
  'Elena Rodriguez', '2026-06-29', 5, ARRAY['school','communication','teachers'], 'School & Activities', false, '#10b981',
  'https://images.unsplash.com/photo-1506784983877-45594efa4cbe?auto=format&fit=crop&w=1600&q=80',
  'A school backpack and notebook ready for the day',
  'Unsplash',
  $json$[
    {"type":"p","text":"For a lot of parents, contact with a teacher only happens when something's wrong — a bad grade, a behavior note, a problem. That means the relationship starts on the back foot, in a moment of tension, when you most need it to be strong. The families whose kids thrive at school tend to do the opposite: they build the partnership early, on purpose, before it's needed."},
    {"type":"h2","text":"Reach out before there''s a problem"},
    {"type":"p","text":"A short, warm note at the start of the year — ''thanks for all you do, here's one thing that helps my kid, please tell me how I can support what you're doing'' — changes everything. It signals you see the teacher as an ally, not an adversary. Then, if a hard conversation ever does come, you're two people who already respect each other solving a problem, not strangers squaring off."},
    {"type":"h2","text":"Assume you''re on the same side"},
    {"type":"p","text":"You and the teacher want the identical thing: your kid to flourish. Walking into every interaction from that assumption — same team, shared goal — defuses most of the friction before it starts. Even when you disagree about how, leading with ''we both want what's best for her, let's figure this out together'' keeps you as partners instead of opponents lobbing complaints."},
    {"type":"h2","text":"Support the teacher in front of your kid"},
    {"type":"p","text":"Kids are always listening. When you speak about their teacher with respect — even when you're privately frustrated — you tell your child that school is a place worth taking seriously and that the adults there are on their side. Undermining the teacher at the dinner table teaches a kid they don't have to take that classroom seriously either, which helps no one."},
    {"type":"p","text":"Build the bridge in September, not in a crisis. A teacher who knows you're in their corner will go to bat for your kid in ways no adversarial parent ever gets."}
  ]$json$::jsonb, true
),

-- ═══ AI & TECHNOLOGY ═════════════════════════════════════════════════════════
(
  'passwords-are-a-family-problem',
  'Passwords Are a Family Problem Now (and a Sticky Note Won''t Cut It)',
  'The wifi code, the streaming logins, the school portal, the shared accounts — a modern family runs on dozens of passwords. Where do they safely live?',
  'Jessica Miller', '2026-07-01', 6, ARRAY['ai','security','organization'], 'AI & Technology', true, '#6366f1',
  'https://images.unsplash.com/photo-1489710437720-ebb67ec84dd2?auto=format&fit=crop&w=1600&q=80',
  'A parent and child using a device together safely',
  'Unsplash',
  $json$[
    {"type":"p","text":"A modern household quietly accumulates dozens of shared logins: the wifi, the streaming services, the school portal, the pediatrician's app, the grocery account, the utility bills. In most families these live in a chaotic mix of one parent's memory, a sticky note on the monitor, and a running text thread titled ''passwords.'' It's insecure, it's fragile, and it collapses the moment the keeper of the passwords is unreachable."},
    {"type":"h2","text":"The sticky-note system is a real risk"},
    {"type":"p","text":"Reusing the same password everywhere, writing them on paper, or texting them in the clear are genuine security holes — a single breach can cascade across every account. And practically, when everything lives in one person's head, the rest of the family is locked out the day that person is on a plane or in the hospital. Convenience and safety are both failing at once."},
    {"type":"h2","text":"Use a shared vault, not your brain"},
    {"type":"p","text":"A family password manager solves both problems: strong, unique passwords for every account, stored encrypted, and shared securely with the people who need them. Both parents can reach the accounts; older kids can be given just the logins appropriate for them. You remember one master password, and the tool remembers the other two hundred — safely, and available to the whole household."},
    {"type":"h2","text":"Make it part of the family''s digital estate"},
    {"type":"p","text":"Passwords are increasingly part of a family's essential records, right alongside insurance and documents. Storing them in one secure, shared place — and making sure a trusted partner can access it in an emergency — is basic modern preparedness. It's the unglamorous infrastructure that keeps the household running when the usual person can't be reached."},
    {"type":"p","text":"The family password problem isn't going away; it grows every year. Trade the sticky note for a real vault, and you fix the security hole and the single-point-of-failure in one move."}
  ]$json$::jsonb, true
),
(
  'the-location-sharing-talk',
  'The Location-Sharing Talk: Safety Tool, Not Surveillance',
  'Sharing location can be a genuine safety net or a quiet erosion of trust. The difference is entirely in how you set it up together.',
  'Marcus Bennett', '2026-06-29', 6, ARRAY['ai','safety','teens'], 'AI & Technology', false, '#6366f1',
  'https://images.unsplash.com/photo-1531482615713-2afd69097998?auto=format&fit=crop&w=1600&q=80',
  'A phone showing a map on a kitchen counter',
  'Unsplash',
  $json$[
    {"type":"p","text":"Family location-sharing apps are now nearly universal, and they sit on a knife's edge. Handled one way, they're a reassuring safety net that gives kids more freedom, not less. Handled another way, they become a surveillance tool that teaches a teenager they aren't trusted — and trains them to get very good at evading you. The technology is neutral; the relationship around it is everything."},
    {"type":"h2","text":"Frame it as mutual, not one-way"},
    {"type":"p","text":"The fastest way to make location-sharing feel like spying is to make it a one-way mirror — you watch them, they can't see you. Make it mutual instead: everyone in the family shares with everyone. Now it's a shared family tool for coordination and safety (''looks like you're almost home, I'll start dinner'') rather than a parental eye in the sky, and it models the reciprocity you're asking for."},
    {"type":"h2","text":"Agree on the rules together"},
    {"type":"p","text":"Sit down and decide, as a family, what the sharing is actually for: safety, coordination, peace of mind — not catching them in a lie. Be explicit that you won't be watching the dot all day or interrogating every stop. A teen who helped set the terms, and trusts you'll honor them, experiences the app as a safety net. One who had it imposed experiences it as a leash."},
    {"type":"h2","text":"Trust is the goal, not the location"},
    {"type":"p","text":"The real aim of adolescence is a kid who makes good choices when you're not watching — and you can't build that by watching constantly. Use location-sharing to grant freedom with a backstop, not to replace trust with monitoring. As they show responsibility, the check-ins should loosen. The app is training wheels, and the whole point of training wheels is to eventually come off."},
    {"type":"p","text":"Set it up as a two-way safety net you all opted into, and it strengthens trust. Set it up as a secret watchtower, and you'll teach exactly the sneakiness you feared."}
  ]$json$::jsonb, true
),

-- ═══ WELLNESS ════════════════════════════════════════════════════════════════
(
  'the-big-feelings-vocabulary',
  'Give Big Feelings a Vocabulary: The Skill That Prevents Meltdowns',
  'A kid who can say ''I''m frustrated'' rarely needs to throw the toy. Naming feelings is a superpower, and it''s teachable.',
  'Dr. Sarah Kim', '2026-07-01', 6, ARRAY['emotional health','feelings','child development'], 'Wellness', true, '#f59e0b',
  'https://images.unsplash.com/photo-1554224154-26032ffc0d07?auto=format&fit=crop&w=1600&q=80',
  'A parent and child talking calmly together by a window',
  'Unsplash',
  $json$[
    {"type":"p","text":"A huge share of young-kid meltdowns come down to a translation failure. The child is flooded with a big, overwhelming feeling they have no words for, so it comes out the only way it can — a scream, a thrown toy, a body on the floor. Teaching kids to name their emotions is one of the highest-leverage things a parent can do, because a feeling that can be named can be handled."},
    {"type":"h2","text":"Name it to tame it"},
    {"type":"p","text":"There's real neuroscience here: putting a feeling into words actually calms the emotional alarm center of the brain. When you help a child say ''I'm frustrated'' or ''I feel left out,'' you're not just labeling — you're literally helping them regulate. The naming is the off-ramp. A kid with words for their storm has a way through it that a kid without words simply doesn't."},
    {"type":"h2","text":"Be their emotional narrator"},
    {"type":"p","text":"Kids learn this vocabulary from us narrating it. ''You're stomping and your fists are tight — I think you're really angry the tower fell.'' You're doing two things: giving them the word, and showing them you understand. Do this enough and they internalize the labels, until one day they surprise you by announcing ''I'm disappointed'' instead of melting down. That's the skill taking hold."},
    {"type":"h2","text":"Accept the feeling, guide the behavior"},
    {"type":"p","text":"The crucial move is to separate the emotion from the action. All feelings are allowed — anger, jealousy, sadness are never wrong. What's coached is what you do with them: ''It's okay to be furious. It's not okay to hit. Let's find another way to let the mad out.'' Kids who learn feelings are acceptable stop being afraid of their own inner weather, and stop acting it out sideways."},
    {"type":"p","text":"You can't spare your child big feelings — nobody can. But you can hand them the words, and the words are what turn an overwhelming storm into something a small person can actually name, and ride out."}
  ]$json$::jsonb, true
),
(
  'raising-kids-who-can-lose',
  'Raising Kids Who Can Lose: Why Letting Them Win Backfires',
  'Always letting a kid win feels kind. It quietly robs them of the one thing that makes winning meaningful — and losing survivable.',
  'Dr. Sarah Kim', '2026-06-29', 5, ARRAY['resilience','emotional health','play'], 'Wellness', false, '#f59e0b',
  'https://images.unsplash.com/photo-1610890716171-6b1bb98ffd09?auto=format&fit=crop&w=1600&q=80',
  'A family board game mid-play, pieces scattered across the board',
  'Unsplash',
  $json$[
    {"type":"p","text":"It's tempting to let your kid win — at the board game, the race to the car, the backyard match — because their delight is real and their meltdown over losing is exhausting. But a child who only ever wins never gets to practice the far more important skill: losing without falling apart. And they will lose, out in the world, where nobody's letting them win on purpose."},
    {"type":"h2","text":"Losing is a skill, and skills need reps"},
    {"type":"p","text":"Handling disappointment, managing frustration, being gracious when things don't go your way — these are learned through practice, and low-stakes family games are the ideal practice field. A lost game of checkers is a safe, small dose of the real thing. Rob a kid of those reps and their first real loss, when it finally comes, hits with no muscles built to absorb it."},
    {"type":"h2","text":"Model losing well yourself"},
    {"type":"p","text":"Kids learn how to lose by watching you lose. When you're beaten, show them the script: ''Aw, you got me! Good game — I'll get you next time.'' No sulking, no excuses, genuine congratulations for them. Your calm, cheerful defeat teaches more than any lecture on sportsmanship. They see that losing isn't a catastrophe; it's just a Tuesday, and there's always a next game."},
    {"type":"h2","text":"Coach the feeling, hold the line"},
    {"type":"p","text":"When they do lose and it stings, don't dismiss it (''it's just a game'') or rescue them (''okay, you win''). Name it and stay steady: ''Losing is really frustrating, I get it. You can be sad and we can still play again.'' You're teaching that big feelings and fair outcomes can coexist — that they can survive not winning, which is one of the most freeing things a kid can learn."},
    {"type":"p","text":"Let them lose sometimes, on the small stuff, in the safety of home. It's how you raise a kid who can win with grace and lose without shattering — both of which they'll need for the rest of their lives."}
  ]$json$::jsonb, true
),

-- ═══ FAMILY FINANCES ═════════════════════════════════════════════════════════
(
  'teaching-teens-about-credit',
  'Teach Your Teen About Credit Before the World Does',
  'Credit card offers will find your kid the moment they turn eighteen. The only question is whether they''ll be ready or blindsided.',
  'David Okafor', '2026-07-01', 6, ARRAY['teens','credit','money skills'], 'Family Finances', true, '#f43f5e',
  'https://images.unsplash.com/photo-1611371805429-8b5c1b2c34ba?auto=format&fit=crop&w=1600&q=80',
  'A close-up of a board game money track — the family economy in miniature',
  'Unsplash',
  $json$[
    {"type":"p","text":"The day your child turns eighteen, the credit card offers start arriving, and the world begins teaching them about debt whether you've prepared them or not. The lessons the world teaches are expensive — minimum payments, compounding interest, a wrecked credit score before they can legally rent a car. Far better that the first teacher is you, at the kitchen table, where mistakes cost nothing."},
    {"type":"h2","text":"Explain what credit actually is"},
    {"type":"p","text":"Most teens have no mental model for credit beyond ''free money on a card.'' Demystify it plainly: a credit card is a short-term loan you must repay, and if you don't repay it in full, you pay rent on that money — often brutally high rent. Walk through a real example: a $1,000 balance at minimum payments can take years and hundreds of dollars in interest to clear. Numbers land harder than warnings."},
    {"type":"h2","text":"Teach the score, and why it matters"},
    {"type":"p","text":"A credit score is an invisible number that will quietly gate their adult life — apartments, car loans, even some jobs. Explain that it's built slowly through reliability: borrowing a little, paying it back on time, every time. Framing it as a reputation they're building, rather than an abstract number, helps a teen understand why a single missed payment isn't nothing."},
    {"type":"h2","text":"Let them practice with training wheels"},
    {"type":"p","text":"Consider a supervised on-ramp — an authorized-user spot on your card, or a secured card for their own small expenses — while they're still under your roof and your guidance. Let them feel the full cycle: spend, get the statement, pay it off completely. A few months of real practice, with you as coach, builds habits that a lecture never could and that the world would otherwise teach them the hard way."},
    {"type":"p","text":"Credit is coming for your kid the moment they're legal. Teach it first, at home, where a mistake is a lesson instead of a years-long debt."}
  ]$json$::jsonb, true
),
(
  'the-first-bank-account',
  'The First Bank Account: A Rite of Passage Worth Doing Right',
  'Opening a kid''s first real account turns money from an abstraction into something they own, track, and manage. Here''s how to make it count.',
  'David Okafor', '2026-06-29', 5, ARRAY['money skills','saving','kids'], 'Family Finances', false, '#f43f5e',
  'https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?auto=format&fit=crop&w=1600&q=80',
  'A seedling sprouting from a pile of coins — money that grows',
  'Unsplash',
  $json$[
    {"type":"p","text":"There's a moment in a kid's financial education when the jar on the shelf isn't enough anymore, and it's time for a real bank account. Done thoughtfully, it's a genuine rite of passage — the point where money stops being coins in a container and becomes something they own, track, and manage in the actual system the adult world runs on. Done as a formality, it's a forgotten card in a drawer."},
    {"type":"h2","text":"Make the opening a real event"},
    {"type":"p","text":"Take them to do it, in person if you can, and let them be the one who talks to the banker, signs the forms, and makes the first deposit. The ceremony matters — it signals that this is a step up, a marker of growing responsibility. A kid who felt the weight of opening their own account treats it differently than one for whom it just appeared."},
    {"type":"h2","text":"Let them watch it grow"},
    {"type":"p","text":"The magic of a first account is seeing the balance rise — and meeting interest, the almost magical idea that money can earn a little money just by sitting there. For an older kid, this is the doorway to understanding compounding, the single most powerful force in personal finance. Watching even a few cents of interest appear makes an abstract concept suddenly, concretely real."},
    {"type":"h2","text":"Hand over real responsibility, gradually"},
    {"type":"p","text":"An account is only educational if the kid actually runs it. Let them check the balance, make deposits, and eventually manage a debit card for their own spending, with you as backup rather than boss. Yes, they'll overspend once and feel the pinch — and that safe, small mistake at fourteen is worth more than a lecture and cheaper than the same mistake at twenty-four."},
    {"type":"p","text":"The first bank account is a milestone. Treat it like one, hand over real ownership, and you turn a piece of plastic into one of the most practical lessons your kid will ever get."}
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
