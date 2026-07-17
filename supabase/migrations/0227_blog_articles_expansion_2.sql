-- FamilyOS :: 0227 Blog articles — expansion batch 2
-- ----------------------------------------------------------------------------
-- Adds a second wave of original, editorially-voiced articles to public.blog_posts
-- across all six categories, matching the 0202/0226 format (JSON body blocks,
-- Unsplash hero + alt + credit, tags, accent color). Idempotent:
-- ON CONFLICT (slug) DO UPDATE, so re-running refreshes content without
-- duplicating rows. Hero images reuse the production-verified Unsplash pool
-- (free, known-good — no broken images). SEO/AEO is handled in code
-- (lib/blog/structured-data.ts → BlogPosting + BreadcrumbList + speakable on
-- every article; sitemap already lists all slugs).

INSERT INTO public.blog_posts
  (slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color,
   hero_image_url, hero_image_alt, hero_image_credit, body, published)
VALUES

-- ═══ PARENTING ═══════════════════════════════════════════════════════════════
(
  'raising-a-kid-who-can-be-bored',
  'Why Boredom Is a Gift (and How to Stop Rescuing Kids From It)',
  'A bored kid isn''t a problem to solve. It''s a kid standing at the doorway of their own imagination — if you''ll just stop opening it for them.',
  'Jessica Miller', '2026-07-07', 5, ARRAY['child development','play','screen time'], 'Parenting', true, '#7c5dff',
  'https://images.unsplash.com/photo-1476234251651-f353703a034d?auto=format&fit=crop&w=1600&q=80',
  'A parent and child reading a book together outdoors',
  'Unsplash',
  $json$[
    {"type":"p","text":"''I'm booooored'' lands like an accusation, and most of us treat it like one — scrambling to produce a snack, a screen, an activity, anything to make the discomfort stop. But boredom isn't a wound to bandage. It's the exact moment a kid runs out of external input and has to reach for something internal. Rescue them too fast and you skip the best part."},
    {"type":"h2","text":"Boredom is the on-ramp to imagination"},
    {"type":"p","text":"Every blanket fort, invented game, and elaborate backyard saga was born in the dead air right after ''there's nothing to do.'' A child who is never bored is never forced to become their own entertainment — and that's a muscle, not a mood. It only grows under the mild strain of an empty afternoon."},
    {"type":"h2","text":"Your job is to hold the space, not fill it"},
    {"type":"p","text":"When the complaint comes, try the radical response: ''I believe you. Boredom is a great place to start.'' Then don't fix it. The first ten minutes may be whiny. The eleventh is often when the LEGO comes out, or the couch becomes a ship. You're not being neglectful; you're refusing to be the world's most convenient off-switch."},
    {"type":"h2","text":"Stock the environment, not the schedule"},
    {"type":"p","text":"You can help without hovering. A shelf of open-ended stuff — paper, tape, blocks, dress-up bins, a junk drawer of craft odds and ends — turns boredom into raw material. Notice these are the opposite of a screen: they demand something from the kid instead of doing the work for them."},
    {"type":"p","text":"The goal isn't a childhood free of ''I'm bored.'' It's a kid who eventually stops saying it — because they've learned that the feeling is just the sound of an idea about to arrive."}
  ]$json$::jsonb, true
),
(
  'the-repair-is-the-lesson',
  'You''ll Lose Your Temper. The Repair Is the Real Parenting.',
  'Every parent snaps eventually. What your kid actually learns from isn''t the moment you blew it — it''s what you do in the ten minutes after.',
  'Marcus Bennett', '2026-07-06', 6, ARRAY['discipline','emotional health','communication'], 'Parenting', false, '#7c5dff',
  'https://images.unsplash.com/photo-1476703993599-0035a21b17a9?auto=format&fit=crop&w=1600&q=80',
  'A parent kneeling to talk at eye level with a young child outdoors',
  'Unsplash',
  $json$[
    {"type":"p","text":"You will lose it. You'll use the sharp voice, say the thing you regret, slam the drawer a little too hard. The myth of the endlessly patient parent has ruined more evenings with guilt than any actual mistake. Here's the reframe that changes everything: the rupture isn't the failure. Skipping the repair is."},
    {"type":"h2","text":"Kids don''t need perfect — they need repaired"},
    {"type":"p","text":"A child raised by a flawless robot learns nothing about being human. A child who sees a parent mess up and then come back — ''I was frustrated and I raised my voice, and that wasn't fair to you'' — learns the single most important relationship skill there is: how to be wrong and make it right. You can only teach repair by needing it."},
    {"type":"h2","text":"The repair has three small parts"},
    {"type":"p","text":"Name what happened (''I yelled''). Own your part without a ''but you...'' escape hatch (''that was about my stress, not your mistake''). And reconnect (''I love you, and we're okay''). Thirty seconds. Notice you're not apologizing for the boundary — bedtime is still bedtime — only for the delivery."},
    {"type":"h2","text":"Repair is not weakness, and kids can tell"},
    {"type":"p","text":"Some parents fear that apologizing hands over authority. The opposite is true. A parent secure enough to say ''I got that wrong'' models exactly the strength you want your kid to have at sixteen, at thirty, in their own marriage. Fragile authority can't admit error. Real authority repairs and stays standing."},
    {"type":"p","text":"So stop chasing a temper you'll never fully tame, and get good at the thing that actually raises a person: coming back."}
  ]$json$::jsonb, true
),

