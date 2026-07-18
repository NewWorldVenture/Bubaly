-- FamilyOS :: 0250 Blog articles — expansion batch 23
-- Two per category across all six /blog tabs (Parenting, Organization,
-- School & Activities, AI & Technology, Wellness, Family Finances). Topics vetted
-- against all 284 existing slugs for no repeated or near-duplicate topics. Every
-- hero image is a NEW curl-verified unique Unsplash photo (HTTP 200, not used by
-- any prior article — maintains the 0242 no-duplicate invariant). Honest,
-- category-appropriate alt text. Idempotent ON CONFLICT (slug) DO UPDATE.
-- SEO/AEO JSON-LD, #bubaly hashtags, and the Bubaly.com backlink are handled in
-- code and already apply to every article. Brings the total to 296 posts.

INSERT INTO public.blog_posts
  (slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color,
   hero_image_url, hero_image_alt, hero_image_credit, body, published)
VALUES

-- ═══ PARENTING ═══════════════════════════════════════════════════════════════
(
  'teaching-kids-to-take-a-compliment',
  'Teaching Kids to Take a Compliment',
  'Some kids deflect praise, some fish for more, and some freeze. Receiving a compliment graciously is a small social skill with an outsized effect on confidence and connection.',
  'Jessica Miller', '2026-05-11', 4, ARRAY['social skills','confidence','child development'], 'Parenting', true, '#7c5dff',
  'https://images.unsplash.com/photo-1484788984921-03950022c9ef?auto=format&fit=crop&w=1600&q=80',
  'A warm parenting moment in everyday family life', 'Unsplash',
  $json$[
    {"type":"p","text":"Watch a handful of kids get complimented and you will see the whole range: one deflects it (it was nothing), one immediately fishes for more, one argues with it (no, my drawing is terrible), and one just freezes and looks at the floor. Taking a compliment graciously looks trivial, but it is a real social skill — and how a kid receives praise quietly shapes their confidence and how comfortable they are being seen."},
    {"type":"h2","text":"Model it first"},
    {"type":"p","text":"Kids learn how to receive praise by watching how you do it. If every compliment you get is met with a deflection or a self-put-down, that is the script they will copy. Practice a simple, warm thank you when someone praises you, and let your kids see it. You are showing them that accepting a kind word is not bragging — it is just letting the kindness land."},
    {"type":"h2","text":"Give the two-word tool"},
    {"type":"p","text":"When a kid does not know what to do with a compliment, the discomfort is often just not having the words. Give them a tiny script: thank you. That is the whole skill to start. They do not have to agree, argue, or return the compliment — just receive it and say thank you. Practice it lightly at home so it is automatic when it counts, and the freezing and deflecting fade."},
    {"type":"h2","text":"Separate praise from pressure"},
    {"type":"p","text":"Some kids deflect praise because it feels like a bar they now have to keep clearing. Help them hear a compliment as an observation, not a contract — someone noticed something good today, and that is all it has to mean. When kids stop treating praise as pressure to be perfect next time, they can simply enjoy it, which is the entire point of receiving it well."},
    {"type":"p","text":"Taking a compliment is a small skill with a long reach. Model gracious receiving, hand kids the two-word thank-you tool, and separate praise from pressure — and you will raise a kid who can let a kind word land without deflecting, arguing, or shrinking, and feel a little more comfortable being seen."}
  ]$json$::jsonb, true
),
(
  'the-power-of-a-family-motto',
  'The Power of a Family Motto',
  'A short phrase your family says out loud — in this house we tell the truth, we do hard things — turns your values from a lecture into a shared identity kids carry with them.',
  'Marcus Bennett', '2026-05-10', 5, ARRAY['family culture','values','connection'], 'Parenting', false, '#7c5dff',
  'https://images.unsplash.com/photo-1550525811-e5869dd03032?auto=format&fit=crop&w=1600&q=80',
  'A warm parenting moment in everyday family life', 'Unsplash',
  $json$[
    {"type":"p","text":"Most families have values, but they live in a thousand scattered lectures. A family motto gathers them into one short, memorable phrase you say out loud — in this house we tell the truth, we do hard things, we are a team. It sounds almost too simple to matter, but a shared phrase turns values from something you nag about into something your family is, an identity kids carry out the door with them."},
    {"type":"h2","text":"Make it short and true"},
    {"type":"p","text":"A motto works because it is short enough to remember and true enough to mean something. Pick a handful of words that capture what actually matters most to your family — not an aspirational slogan you do not live, but the real thing you keep coming back to. If it is too long or too polished, no one will say it. A few honest words beat a beautiful paragraph nobody remembers."},
    {"type":"h2","text":"Say it at the door and in the hard moments"},
    {"type":"p","text":"A motto only works if it gets said. Use it at natural moments — a quick we are a team as they head out, a gentle we do hard things when something is tough, a we tell the truth when honesty is on the line. Repeated in real moments rather than delivered as a speech, the phrase becomes a shortcut to a whole value, and eventually kids say it back to themselves when you are not there."},
    {"type":"h2","text":"Let the kids help write it"},
    {"type":"p","text":"A motto handed down as a rule lands differently than one the family made together. Let the kids weigh in on the words — what matters to us, what do we want to be about. When kids help write the phrase, they own it, and a motto they helped choose is one they will actually repeat and defend rather than roll their eyes at."},
    {"type":"p","text":"A family motto is a tiny tool with a long reach. Keep it short and true, say it at the door and in the hard moments, and let the kids help write it — and you will turn your scattered values into a shared identity your kids carry with them long after the lecture would have been forgotten."}
  ]$json$::jsonb, true
),