-- ═══ ORGANIZATION ════════════════════════════════════════════════════════════
(
  'stop-buying-bins',
  'Stop Buying Bins: Why the Container Comes Last',
  'A cart full of matching baskets feels like progress. It''s usually just clutter with better lighting. Do the steps in the right order.',
  'Priya Anand', '2026-07-07', 5, ARRAY['decluttering','home systems','organizing'], 'Organization', true, '#3b82f6',
  'https://images.unsplash.com/photo-1584697964358-3e14ca57658b?auto=format&fit=crop&w=1600&q=80',
  'A parent raising her arms in triumph at a tidy desk — on top of everything for once',
  'Unsplash',
  $json$[
    {"type":"p","text":"There's a specific dopamine hit in buying organizing containers. You walk out with a cart of matching bins feeling like the problem is already half-solved. It isn't. Buying storage before you've decided what stays is like buying a bigger wallet to fix being broke. The container is the last step, not the first."},
    {"type":"h2","text":"The order is: reduce, sort, contain"},
    {"type":"p","text":"First cut what you don't need — you can't organize your way out of owning too much. Then sort what's left into real categories. Only then do you know what container you actually need, because the stuff has told you its shape and size. Buy bins first and you'll spend the afternoon organizing things you were about to throw away."},
    {"type":"h2","text":"Empty space is allowed to exist"},
    {"type":"p","text":"A common trap: a shelf isn't ''done'' until it's full, so we buy things to fill the nice new baskets. Resist it. A half-empty, well-sorted drawer is a finished project. Breathing room is the whole point — it's what makes the system easy to keep, and easy-to-keep is the only kind that survives a busy week."},
    {"type":"h2","text":"Contain by behavior, not by beauty"},
    {"type":"p","text":"The best container matches how your family actually moves, not how the photo looks. Kids will chuck a ball into an open bin and never lift a lid. A clear front means nobody forgets what's inside. Design for the real humans in your house on their laziest day, and the system quietly holds. Design for the magazine and you'll be re-tidying by Thursday."},
    {"type":"p","text":"Put the credit card away until the sorting's done. Nine times out of ten you already own the container you need — it's just currently full of stuff you were ready to let go of."}
  ]$json$::jsonb, true
),
(
  'the-fifteen-minute-family-tidy',
  'The 15-Minute Family Tidy That Beats a Weekend Deep Clean',
  'The dread of a whole-house cleanup is what keeps the house messy. A short, loud, everybody-in sprint does more than a resentful Saturday.',
  'Priya Anand', '2026-07-06', 4, ARRAY['cleaning','routines','teamwork'], 'Organization', false, '#3b82f6',
  'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=1600&q=80',
  'A tidy, sunlit entryway with a small tray for keys and mail',
  'Unsplash',
  $json$[
    {"type":"p","text":"The weekend deep clean is a monster of our own making. It looms all week, ruins Saturday morning, and turns one parent into the household's unpaid, resentful supervisor. There's a smaller, better tool hiding in plain sight: fifteen minutes, everyone at once, most days. It sounds too minor to matter. It quietly beats the marathon."},
    {"type":"h2","text":"Set a timer and make it a sprint"},
    {"type":"p","text":"Fifteen minutes on a literal timer changes the physics of cleaning. It's short enough that nobody negotiates their way out, and a countdown turns a chore into a game. Kids who''d melt down over ''clean your room for an hour'' will race a clock for fifteen. The finish line is the trick."},
    {"type":"h2","text":"Everybody at the same time, or it doesn''t work"},
    {"type":"p","text":"The magic ingredient is simultaneity. When one person tidies while others lounge, resentment brews and the job feels endless. When the whole family moves at once — music on, everyone in motion — it becomes a shared push instead of one martyr's burden. Fifteen minutes times five people is over an hour of work that feels like ten minutes."},
    {"type":"h2","text":"Reset, don''t perfect"},
    {"type":"p","text":"The goal of the daily tidy isn't spotless; it's ''reset to baseline.'' Surfaces cleared, things back in their homes, tomorrow starting from calm instead of chaos. Deep cleaning — the baseboards, the fridge — still happens, but rarely and on purpose, not as a frantic response to a house that got away from you."},
    {"type":"p","text":"Do it after dinner, most nights. You'll trade one dreaded Saturday for a house that never gets bad enough to need one."}
  ]$json$::jsonb, true
),

-- ═══ SCHOOL & ACTIVITIES ═════════════════════════════════════════════════════
(
  'the-homework-battle-isnt-about-homework',
  'The Homework Battle Isn''t About Homework',
  'The nightly fight is almost never about the worksheet. It''s about autonomy, energy, and a kid who''s been ''on'' since 7 a.m.',
  'Elena Rodriguez', '2026-07-07', 6, ARRAY['school','homework','routines'], 'School & Activities', true, '#10b981',
  'https://images.unsplash.com/photo-1427504494785-3a9ca7044f45?auto=format&fit=crop&w=1600&q=80',
  'Tall library shelves lined with colorful books',
  'Unsplash',
  $json$[
    {"type":"p","text":"By the time the homework fight starts, your kid has been following instructions for eight hours straight. They've raised their hand, walked in lines, sat still, and regulated themselves through a whole social minefield. The worksheet isn't the problem — it's the last straw on a nervous system that's completely tapped out. Fight the worksheet and you'll lose. Address the tank."},
    {"type":"h2","text":"Refuel before you require"},
    {"type":"p","text":"A snack and a genuine break — twenty minutes of running around, no screens if you can swing it — does more for homework than any amount of nagging. You can't pour productivity out of an empty kid. The most efficient path through homework often starts with not doing homework for half an hour."},
    {"type":"h2","text":"Give back a little control"},
    {"type":"p","text":"After a day of zero choices, a kid will fight to the death over the one thing they can control — this. So hand some of it back: ''math first or reading first?'' ''at the table or on the floor?'' The content isn't negotiable, but the how can be. A small dose of autonomy defuses a shocking amount of resistance."},
    {"type":"h2","text":"Be the coach, not the co-author"},
    {"type":"p","text":"Hovering and correcting turns their homework into your project, and kids resist a takeover. Sit nearby, available but not controlling. Let them own the struggle and even the wrong answers — a mistake that gets a gentle note from a teacher teaches more than a parent-perfected page that taught nobody anything."},
    {"type":"p","text":"When the nightly battle keeps happening at the same time in the same way, stop debating the homework and start fixing the hour around it. The worksheet was never the war."}
  ]$json$::jsonb, true
),
(
  'how-to-let-a-kid-quit',
  'How to Let a Kid Quit an Activity (Without Raising a Quitter)',
  'There''s a difference between building grit and forcing a miserable kid to finish a thing they hate. Here''s how to tell them apart.',
  'Elena Rodriguez', '2026-07-05', 6, ARRAY['activities','resilience','balance'], 'School & Activities', false, '#10b981',
  'https://images.unsplash.com/photo-1495364141860-b0d03eccd065?auto=format&fit=crop&w=1600&q=80',
  'Kids playing freely in a park at golden hour',
  'Unsplash',
  $json$[
    {"type":"p","text":"''We don't quit in this family.'' It's a proud sentence, and sometimes it's exactly right. Other times it's how a kid ends up crying in a car every Tuesday for a season nobody's enjoying, learning mostly that their misery doesn't count. Grit is real and worth building. So is knowing when a thing is just wrong for you. The skill is telling them apart."},
    {"type":"h2","text":"Finish the commitment, then decide"},
    {"type":"p","text":"A workable family rule: you honor the commitment you made — the season, the session, the recital you're part of — because a team is counting on you and that matters. But when it's done, nobody's chained to the next one. This threads the needle: it teaches follow-through without pretending every activity is a life sentence."},
    {"type":"h2","text":"Diagnose the ''why'' before you rule"},
    {"type":"p","text":"''I want to quit'' can mean very different things. Is it a hard week, a mean coach, a fear of failing, or genuine ''this isn't me''? The first three are worth pushing through — that's where grit is actually built. The last one is worth honoring. Ask questions before you make it a values stand; sometimes it's a Tuesday problem, not a soccer problem."},
    {"type":"h2","text":"Quitting the wrong thing frees the right one"},
    {"type":"p","text":"There's nothing noble about grinding through an activity a kid hates while the thing they'd love goes untried because the calendar's full. Sometimes the gutsiest move is to stop — to admit this wasn't it and make room for what might be. That's not raising a quitter. That's raising someone who knows their own ''yes'' is worth protecting."},
    {"type":"p","text":"Grit means finishing what you start. Wisdom means choosing what to start. A good childhood teaches both — and knows they're not the same lesson."}
  ]$json$::jsonb, true
),