-- ═══ ORGANIZATION ════════════════════════════════════════════════════════════
(
  'a-system-for-school-paper-overload',
  'A System for School Paper Overload',
  'Permission slips, artwork, graded work, and flyers pour in daily and pile up on every surface. A simple sort-on-arrival system stops the paper avalanche before it buries the kitchen.',
  'Priya Anand', '2026-05-11', 4, ARRAY['home systems','decluttering','school'], 'Organization', true, '#3b82f6',
  'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1600&q=80',
  'A calm, organized home scene', 'Unsplash',
  $json$[
    {"type":"p","text":"Every school day sends a fresh wave of paper home: permission slips that need signing, flyers for events, graded worksheets, and a rotating gallery of artwork. Left alone, it lands on the counter, migrates to the table, and becomes a geological pile where the field-trip form goes to die. The fix is not more folders — it is a simple system that sorts the paper the moment it arrives, before it can pile up."},
    {"type":"h2","text":"Sort on arrival, not later"},
    {"type":"p","text":"The pile forms because paper gets set down to deal with later, and later never comes. The core habit is to handle each page once, on arrival: as backpacks unload, everything paper goes straight into a sort — not onto a surface. Deciding in the moment (act, keep, or recycle) stops the avalanche at the source, because nothing gets the chance to accumulate into a pile in the first place."},
    {"type":"h2","text":"Three destinations, that is all"},
    {"type":"p","text":"Keep the sort brutally simple with three destinations. Action — anything that needs a signature or a response goes to one visible spot you check daily so nothing is missed. Keep — the small handful of artwork or work worth saving goes into one dedicated box, not the counter. Recycle — everything else, which is most of it, leaves the house immediately. Three homes, decided fast, and the paper flow has somewhere to go."},
    {"type":"h2","text":"Photograph the keepers"},
    {"type":"p","text":"Most families keep too much art and schoolwork out of guilt, and it becomes its own clutter problem. A gentle fix is to photograph the keepers — snap the drawing or the proud spelling test, and let the digital copy carry the memory. Save only a few true favorites physically. Your kids will not miss the ninety-eighth painting, and you get the memory without the mountain."},
    {"type":"p","text":"School paper overload is a daily, predictable flood with a simple answer. Sort on arrival instead of later, send everything to one of three destinations, and photograph the keepers — and the paper avalanche stops burying your counters, replaced by a light system that handles the flow the moment it walks in the door."}
  ]$json$::jsonb, true
),
(
  'a-home-for-every-water-bottle',
  'A Home for Every Water Bottle',
  'Reusable water bottles multiply, vanish, and reappear growing science experiments under car seats. A simple bottle system ends the daily hunt and the funky-lid surprise.',
  'David Chen', '2026-05-10', 4, ARRAY['home systems','decluttering','organizing'], 'Organization', false, '#3b82f6',
  'https://images.unsplash.com/photo-1556740738-b6a63e27c4df?auto=format&fit=crop&w=1600&q=80',
  'A calm, organized home scene', 'Unsplash',
  $json$[
    {"type":"p","text":"Reusable water bottles were supposed to simplify life, and instead they quietly took over. Every kid has three, the cabinet avalanches when you open it, lids never match bottles, and every so often you find one that has been fermenting under a car seat for a week. The daily where-is-my-bottle hunt and the funky-lid surprise are small frictions, but a simple bottle system clears them both."},
    {"type":"h2","text":"Cull the collection"},
    {"type":"p","text":"Start by gathering every bottle in the house into one pile, and be honest about how many you actually need. Toss the ones with lost lids, cracked seals, or a permanent smell, along with the freebies and duplicates. Most families are storing a startling number of bottles for no reason. Keeping just one or two good bottles per person shrinks the chaos more than any organizer could."},
    {"type":"h2","text":"Give bottles one shelf"},
    {"type":"p","text":"The cabinet avalanche happens because bottles have no defined home. Assign them a single shelf or bin — bottles here, and only here. When there is one known spot where bottles live and return to, the hunt ends because there is an answer to where is my bottle. A contained home also stops them from colonizing every cabinet and counter in the kitchen."},
    {"type":"h2","text":"Make the nightly return a habit"},
    {"type":"p","text":"The fermenting-bottle surprise comes from bottles that never made it back. Build a simple nightly habit: every bottle comes back to the kitchen and gets rinsed before bed — none left in bags, cars, or bedrooms overnight. A quick end-of-day sweep keeps bottles from disappearing into the wild and turning into science experiments, and guarantees a clean one is ready the next morning."},
    {"type":"p","text":"Water-bottle chaos is a small daily frustration with a simple fix. Cull the collection down to what you need, give bottles one shelf to live on, and make the nightly return a habit — and you will end the cabinet avalanche, the morning hunt, and the funky-lid surprise with a lightweight system that keeps working."}
  ]$json$::jsonb, true
),

-- ═══ SCHOOL & ACTIVITIES ═════════════════════════════════════════════════════
(
  'helping-kids-recover-from-a-failed-test',
  'Helping Kids Recover From a Failed Test',
  'A bad grade can feel like a verdict to a kid. How you respond in the first ten minutes shapes whether they learn resilience or just learn to hide the paper next time.',
  'Sarah Thompson', '2026-05-11', 5, ARRAY['school','resilience','emotional health'], 'School & Activities', true, '#10b981',
  'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=1600&q=80',
  'A bright learning moment for a young student', 'Unsplash',
  $json$[
    {"type":"p","text":"A failed test can hit a kid hard — not just disappointment but a quiet verdict about whether they are smart, capable, or good enough. What you do in the first ten minutes after you see that grade matters more than the grade itself. Handled well, a bad test becomes a lesson in resilience; handled poorly, it teaches a kid to hide the next paper at the bottom of the backpack."},
    {"type":"h2","text":"Lead with the relationship, not the grade"},
    {"type":"p","text":"Before any conversation about study habits, make sure your kid knows the grade did not change how you feel about them. Lead with warmth — that looks like it was a rough one, how are you feeling — rather than a lecture. When kids feel safe rather than judged, they stay open to learning from the mistake. When they feel their worth is on the line, they shut down or start hiding, and nothing gets fixed."},
    {"type":"h2","text":"Get curious about what happened"},
    {"type":"p","text":"A grade is information, not a character report. Get curious together about what actually went wrong: was it not understanding the material, running out of time, a rough test day, or not studying the right things. Different causes need different fixes, and a kid who learns to diagnose their own stumbles — rather than just feeling bad about them — is building a skill that outlasts any single test."},
    {"type":"h2","text":"Make a small, concrete next step"},
    {"type":"p","text":"Resilience is not just feeling better; it is doing something. Turn the post-mortem into one small, concrete step — ask the teacher about the confusing part, redo two problems, or change one thing about how they studied. A single doable action turns a failure from a dead end into a starting point, and shows kids that a bad grade is something you respond to, not something you are."},
    {"type":"p","text":"How you handle a failed test teaches your kid what failure means. Lead with the relationship rather than the grade, get curious about what actually happened, and land on one small concrete next step — and you will raise a kid who can recover from a bad grade with resilience instead of shame, and who brings you the next hard paper instead of hiding it."}
  ]$json$::jsonb, true
),
(
  'the-reading-log-reimagined',
  'The Reading Log, Reimagined',
  'The nightly reading log turns books into a chore of minutes and signatures. A few small changes keep the accountability while giving kids back the joy of the story.',
  'Amara Okafor', '2026-05-10', 4, ARRAY['reading','school','learning'], 'School & Activities', false, '#10b981',
  'https://images.unsplash.com/photo-1513258496099-48168024aec0?auto=format&fit=crop&w=1600&q=80',
  'A bright learning moment for a young student', 'Unsplash',
  $json$[
    {"type":"p","text":"The nightly reading log has a way of turning reading into paperwork. Twenty minutes, log the pages, get the parent signature — and somewhere in the tracking, the story disappears. Kids start watching the clock instead of the plot, and a habit meant to build a love of reading quietly teaches them that reading is a chore. The log itself is not the enemy, but a few small changes can keep the accountability while giving the joy back."},
    {"type":"h2","text":"Track the story, not just the minutes"},
    {"type":"p","text":"A log that only counts minutes trains kids to endure reading rather than enjoy it. Shift the focus to the story: talk for a minute about what happened, what was surprising, what they think comes next. When the conversation is about the book rather than the clock, kids read to find out what happens, and the minutes take care of themselves. The signature can still happen — it just stops being the point."},
    {"type":"h2","text":"Let them abandon books they hate"},
    {"type":"p","text":"Nothing kills reading joy faster than being trapped in a book a kid dislikes to hit a minute quota. Give them permission to abandon a book that is not working and pick another. Adults quit books all the time; kids deserve the same freedom. A reader who is allowed to chase what they love reads more, not less, because reading stops feeling like a sentence to serve."},
    {"type":"h2","text":"Count the reading that already happens"},
    {"type":"p","text":"Reading logs often ignore all the reading kids actually do — comics, cereal boxes, game guides, the back of the shampoo bottle, a sibling's picture book. Count it. Broadening what counts as reading validates a kid's real reading life and takes the pressure off the single approved chapter book. Kids who see their whole reading world honored feel like readers, which is the identity that keeps them reading for life."},
    {"type":"p","text":"The reading log does not have to kill the story. Track the story rather than just the minutes, let kids abandon books they hate, and count the reading that already happens — and you can keep the accountability a teacher wants while handing your kid back the joy that makes a reader in the first place."}
  ]$json$::jsonb, true
),