-- ═══ AI & TECHNOLOGY ═════════════════════════════════════════════════════════
(
  'one-shared-calendar-or-chaos',
  'One Shared Calendar, or Everyone''s Living in a Different Week',
  'When each parent keeps the schedule in their own head, you don''t have a plan — you have two plans that collide on Thursday.',
  'Jessica Miller', '2026-07-07', 5, ARRAY['ai','calendar','mental load'], 'AI & Technology', true, '#6366f1',
  'https://images.unsplash.com/photo-1531482615713-2afd69097998?auto=format&fit=crop&w=1600&q=80',
  'A phone showing a busy shared calendar on a kitchen counter',
  'Unsplash',
  $json$[
    {"type":"p","text":"Here's a scene every household knows: one parent scheduled a dentist visit, the other booked a make-up soccer game, and they discover the collision at 3 p.m. Thursday with both kids in the car. Nobody did anything wrong. They just each kept the family's schedule in a separate head. Two private calendars aren't a plan — they're a slow-motion crash."},
    {"type":"h2","text":"The schedule has to live outside your heads"},
    {"type":"p","text":"The single highest-leverage fix in family logistics is one shared calendar that both parents (and older kids) can see and edit. Not ''I'll tell you later.'' Not a fridge whiteboard only one person updates. A living, shared source of truth. The moment the week exists in one place instead of two memories, the Thursday collisions mostly stop."},
    {"type":"h2","text":"Shared only works if updating is frictionless"},
    {"type":"p","text":"A shared calendar nobody updates is just a prettier way to be out of sync. The difference-maker is how easy it is to add things — ideally by just saying them. This is where an AI family assistant earns its place: ''Add Maya's recital next Friday at six'' becomes an event everyone sees, without opening an app and tapping through five screens. Low friction is what keeps it true."},
    {"type":"h2","text":"See the whole family, not just yourself"},
    {"type":"p","text":"The real payoff is a color-coded view of everyone at once, so you catch the pile-up before it happens — the night all three kids need rides in different directions. You can't solve a conflict you can't see. A shared calendar turns invisible collisions into visible ones you can fix on Sunday instead of survive on Thursday."},
    {"type":"p","text":"You don't need to be more organized. You need to stop keeping the plan in two places that were always going to disagree."}
  ]$json$::jsonb, true
),
(
  'the-analog-hour',
  'The Analog Hour: Why Every Screen-Age Family Needs One',
  'You don''t have to win the war against screens. You just have to carve out one reliable hour a week where they''re simply not invited.',
  'Marcus Bennett', '2026-07-05', 5, ARRAY['screen time','family time','digital wellbeing'], 'AI & Technology', false, '#6366f1',
  'https://images.unsplash.com/photo-1610890716171-6b1bb98ffd09?auto=format&fit=crop&w=1600&q=80',
  'A colorful strategy board game mid-play, pieces scattered across the board',
  'Unsplash',
  $json$[
    {"type":"p","text":"Trying to banish screens from a modern family is a war you'll lose, exhaustingly, every day. But you don't need to win the war — you need one demilitarized zone. Call it the Analog Hour: a single, reliable, recurring block where every screen in the house, adults' included, goes in a basket, and the family does something with its hands and faces."},
    {"type":"h2","text":"One protected hour beats a hundred rules"},
    {"type":"p","text":"Scattered limits — ''thirty more minutes,'' ''not at the table'' — turn every day into a negotiation. A single named ritual sidesteps all of it. Friday game night. Sunday pancakes-and-cards. It's not a restriction the kids resent; it's a thing your family does. Positive and predictable beats a running list of nos."},
    {"type":"h2","text":"Board games are secretly doing real work"},
    {"type":"p","text":"An hour around a board game is a stealth curriculum: taking turns, losing gracefully, reading faces, thinking a few moves ahead, trash-talking within bounds. None of it feels like a lesson, which is exactly why it works. The point is the shared table — the game is just the excuse that gets everyone to sit at it."},
    {"type":"h2","text":"The phones go away too — especially yours"},
    {"type":"p","text":"The whole thing collapses the second a parent ''just checks something.'' Kids read that instantly: the rule is for them, not us. Put every device in the basket, yours first. An hour where the adults are fully, visibly present is worth more than the activity itself — it tells the kids they're more interesting than the feed."},
    {"type":"p","text":"You're not deleting technology from childhood. You're proving, one hour a week, that the family is better than anything on a screen — and letting the kids feel it for themselves."}
  ]$json$::jsonb, true
),

-- ═══ WELLNESS ════════════════════════════════════════════════════════════════
(
  'the-parenting-shift-change',
  'The Shift Change: How Two Parents Stop Both Running on Empty',
  'The most exhausted households aren''t short on love — they''re short on a handoff. One deliberate trade can save the whole evening.',
  'Dr. Sarah Kim', '2026-07-07', 5, ARRAY['stress','partnership','self-care'], 'Wellness', true, '#f59e0b',
  'https://images.unsplash.com/photo-1554224154-26032ffc0d07?auto=format&fit=crop&w=1600&q=80',
  'A parent taking a calm breath by a window with a warm drink',
  'Unsplash',
  $json$[
    {"type":"p","text":"In a lot of two-parent homes, both adults are running at empty by 8 p.m. — not because either is doing too little, but because nobody ever gets fully off. Parenting becomes one endless shift with no relief pitcher. The fix isn't more willpower. It's borrowed from every job that runs around the clock: a real shift change."},
    {"type":"h2","text":"Somebody has to actually be off"},
    {"type":"p","text":"Half-present rest isn't rest. If one parent is ''relaxing'' on the couch but still fielding ''MOM! MOM!'' every ninety seconds, they never recover. A shift change means one parent is genuinely on — the point person for spills, referee calls, and the bedtime campaign — while the other is genuinely off, no guilt, no hovering. Then you trade."},
    {"type":"h2","text":"Name the handoff out loud"},
    {"type":"p","text":"''I've got bedtime, you're off until nine'' takes three seconds and prevents a whole category of resentment. The unspoken version — where you both hope the other one steps up — is where scorekeeping is born. An explicit handoff turns a silent competition over who's more tired into a plan that gives each of you a real break."},
    {"type":"h2","text":"Protect the off-shift like it matters, because it does"},
    {"type":"p","text":"The parent who's off should do something that actually refills them — a walk, a bath, a chapter, a call with a friend — not just a different chore. Twenty real minutes of restoration makes the on-shift parent's next turn easier too, because a rested partner is a kinder, steadier one. You're not being selfish; you're maintaining the equipment."},
    {"type":"p","text":"You don't need a spa weekend to stop drowning. You need a handoff — small, deliberate, and repeated — so that no one in the house is on call every single hour."}
  ]$json$::jsonb, true
),
(
  'the-family-dinner-cure',
  'The Family Dinner Is the Cheapest Health Intervention You Have',
  'Decades of research keep pointing at the same unglamorous thing: kids who eat with their families do better. The meal is the medicine.',
  'Dr. Sarah Kim', '2026-07-06', 6, ARRAY['nutrition','family time','wellness'], 'Wellness', false, '#f59e0b',
  'https://images.unsplash.com/photo-1606787366850-de6330128bfc?auto=format&fit=crop&w=1600&q=80',
  'A colorful overhead spread of fresh food on a table',
  'Unsplash',
  $json$[
    {"type":"p","text":"If a pharmaceutical company could bottle the effects of regular family dinners, it would be the blockbuster drug of the century: better nutrition, bigger vocabularies, lower rates of anxiety and risky behavior, stronger family bonds. The ''active ingredient'' isn't the food. It's the sitting down together, on purpose, most nights."},
    {"type":"h2","text":"The table is where kids learn to talk — and listen"},
    {"type":"p","text":"A shared meal is a daily, low-stakes conversation lab. Kids pick up vocabulary, hear how adults disagree without blowing up, and get a reliable window to say the small thing that turns out to be the big thing. The dinner table is where ''how was your day'' occasionally cracks open into what's really going on."},
    {"type":"h2","text":"Perfect is the enemy of present"},
    {"type":"p","text":"Nobody's asking for a home-cooked feast every night. Cereal for dinner still counts if everyone's at the table with phones away. The intervention is the gathering, not the menu. Families who wait until they can pull off Instagram dinners end up eating in shifts in front of screens — and miss the entire benefit, which was never about the recipe."},
    {"type":"h2","text":"Guard it on the calendar"},
    {"type":"p","text":"Family dinner loses to everything — practice, work, one more errand — unless you give it the same status as those things. Pick the nights you can realistically hold, put them on the shared calendar, and defend them like appointments. Three protected dinners a week beat seven you keep meaning to have and never do."},
    {"type":"p","text":"It's the cheapest, most evidence-backed thing you can do for your kids' long-term health, and it's hiding in plain sight at 6 p.m. Sit down. That's the whole prescription."}
  ]$json$::jsonb, true
),