-- ═══ AI & TECHNOLOGY ═════════════════════════════════════════════════════════
(
  'teaching-kids-to-fact-check-ai',
  'Teaching Kids to Fact-Check What AI Tells Them',
  'AI chatbots sound confident even when they are wrong. The most important tech skill you can give a kid is a healthy habit of verifying before they trust and repeat.',
  'Elena Rodriguez', '2026-05-11', 5, ARRAY['AI','digital literacy','media literacy'], 'AI & Technology', true, '#6366f1',
  'https://images.unsplash.com/photo-1516387938699-a93567ec168e?auto=format&fit=crop&w=1600&q=80',
  'A family using technology together thoughtfully', 'Unsplash',
  $json$[
    {"type":"p","text":"AI chatbots have a particular danger for kids: they sound completely confident even when they are completely wrong. A tool that answers every question in a smooth, authoritative voice is easy to trust and hard to question, especially for a kid. The single most valuable tech skill you can teach right now is not how to use AI — kids figure that out fast — but how to fact-check it before they believe it and repeat it."},
    {"type":"h2","text":"Explain that confident is not the same as correct"},
    {"type":"p","text":"Start with the core idea kids miss: AI is designed to sound sure of itself, and that confidence is not evidence. It can invent facts, dates, quotes, and sources that look completely real. Helping kids understand that a smooth, certain answer can still be flat wrong — that tone tells you nothing about truth — is the foundation. Once a kid knows the machine can be confidently mistaken, they stop taking its word as final."},
    {"type":"h2","text":"Build the second-source habit"},
    {"type":"p","text":"The practical skill is simple: for anything that matters, check a second source before trusting it. If AI states a fact for a school project or an argument, verify it against a reliable site, a book, or a knowledgeable adult. Make it a normal step, not a sign of distrust — good researchers always confirm. A kid who instinctively asks how do I know this is true has a defense that works against every future technology, not just this one."},
    {"type":"h2","text":"Practice catching it together"},
    {"type":"p","text":"The lesson sticks when kids see it happen. Now and then, ask a chatbot something you can verify and check it together — including the times it gets something wrong. Catching AI in a confident mistake is far more convincing than any warning you could give. It turns the abstract be skeptical into a real, memorable experience, and kids start watching for the errors on their own."},
    {"type":"p","text":"AI is here to stay, and it will keep sounding sure of itself. Teach kids that confident is not the same as correct, build the reflex of checking a second source, and practice catching mistakes together — and you will hand them the durable skill of verifying before they trust, which protects them across every tool that comes next."}
  ]$json$::jsonb, true
),
(
  'when-ai-does-the-homework',
  'When AI Does the Homework',
  'Your kid can now get any assignment done in seconds. The real question is not how to police it but how to help them use AI in ways that build their brain instead of replacing it.',
  'Nadia Hassan', '2026-05-10', 6, ARRAY['AI','school','digital literacy'], 'AI & Technology', false, '#6366f1',
  'https://images.unsplash.com/photo-1544717305-2782549b5136?auto=format&fit=crop&w=1600&q=80',
  'A family using technology together thoughtfully', 'Unsplash',
  $json$[
    {"type":"p","text":"There is a new reality every parent of a school-age kid is facing: an assignment that used to take an hour can now be finished by AI in seconds. Panicking or banning it outright rarely works, and pretending it does not exist works even less. The useful question is not only how to stop kids from cheating, but how to help them use AI in ways that build their thinking instead of quietly outsourcing it."},
    {"type":"h2","text":"Name the real cost of shortcutting"},
    {"type":"p","text":"Kids need to understand what they actually lose when AI does the work: the point of homework was never the finished page — it was the mental reps that build the skill. Handing the whole task to AI is like watching someone else lift weights and expecting to get stronger. Framing it honestly — you can get the answer, but you skip the learning the answer was supposed to give you — helps kids see the trade for what it is."},
    {"type":"h2","text":"Teach AI as a tutor, not a ghostwriter"},
    {"type":"p","text":"There is a real difference between using AI to think and using it to avoid thinking. A tutor explains a concept you are stuck on, checks your work, or quizzes you; a ghostwriter just hands you the finished essay. Teach kids to use AI in the first way — explain this so I get it, find the weak spot in my argument, give me practice problems — so the tool strengthens their brain rather than standing in for it."},
    {"type":"h2","text":"Value process over the polished product"},
    {"type":"p","text":"When only the finished product is praised, kids optimize for the fastest way to produce it, which is now AI. Shift some attention to process — how did you figure this out, walk me through your thinking, what was hard. When the thinking is what gets noticed and valued at home, kids have a reason to actually do it, and AI becomes a helper in the work rather than a replacement for it."},
    {"type":"p","text":"AI can do the homework now, and that is not going away. Name the real cost of shortcutting the learning, teach AI as a tutor rather than a ghostwriter, and value the process over the polished product — and you will help your kid use a powerful tool in a way that builds their mind instead of quietly hollowing it out."}
  ]$json$::jsonb, true
),