-- ═══ FAMILY FINANCES ═════════════════════════════════════════════════════════
(
  'the-first-savings-goal',
  'The Power of the First Savings Goal: Teaching a Kid to Wait',
  'You can''t lecture a child into patience with money. But you can let them feel it — one slowly-filling jar aimed at one wanted thing.',
  'David Okafor', '2026-07-07', 6, ARRAY['saving','money skills','allowance'], 'Family Finances', true, '#f43f5e',
  'https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?auto=format&fit=crop&w=1600&q=80',
  'A seedling sprouting from a pile of coins — money that grows',
  'Unsplash',
  $json$[
    {"type":"p","text":"Delayed gratification is the money skill that quietly predicts a good financial life — and it's almost impossible to teach with words. ''Be patient, save your money'' means nothing to a seven-year-old. But a clear jar slowly filling toward one specific, wanted thing? That teaches it in the body, where lessons actually stick."},
    {"type":"h2","text":"Make it one real, chosen goal"},
    {"type":"p","text":"Vague saving is boring and abstract. A named target the kid actually wants — that particular LEGO set, that game, that scooter — turns saving into a quest. Write it on the jar. Tape a picture to it. The goal has to be theirs, not yours; the wanting is the engine that makes the waiting worth it."},
    {"type":"h2","text":"Make the progress visible"},
    {"type":"p","text":"A clear jar beats a bank balance for a young kid every time, because they can see it filling. Each coin is measurable progress toward the thing. Watching the level rise — and doing the math on how many weeks are left — is where patience gets its reward in advance, in anticipation. Visible progress is what makes the wait tolerable."},
    {"type":"h2","text":"Do not rescue them at the finish line"},
    {"type":"p","text":"The hardest and most important part: let them get all the way there themselves. Don't top off the jar to end the wait early, however tempting. The entire lesson lives in the gap between wanting and having. When they finally buy the thing with money they saved, the pride on their face is the payoff — and it's one they'll chase for the rest of their life."},
    {"type":"p","text":"One jar, one goal, one uninterrupted wait. That's a better start on money than most of us ever got, and it fits on a kitchen shelf."}
  ]$json$::jsonb, true
),
(
  'talk-about-money-at-dinner',
  'Why Your Kids Should Hear You Talk About Money',
  'Most of us inherited our money habits by osmosis — from a silence full of stress. You can hand your kids something better: the actual conversation.',
  'David Okafor', '2026-07-05', 5, ARRAY['money skills','communication','family finances'], 'Family Finances', false, '#f43f5e',
  'https://images.unsplash.com/photo-1611371805429-8b5c1b2c34ba?auto=format&fit=crop&w=1600&q=80',
  'A close-up of a classic board game money track — the family economy in miniature',
  'Unsplash',
  $json$[
    {"type":"p","text":"Ask an adult where they learned about money and most will shrug. They absorbed it — from a parent's clenched jaw at bill time, from ''we can't afford that'' said sharply, from a silence that made money feel dangerous and shameful. Kids learn about money whether or not you teach them. The only question is whether they learn it from a conversation or from tension."},
    {"type":"h2","text":"Break the taboo, on purpose"},
    {"type":"p","text":"Money is one of the last real taboos in a lot of families — we'll discuss almost anything before the budget. But silence doesn't protect kids; it just leaves them to fill the gap with anxiety and guesswork. Age-appropriate honesty — ''we're saving for a trip, so we're skipping takeout this month'' — turns money from a scary mystery into a normal, manageable topic."},
    {"type":"h2","text":"Narrate the everyday decisions"},
    {"type":"p","text":"You don't need a formal lesson. Just think out loud during real choices: why you're comparing prices, why you picked the store brand, why you're waiting for the sale, why you give to that cause. This running narration is the single richest financial education a kid can get, and it costs nothing but a few extra sentences at the shelf."},
    {"type":"h2","text":"Let them see trade-offs, not just ''no''"},
    {"type":"p","text":"''We can't afford it'' teaches scarcity and shuts the door. ''We're choosing to spend on this instead of that'' teaches the actual truth about money — that it's finite and that spending is choosing. Even ''let's see if it's worth it'' models a decision process. Kids who grow up hearing trade-offs out loud become adults who can make them."},
    {"type":"p","text":"You're going to teach your kids about money no matter what. Do it with words and a calm voice, and you'll hand them something most of us had to learn the hard way."}
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