-- ═══ WELLNESS ════════════════════════════════════════════════════════════════
(
  'the-after-dinner-family-walk',
  'The After-Dinner Family Walk',
  'One of the highest-return family habits costs nothing and takes fifteen minutes: a short walk after dinner that helps digestion, sleep, mood, and the kind of easy talk that never happens on the couch.',
  'Tom Fletcher', '2026-05-11', 4, ARRAY['family wellness','habits','connection'], 'Wellness', true, '#f59e0b',
  'https://images.unsplash.com/photo-1434494878577-86c23bcb06b9?auto=format&fit=crop&w=1600&q=80',
  'A peaceful, restorative family moment', 'Unsplash',
  $json$[
    {"type":"p","text":"Some family habits are complicated and expensive; the after-dinner walk is neither. Fifteen minutes around the block after the meal is one of the highest-return rituals a family can build. It nudges digestion and sleep, lifts everyone's mood, adds a little easy movement to the day, and — almost as a side effect — creates the kind of relaxed conversation that somehow never happens sitting on the couch."},
    {"type":"h2","text":"The talk is the secret ingredient"},
    {"type":"p","text":"The quiet magic of a walk is what it does to conversation. Side by side, moving, with no screens and no eye-contact pressure, kids open up in a way they rarely do across a table. The best stories about school, friends, and worries tend to slip out on a walk precisely because it does not feel like a talk. The exercise is the excuse; the connection is the real payoff."},
    {"type":"h2","text":"Keep it short and non-negotiable"},
    {"type":"p","text":"A habit sticks when it is small enough to never skip. Fifteen minutes is the sweet spot — long enough to matter, short enough that nobody can reasonably argue they do not have time. Attach it to dinner so it rides an existing routine (we eat, we walk), and protect it lightly as just what we do after dinner. The magic is in the consistency, not the distance."},
    {"type":"h2","text":"Lower the bar on bad days"},
    {"type":"p","text":"The walk survives busy, tired, and grumpy nights only if the bar stays low. On a rough day, even a lap around the block or five minutes in the yard counts — the point is to keep the habit alive, not to hit a step goal. Protecting the ritual over the distance means it is still there on the good days, when a longer, slower walk becomes the best part of the evening."},
    {"type":"p","text":"The after-dinner walk is a tiny habit with an outsized return. Let the easy conversation be the secret ingredient, keep it short and non-negotiable, and lower the bar on hard days — and you will build a fifteen-minute ritual that quietly improves your family's sleep, mood, and connection at a cost of exactly nothing."}
  ]$json$::jsonb, true
),
(
  'the-sunday-night-family-check-in',
  'The Sunday-Night Family Check-In',
  'A short, predictable family check-in before the week starts heads off the chaos of forgotten forms and surprise events — and gives everyone a calmer, more connected launch into Monday.',
  'Leah Kim', '2026-05-10', 5, ARRAY['family wellness','organization','connection'], 'Wellness', false, '#f59e0b',
  'https://images.unsplash.com/photo-1560472354-b33ff0c44a43?auto=format&fit=crop&w=1600&q=80',
  'A peaceful, restorative family moment', 'Unsplash',
  $json$[
    {"type":"p","text":"So much weekday stress is really just the friday-afternoon surprise: the project due tomorrow no one mentioned, the game that conflicts with the dentist, the permission slip found at 7am. A short Sunday-night check-in — fifteen quiet minutes to look at the week together before it starts — heads off most of that chaos, and gives everyone a calmer, more connected launch into Monday instead of a scramble."},
    {"type":"h2","text":"Look at the week together"},
    {"type":"p","text":"The core of the check-in is simply previewing the week out loud: what is happening, who needs to be where, what is due, what might collide. Surfacing it all on Sunday — rather than discovering it in real time — turns surprises into plans. Even young kids benefit from knowing the shape of their week ahead of time; predictability is calming, and a preview replaces a hundred small weekday scrambles with one short conversation."},
    {"type":"h2","text":"Catch the conflicts early"},
    {"type":"p","text":"Half the value is catching collisions while there is still time to solve them. Two events at once, a ride nobody has arranged, a busy night that needs an easy dinner — spotting these on Sunday means you can fix them calmly instead of triaging at the door. A few minutes of looking ahead prevents the frantic weekday logistics that fray everyone's nerves and eat the evenings."},
    {"type":"h2","text":"Add a human question, not just logistics"},
    {"type":"p","text":"A check-in that is only a schedule review becomes a chore. Add one human question — what are you looking forward to, what are you nervous about this week. It takes two minutes and turns a logistics meeting into a moment of connection, letting you catch a worried kid before Monday rather than after a hard week. The mix of practical and personal is what makes everyone actually want to show up."},
    {"type":"p","text":"A Sunday-night check-in trades fifteen calm minutes for a week of avoided scrambles. Look at the week together, catch the conflicts while they are still fixable, and add a human question alongside the logistics — and your family will start Monday informed, prepared, and a little more connected instead of surprised."}
  ]$json$::jsonb, true
),

-- ═══ FAMILY FINANCES ═════════════════════════════════════════════════════════
(
  'the-first-allowance-conversation',
  'The First Allowance Conversation',
  'An allowance is a kid''s first hands-on money lesson. Getting the setup right — what it is for, whether it is tied to chores, and how much — turns pocket money into real financial learning.',
  'Rachel Greene', '2026-05-11', 5, ARRAY['money','allowance','financial literacy'], 'Family Finances', true, '#f43f5e',
  'https://images.unsplash.com/photo-1553877522-43269d4ea984?auto=format&fit=crop&w=1600&q=80',
  'A hands-on family money-learning moment', 'Unsplash',
  $json$[
    {"type":"p","text":"An allowance is often a kid's very first hands-on experience with money — the first time they hold their own funds and decide what to do with them. That makes the first allowance conversation more important than the dollar amount. Getting the setup right — what the money is for, whether it is tied to chores, and how much — is what turns pocket money into a genuine financial education rather than just a weekly handout."},
    {"type":"h2","text":"Decide what the allowance is for"},
    {"type":"p","text":"Before the amount, decide the purpose. Is the allowance meant to teach saving and spending choices, to cover certain expenses so the kid manages them, or simply to give them practice handling money. Being clear on the goal shapes everything else — a teaching allowance is generous with mistakes, an expense allowance hands over real responsibility. When both you and your kid understand what the money is for, it becomes a lesson instead of a mystery."},
    {"type":"h2","text":"Decide the chores question on purpose"},
    {"type":"p","text":"The classic debate is whether to tie allowance to chores. Both work, but for different reasons: tying it to chores teaches money is earned through work; keeping them separate treats chores as family contributions everyone owes and allowance as a tool for learning to manage money. There is no single right answer, but decide it deliberately and explain your reasoning, so the arrangement teaches the lesson you actually intend."},
    {"type":"h2","text":"Let them make real choices — and real mistakes"},
    {"type":"p","text":"An allowance only teaches if the kid gets to decide and, sometimes, decide badly. Let them spend it all on something they regret, or wait and save for something bigger. The small, safe mistakes of childhood — blowing it on candy and having nothing left for the toy — are far cheaper lessons than the same mistakes made later with real stakes. Resisting the urge to rescue every choice is where the learning lives."},
    {"type":"p","text":"The first allowance sets the tone for a kid's whole money education. Decide what it is for, settle the chores question on purpose, and let them make real choices and real mistakes — and you will turn a weekly few dollars into the beginning of genuine financial literacy that pays off long after the amount stops mattering."}
  ]$json$::jsonb, true
),
(
  'the-family-subscription-audit',
  'The Family Subscription Audit',
  'Streaming, apps, and auto-renewals quietly drain hundreds a year from the average family. A twenty-minute subscription audit — done together — saves real money and teaches kids to notice recurring costs.',
  'Omar Farah', '2026-05-10', 4, ARRAY['money','budgeting','financial literacy'], 'Family Finances', false, '#f43f5e',
  'https://images.unsplash.com/photo-1573164574511-73c773193279?auto=format&fit=crop&w=1600&q=80',
  'A hands-on family money-learning moment', 'Unsplash',
  $json$[
    {"type":"p","text":"Subscriptions are designed to be forgotten. Streaming services, app upgrades, cloud storage, that free trial that quietly started billing — they slip onto the card a few dollars at a time and add up to hundreds of dollars a year the average family is not really using. A twenty-minute subscription audit, done together as a family, recovers real money and doubles as a sharp lesson for kids about the quiet power of recurring costs."},
    {"type":"h2","text":"List every recurring charge"},
    {"type":"p","text":"Start by pulling up the last month or two of statements and listing every recurring charge you can find. Almost every family is surprised by what surfaces — a service nobody remembers signing up for, two streaming apps that do the same thing, a trial that turned into a subscription months ago. You cannot manage what you cannot see, and the list alone usually reveals easy money hiding in plain sight."},
    {"type":"h2","text":"Ask the honest question on each one"},
    {"type":"p","text":"Go down the list and ask one honest question about each: are we actually using this enough to justify the cost. Not could we use it, but do we. Cancel the ones that do not earn their keep. Involving the kids in this call — is this worth what it costs us every month — teaches the exact judgment that protects a budget: value received against price paid, made deliberately rather than by default."},
    {"type":"h2","text":"Make it a habit, not a one-time purge"},
    {"type":"p","text":"Subscriptions creep back the moment you stop watching, so a one-time cleanup is not enough. Put a recurring reminder to run the audit every few months, and adopt a simple rule for new sign-ups — a free trial gets a calendar alert to cancel before it bills. A light, repeating check keeps the slow leak from reopening and models exactly the kind of ongoing money attention you want your kids to carry into adulthood."},
    {"type":"p","text":"A subscription audit is one of the fastest ways to find money you are already spending for nothing. List every recurring charge, ask the honest are-we-using-it question on each, and make the check a habit rather than a one-time purge — and you will recover real money while teaching your kids to notice the quiet, compounding cost of things that bill on autopilot."}
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
