-- FamilyOS :: 0231 Blog articles — expansion batch 6
-- ----------------------------------------------------------------------------
-- Sixth wave of original, editorially-voiced articles for public.blog_posts,
-- two per category across all six topics. Topics vetted against all 80 existing
-- blog slugs to avoid slug collisions and near-duplicate themes. Same format:
-- JSONB body blocks, production-verified free Unsplash hero images, tags,
-- accent color. Idempotent: ON CONFLICT (slug) DO UPDATE. SEO/AEO handled in
-- code (lib/blog/structured-data.ts); sitemap lists all slugs automatically.

INSERT INTO public.blog_posts
  (slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color,
   hero_image_url, hero_image_alt, hero_image_credit, body, published)
VALUES

-- ═══ PARENTING ═══════════════════════════════════════════════════════════════
(
  'teaching-kids-to-apologize',
  'Teaching Kids to Actually Apologize (Not Just Say Sorry)',
  'A mumbled ''sorry'' to end a scolding teaches nothing. A real apology is a skill with parts — and it''s one of the most useful things you can teach.',
  'Jessica Miller', '2026-06-25', 6, ARRAY['emotional health','communication','child development'], 'Parenting', true, '#7c5dff',
  'https://images.unsplash.com/photo-1476703993599-0035a21b17a9?auto=format&fit=crop&w=1600&q=80',
  'A parent guiding two children through making up after a conflict',
  'Unsplash',
  $json$[
    {"type":"p","text":"''Say sorry to your brother.'' The mumbled, eye-rolling ''sorrryyy'' that follows teaches a child exactly one thing: that ''sorry'' is a magic word you say to make an adult stop talking. A real apology is something else entirely — a genuine skill with distinct parts — and learning it is one of the most valuable things a kid can carry into every relationship they'll ever have."},
    {"type":"h2","text":"A real apology has parts"},
    {"type":"p","text":"Teach the anatomy: name what you did (''I knocked over your tower''), acknowledge the effect (''and that made you sad''), and offer to make it right (''can I help you rebuild it?''). Notice what's missing — no ''but he started it,'' no excuses. A kid who learns these three moves has something far more powerful than a reflexive ''sorry'': a way to actually repair a rupture."},
    {"type":"h2","text":"Don''t force the words before the feeling"},
    {"type":"p","text":"A forced apology delivered while a kid is still furious is just theater, and kids know it. Better to wait until they've calmed down and can mean it. In the meantime, focus on repair actions — helping fix what they broke, getting the ice pack — which often rebuild connection better than words a child isn't ready to say. The sincerity is the point; rushing it destroys the lesson."},
    {"type":"h2","text":"Model it when you get it wrong"},
    {"type":"p","text":"The most powerful apology lesson is the one your kid watches you give. When you snap, or forget, or get it wrong, apologize to them properly — name it, own it, make it right — using the exact structure you're teaching. A parent who apologizes sincerely shows a child that saying sorry isn't weakness or humiliation; it's what strong, decent people do. They'll apologize the way they've seen you apologize."},
    {"type":"p","text":"Skip the forced ''say sorry.'' Teach the real thing — name it, own the impact, make it right — and you hand your kid a repair skill they'll use for the rest of their life."}
  ]$json$::jsonb, true
),
(
  'stop-refereeing-sibling-fights',
  'Stop Refereeing: How to Get Out of Your Kids'' Fights',
  'Every time you swoop in to judge a sibling squabble, you rob them of the chance to learn how to work it out. There''s a better role for you.',
  'Marcus Bennett', '2026-06-24', 6, ARRAY['siblings','conflict','child development'], 'Parenting', false, '#7c5dff',
  'https://images.unsplash.com/photo-1587616211892-f743fcca64f9?auto=format&fit=crop&w=1600&q=80',
  'Two children working out a disagreement together',
  'Unsplash',
  $json$[
    {"type":"p","text":"''MOM! He took it!'' ''She started it!'' The endless sibling squabble drags you in as judge, jury, and referee dozens of times a day — and the more you referee, the more they fight, because every squabble becomes a competition to win YOU over. Constantly deciding who's right trains kids to run to you instead of learning the actual skill: working it out themselves."},
    {"type":"h2","text":"Refereeing makes it worse"},
    {"type":"p","text":"When you play judge, you accidentally raise the stakes. Now it's not just about the toy — it's about who Mom sides with, who's the ''good'' kid, who wins. Siblings learn to build the best case and summon you as a weapon. Step out of the judge's chair and you remove the prize they were really fighting over: your verdict. Suddenly there's less reason to escalate."},
    {"type":"h2","text":"Be the coach, not the judge"},
    {"type":"p","text":"Instead of deciding who's right, coach them to solve it. ''You both want the same toy — that's a tough one. What could you two do about it?'' Describe the problem neutrally, reflect both feelings, and hand the problem back to them. You're not abandoning them; you're teaching negotiation, compromise, and turn-taking — skills that only develop when they're allowed to do the solving."},
    {"type":"h2","text":"Know when to actually step in"},
    {"type":"p","text":"Stepping back doesn't mean anything goes. Physical danger, cruelty, or a genuine power mismatch (a big kid steamrolling a little one) is where you intervene, firmly and immediately. The goal is to referee less over the normal, healthy friction of siblings figuring each other out — while staying the clear, non-negotiable guardrail against anyone getting hurt. Most squabbles aren't emergencies; save your authority for the ones that are."},
    {"type":"p","text":"The sibling relationship is the longest one most people ever have, and it's forged in exactly these small conflicts. Step out of the referee role, coach from the sideline, and let your kids build the skills that role was quietly stealing from them."}
  ]$json$::jsonb, true
),

-- ═══ ORGANIZATION ════════════════════════════════════════════════════════════
(
  'the-family-emergency-binder',
  'The Family Emergency Binder: The One Folder You Hope You Never Open',
  'The day you urgently need the insurance policy, the account numbers, or the medication list is the worst possible day to go hunting for them.',
  'Priya Anand', '2026-06-25', 6, ARRAY['home systems','preparedness','documents'], 'Organization', true, '#3b82f6',
  'https://images.unsplash.com/photo-1584697964358-3e14ca57658b?auto=format&fit=crop&w=1600&q=80',
  'An organized set of important documents gathered in one place',
  'Unsplash',
  $json$[
    {"type":"p","text":"There's a category of information every family needs and almost none have gathered in one place: the insurance policies, the account numbers, the medication lists, the emergency contacts, the copies of IDs and birth certificates. It all lives scattered across drawers, inboxes, and one person's memory — right up until the moment of a crisis, when you need it instantly and can't find any of it."},
    {"type":"h2","text":"Gather it before you need it"},
    {"type":"p","text":"An emergency binder (physical, digital, or both) pulls the vital stuff into one known location: medical info and medications for each family member, insurance details, financial account list, important documents, key contacts, and instructions for pets and home systems. Building it is a couple of hours of boring work that pays off enormously on the one bad day you hope never comes but should absolutely prepare for."},
    {"type":"h2","text":"Make sure someone else can find it"},
    {"type":"p","text":"A binder only one person knows about fails at the exact moment it's needed — when that person is the one in the hospital. The whole point is that a partner, an older kid, or a trusted relative can locate it and act. Tell the people who'd need it where it is and what's in it. Secured, yes; secret, no. Shared access is the feature, not a bug."},
    {"type":"h2","text":"Set a reminder to refresh it"},
    {"type":"p","text":"Information rots — policies change, medications get updated, accounts open and close. A binder that's five years stale can be worse than none, sending someone to a disconnected number in a crisis. Put a recurring calendar reminder to review it once or twice a year. Fifteen minutes of updates keeps it trustworthy, which is the only kind of emergency document worth having."},
    {"type":"p","text":"You buy insurance hoping never to use it. Build the emergency binder the same way — a small, unglamorous investment in your family's resilience, sitting quietly ready for the day you'll be grateful past-you made it."}
  ]$json$::jsonb, true
),
(
  'the-outgrown-clothes-system',
  'The Outgrown-Clothes System: Winning the War Against Kid Closets',
  'Kids grow out of clothes faster than you can fold them. Without a system, closets clog with sizes nobody wears. Here''s the flow that keeps up.',
  'Priya Anand', '2026-06-23', 5, ARRAY['organizing','kids','decluttering'], 'Organization', false, '#3b82f6',
  'https://images.unsplash.com/photo-1502086223501-7ea6ecd79368?auto=format&fit=crop&w=1600&q=80',
  'Neatly organized and sorted children''s clothes',
  'Unsplash',
  $json$[
    {"type":"p","text":"Children are growth machines, and their closets pay the price. Clothes that fit in September are high-waters by March, yet they linger in drawers, crowding out the stuff that actually fits, until getting dressed becomes a daily archaeological dig through three sizes at once. Without a system, kid closets are a losing battle. With one, they mostly run themselves."},
    {"type":"h2","text":"Purge on a schedule, not a whim"},
    {"type":"p","text":"The key is a regular, seasonal sweep. Twice a year — spring and fall — go through each kid's clothes and pull everything that no longer fits. Doing it on a schedule keeps the closet honest and prevents the slow clog. A quick try-on session (kids surprisingly enjoy the fashion show) sorts fits-from-doesn't in twenty minutes, and the outgrown pile leaves immediately."},
    {"type":"h2","text":"Give outgrown clothes an instant destination"},
    {"type":"p","text":"The reason outgrown clothes linger is that there's no obvious next stop, so they drift back into the drawer. Fix that with two labeled bins: one for hand-me-downs to save for a younger sibling (labeled by size, stored out of the way) and one for donate/sell. The moment a garment is outgrown, it goes in a bin, not back in the closet. Decision made, drawer freed."},
    {"type":"h2","text":"Keep only the next size accessible"},
    {"type":"p","text":"For hand-me-downs and gifts your kid will grow into, resist stuffing them into the active closet where they just create clutter. Store the future sizes labeled and out of the way, and ''shop your own bins'' at each seasonal sweep — pulling up the next size as the current one retires. The active closet holds only what fits now, which is the whole secret to a kid closet that works."},
    {"type":"p","text":"You can't stop kids from growing, but you can build a simple in-and-out flow so their closets keep pace. Seasonal sweep, instant bins, next-size stored — and getting dressed stops being a daily dig."}
  ]$json$::jsonb, true
),

-- ═══ SCHOOL & ACTIVITIES ═════════════════════════════════════════════════════
(
  'study-skills-nobody-teaches',
  'The Study Skills Nobody Actually Teaches Kids',
  'Schools assign studying but rarely teach how. A few simple, research-backed techniques beat hours of the highlighting-and-rereading most kids default to.',
  'Elena Rodriguez', '2026-06-25', 6, ARRAY['school','study skills','learning'], 'School & Activities', true, '#10b981',
  'https://images.unsplash.com/photo-1427504494785-3a9ca7044f45?auto=format&fit=crop&w=1600&q=80',
  'Shelves of books and study materials in a library',
  'Unsplash',
  $json$[
    {"type":"p","text":"Here's a strange gap in education: schools constantly tell kids to ''go study,'' but almost never teach them how. So kids default to the least effective methods there are — rereading the chapter, highlighting everything neon, staring at notes until it all feels vaguely familiar. It feels like studying and it barely works. A few simple, research-backed techniques do far more in far less time."},
    {"type":"h2","text":"Test yourself, don''t just reread"},
    {"type":"p","text":"The single most powerful study technique is retrieval practice: closing the book and trying to recall the material, not just looking at it again. Flashcards, practice questions, explaining it out loud from memory — the effortful act of pulling information out is what cements it. Rereading feels productive because it feels easy; that ease is exactly why it doesn't stick. Struggle to remember, and you actually will."},
    {"type":"h2","text":"Space it out"},
    {"type":"p","text":"Cramming the night before jams facts into short-term memory that evaporates by the weekend. Spacing the same study time across several shorter sessions over days lets the brain consolidate it for real. Twenty minutes on three nights beats an hour the night before, every time. Teach kids to start early and study in small, repeated doses — the opposite of the all-nighter they'll be tempted toward."},
    {"type":"h2","text":"Make them explain it"},
    {"type":"p","text":"A kid who can teach a concept understands it; a kid who can only recognize it doesn't. Have them explain the material to you, a sibling, or even a stuffed animal, in their own words. The gaps show up instantly — the moment they get stuck is the exact thing they need to review. This ''teach it to learn it'' move turns passive studying into active understanding."},
    {"type":"p","text":"Studying isn't about hours logged; it's about method. Teach your kid to self-test, space it out, and explain it aloud, and they'll learn more in less time — and stop mistaking highlighting for learning."}
  ]$json$::jsonb, true
),
(
  'when-your-kid-hates-school',
  'When Your Kid Says ''I Hate School'': A Calm Way Through',
  '''I hate school'' is rarely about school in general. It''s a headline hiding a specific story — and finding the story is how you help.',
  'Elena Rodriguez', '2026-06-23', 6, ARRAY['school','emotional health','communication'], 'School & Activities', false, '#10b981',
  'https://images.unsplash.com/photo-1506784983877-45594efa4cbe?auto=format&fit=crop&w=1600&q=80',
  'A backpack by the door on a difficult school morning',
  'Unsplash',
  $json$[
    {"type":"p","text":"Few things drop a parent's stomach like a kid announcing ''I hate school'' — or worse, the morning stomachaches and tears that mean it without words. The instinct is to argue them out of it (''of course you don't!'') or panic. Both skip the real work. ''I hate school'' is almost never a verdict on school itself; it's a headline over a specific, findable story."},
    {"type":"h2","text":"Get curious before you get worried"},
    {"type":"p","text":"The phrase is a symptom, not a diagnosis. Behind it is usually one concrete thing: a friendship that soured, a subject that feels impossible, a teacher who feels harsh, a fear of failing, an unstructured time like recess or the bus that's become a daily ordeal. Your job is detective, not debater. Gentle, specific questions over several low-pressure conversations surface the actual issue far better than a single interrogation."},
    {"type":"h2","text":"Validate first, fix second"},
    {"type":"p","text":"Before problem-solving, let them feel heard: ''That sounds really hard. I'm so glad you told me.'' A kid who feels believed opens up; a kid who feels dismissed or rushed toward solutions shuts down. Resist the urge to immediately reassure or fix. The validation is what earns you the details, and the details are what let you actually help."},
    {"type":"h2","text":"Partner up to solve the real thing"},
    {"type":"p","text":"Once you've found the specific story, you can act on it — and often you'll need the teacher as an ally (this is where an early, warm parent-teacher relationship pays off). A struggling subject might need support; a friendship rupture might need coaching; a bullying situation needs the school involved now. Tackle the actual root, together, rather than the vague headline. Kids feel enormous relief when a nameless dread becomes a solvable problem."},
    {"type":"p","text":"''I hate school'' is the beginning of a conversation, not the end of one. Stay calm, get curious, validate, and find the specific story underneath — that's how you turn a scary declaration into a problem you and your kid can actually solve."}
  ]$json$::jsonb, true
),

-- ═══ AI & TECHNOLOGY ═════════════════════════════════════════════════════════
(
  'teaching-kids-to-spot-fake-news',
  'Teaching Kids to Spot Fake News and AI Fakes',
  'Your kid swims in a feed where anyone can fabricate anything, and AI has made fakes nearly perfect. Media literacy is now a core survival skill.',
  'Jessica Miller', '2026-06-25', 6, ARRAY['ai','media literacy','safety'], 'AI & Technology', true, '#6366f1',
  'https://images.unsplash.com/photo-1489710437720-ebb67ec84dd2?auto=format&fit=crop&w=1600&q=80',
  'A parent and child looking critically at content on a screen',
  'Unsplash',
  $json$[
    {"type":"p","text":"Your kid is growing up in an information environment no previous generation faced: a bottomless feed where anyone can publish anything, algorithms reward outrage over accuracy, and AI can now fabricate a photorealistic image, a cloned voice, or a convincing article in seconds. Telling them ''don't believe everything online'' isn't enough anymore. They need active skills for sorting real from fake — and it's teachable."},
    {"type":"h2","text":"Teach the pause"},
    {"type":"p","text":"The most valuable habit is a two-second pause before believing or sharing. Content engineered to go viral is engineered to bypass thinking — to make you feel outrage or shock and hit share on reflex. Teach kids that a strong emotional reaction is precisely the cue to slow down and ask: who made this, why, and how do they know? The pause is the whole defense, and it's a habit you can practice together."},
    {"type":"h2","text":"Check before you trust"},
    {"type":"p","text":"Give them simple detective moves: Who's the source, and is it a real one? Do other credible outlets report the same thing? Is there a date, or is this old news recycled as new? For a shocking image or quote, a quick search often reveals it's fake, out of context, or AI-generated. Make lateral reading — leaving the post to check it elsewhere — a normal reflex rather than a chore."},
    {"type":"h2","text":"Name what AI can now fake"},
    {"type":"p","text":"Kids need to know, concretely, that images, videos, and voices can be convincingly faked now — that ''I saw a video of it'' is no longer proof. Show them examples of AI fakes together so it's real, not abstract. The goal isn't paranoia; it's calibrated skepticism — knowing that seeing is no longer believing, and that a claim needs a source, not just a screenshot."},
    {"type":"p","text":"Media literacy has quietly become a survival skill, as essential as looking both ways before crossing. Teach the pause, the check, and a healthy awareness of what AI can fake, and you'll raise a kid who can navigate the feed instead of being played by it."}
  ]$json$::jsonb, true
),
(
  'the-grandparent-tech-bridge',
  'The Grandparent Tech Bridge: Keeping Distant Family Close',
  'When family is scattered across states or countries, a little intentional tech turns ''we should call more'' into grandkids who actually know their grandparents.',
  'Marcus Bennett', '2026-06-23', 5, ARRAY['ai','family connection','technology'], 'AI & Technology', false, '#6366f1',
  'https://images.unsplash.com/photo-1531482615713-2afd69097998?auto=format&fit=crop&w=1600&q=80',
  'A phone showing a video call with a grandparent',
  'Unsplash',
  $json$[
    {"type":"p","text":"Families are more spread out than ever — grandparents a flight away, cousins in another time zone. The good intention (''we should call more'') rarely survives busy weeks, and the relationships quietly thin out. But a little intentional technology can bridge the distance, turning far-flung relatives from occasional voices into a real, felt presence in your kids' everyday lives."},
    {"type":"h2","text":"Make the video call a low-key ritual"},
    {"type":"p","text":"A scheduled, recurring video call — Sunday breakfast with Grandma, a bedtime story from Grandpa — beats sporadic ''we should catch up'' every time. Keep it casual and short; the goal isn't a formal event but a normal, regular window where the kids and the grandparents just hang out. Regularity is what builds the bond. A predictable weekly call does more than a big visit twice a year."},
    {"type":"h2","text":"Do something together, not just talk"},
    {"type":"p","text":"Little kids don't do well with ''so how's school?'' on a screen. They do great with shared activities: read the same book, cook the same recipe, play a simple online game, do a virtual show-and-tell of a new toy or a lost tooth. Giving the call a thing to DO turns an awkward chat into genuine connection, and gives everyone something to look forward to."},
    {"type":"h2","text":"Lower the barrier for less-techy relatives"},
    {"type":"p","text":"The bridge collapses if the grandparents find the tech frustrating. Set them up with the simplest possible tool — one big button, one obvious app — and be patient teachers. A dedicated video device or a smart display that answers with a tap can transform a reluctant grandparent into an eager one. The easier you make it on their end, the more the connection actually happens."},
    {"type":"p","text":"Distance doesn't have to mean drift. A weekly ritual, a shared activity, and dead-simple tech can help your kids grow up genuinely knowing the people who love them from far away — which is exactly what technology should be for."}
  ]$json$::jsonb, true
),

-- ═══ WELLNESS ════════════════════════════════════════════════════════════════
(
  'the-picky-eater-peace-treaty',
  'The Picky-Eater Peace Treaty: Ending the Dinner-Table War',
  'Fighting a picky eater almost always makes it worse. The counterintuitive path to a more adventurous kid runs straight through less pressure, not more.',
  'Dr. Sarah Kim', '2026-06-25', 6, ARRAY['nutrition','mealtime','wellness'], 'Wellness', true, '#f59e0b',
  'https://images.unsplash.com/photo-1606787366850-de6330128bfc?auto=format&fit=crop&w=1600&q=80',
  'A colorful, low-pressure spread of varied foods on a table',
  'Unsplash',
  $json$[
    {"type":"p","text":"Few things test a parent like a kid who eats six beige foods and treats a vegetable like a personal insult. The natural response — pushing, bribing, ''three more bites,'' the standoff over cold broccoli — feels like the responsible thing to do. It's also, according to feeding specialists, almost perfectly counterproductive. The way to a more adventurous eater runs through less pressure, not more."},
    {"type":"h2","text":"Divide the responsibility"},
    {"type":"p","text":"The most useful framework in feeding: you decide what's offered and when; your child decides whether and how much to eat. You put a variety of foods (including at least one thing they usually accept) on the table; you don't police what goes in their mouth. This ends the power struggle at its root — you can't lose a battle you refuse to fight, and neither can they."},
    {"type":"h2","text":"Exposure, not pressure"},
    {"type":"p","text":"Kids often need to see a new food many times — served, no pressure, maybe touched or licked or ignored — before they'll try it. Keep calmly offering the vegetable alongside the safe foods, with zero requirement to eat it. Familiarity, built over dozens of low-stakes encounters, is what eventually turns ''yuck'' into ''okay.'' Pressure poisons the well; patience refills it."},
    {"type":"h2","text":"Keep the table pleasant"},
    {"type":"p","text":"The single biggest factor in raising an adventurous eater is a relaxed, positive mealtime. A table where dinner means conflict teaches a kid to associate food with stress — the opposite of curiosity. Drop the negotiations, let them serve themselves, model eating a variety yourself with obvious enjoyment, and let meals be pleasant. A calm eater is a braver eater; an anxious one digs in."},
    {"type":"p","text":"Call a truce. Offer variety, hold zero pressure, keep the table warm, and give it time. The kid who's allowed to come to new foods on their own timeline almost always comes further than the one who's pushed."}
  ]$json$::jsonb, true
),
(
  'parental-burnout-is-real',
  'Parental Burnout Is Real — and Ignoring It Doesn''t Make You a Better Parent',
  'You can''t pour from an empty cup, and running yourself to fumes doesn''t help your kids. Refilling your own tank isn''t selfish — it''s maintenance.',
  'Dr. Sarah Kim', '2026-06-23', 6, ARRAY['self-care','mental health','wellness'], 'Wellness', false, '#f59e0b',
  'https://images.unsplash.com/photo-1554224154-26032ffc0d07?auto=format&fit=crop&w=1600&q=80',
  'A parent taking a genuine, restful moment for themselves',
  'Unsplash',
  $json$[
    {"type":"p","text":"There's a particular exhaustion that goes beyond tired — the flat, depleted, running-on-fumes state where you snap at small things, feel numb to the good moments, and quietly wonder if you're doing any of this right. That's parental burnout, and it's real, common, and not a character flaw. Pretending it away, or wearing it like a badge of devotion, helps no one — least of all your kids."},
    {"type":"h2","text":"Burnout has costs your kids feel"},
    {"type":"p","text":"A running-on-empty parent is a shorter-fused, less-present parent — not because they love their kids less, but because there's nothing left in the tank. Kids don't need a martyr who gave everything and has nothing left to give warmly. They need a parent who's okay. Taking care of yourself isn't taking something away from them; it's protecting the resource they most depend on."},
    {"type":"h2","text":"Refuel in small, real ways"},
    {"type":"p","text":"You probably can't get a spa weekend, but burnout is fought in small, regular refills more than grand escapes. A real break during the day (see the shift-change with a partner), twenty minutes of something that's actually yours, protected sleep, a walk, a friend. These aren't indulgences; they're maintenance on the engine the whole family runs on. Guard them like the necessities they are."},
    {"type":"h2","text":"Lower the bar and ask for help"},
    {"type":"p","text":"Much of burnout is fed by an impossible standard — the Pinterest-perfect, always-patient, do-it-all parent who doesn't exist. Let some of it go: the house can be messier, dinner can be simpler, screens can save an evening. And ask for help without shame — a partner, family, friends, a professional. Needing support isn't failing at parenting; refusing it until you break is."},
    {"type":"p","text":"You are not a bottomless well. Refilling your own cup — through small daily restoration, a lower bar, and real help — isn't selfish. It's how you keep showing up for the people who need the version of you that isn't running on empty."}
  ]$json$::jsonb, true
),

-- ═══ FAMILY FINANCES ═════════════════════════════════════════════════════════
(
  'the-kid-entrepreneur',
  'Raising a Kid Entrepreneur: The Lemonade Stand Is a Business School',
  'The classic lemonade stand teaches more real economics in an afternoon than a year of allowance. Here''s how to turn a kid''s hustle into a lesson.',
  'David Okafor', '2026-06-25', 5, ARRAY['money skills','entrepreneurship','kids'], 'Family Finances', true, '#f43f5e',
  'https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=1600&q=80',
  'A child counting the earnings from a small venture',
  'Unsplash',
  $json$[
    {"type":"p","text":"There's a reason the lemonade stand is a cultural icon: it's a complete business school disguised as a summer afternoon. When a kid decides to earn money by making and selling something — lemonade, friendship bracelets, dog-walking, a car-wash service — they learn more real economics in a few hours than allowance teaches in a year. Your job is to encourage the hustle and gently narrate the lessons."},
    {"type":"h2","text":"Let them feel profit and loss"},
    {"type":"p","text":"The magic of a kid venture is that it makes abstract money concepts physical. They spend money on supplies (costs), sell for a price (revenue), and discover that what's left over is profit — and that if they priced too low or bought too much, there might not be any. Front the startup cash as a loan they repay from sales, and suddenly they understand investment, expenses, and margin in their bones."},
    {"type":"h2","text":"Coach, don''t take over"},
    {"type":"p","text":"The temptation is to optimize everything for them — you make the sign, you set the price, you run the money. Resist it. Let it be genuinely theirs, mistakes and all. A stand that flops because they set up on a quiet street teaches location and marketing better than any success you engineered. Ask questions (''where do you think you'll get the most customers?'') and let them own both the wins and the flops."},
    {"type":"h2","text":"Celebrate the effort, not just the take"},
    {"type":"p","text":"A kid's first venture might net three dollars, and that's a triumph — praise the initiative, the problem-solving, the courage to ask strangers to buy something. You're growing an entrepreneurial mindset: the belief that they can create value and earn, rather than just receive an allowance. That confidence — ''I can make money by making something people want'' — is worth infinitely more than the coins in the jar."},
    {"type":"p","text":"Say yes to the lemonade stand, the bracelet business, the neighborhood dog-walking scheme. Fund the first batch, coach from the side, and let them run it — you're not just raising a saver, you're raising someone who knows they can build."}
  ]$json$::jsonb, true
),
(
  'the-family-emergency-fund',
  'The Family Emergency Fund: Why Boring Savings Beat Every Investment',
  'Before the retirement accounts and the stock tips, there''s one unglamorous account that quietly holds a family together when life goes sideways.',
  'David Okafor', '2026-06-23', 6, ARRAY['saving','budgeting','family finances'], 'Family Finances', false, '#f43f5e',
  'https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?auto=format&fit=crop&w=1600&q=80',
  'A seedling growing from coins — steady savings taking root',
  'Unsplash',
  $json$[
    {"type":"p","text":"Personal finance gets exciting around investments, stock tips, and retirement growth — but the single most important account a family can have is the least glamorous one: the emergency fund. It's just cash, sitting there, earning little, doing nothing flashy. And it's the thing that stands between a family and a spiral when the car dies, the job vanishes, or the roof leaks. Boring savings quietly beat every clever investment when life goes sideways."},
    {"type":"h2","text":"It''s a buffer, not an investment"},
    {"type":"p","text":"The emergency fund has one job: to be there, in cash, the instant you need it, no questions asked. That's why it lives in a plain, accessible savings account, not the stock market — you can't have your safety net drop 20% the same month you lose your income. Its return isn't measured in interest; it's measured in the disasters it quietly prevents from becoming catastrophes."},
    {"type":"h2","text":"It turns a crisis into an inconvenience"},
    {"type":"p","text":"Without a buffer, an unexpected expense becomes a credit-card spiral, a stressful loan, or a genuine emergency. With one, the same event is merely annoying — you pay the bill and refill the fund over time. That transformation, from panic to inconvenience, is the real product you're buying. It's also a gift to your kids: a household that doesn't wobble every time life throws a normal curveball."},
    {"type":"h2","text":"Build it in small, automatic steps"},
    {"type":"p","text":"The target — often cited as three to six months of expenses — sounds impossible, and staring at the whole number is how people give up. Don't. Start with a small, concrete goal (even one month, or a few hundred dollars covers most surprises) and automate a modest transfer every payday so it grows without willpower. Small and automatic, repeated, quietly builds a wall of security while you're not looking."},
    {"type":"p","text":"Before you chase returns, build the buffer. An unglamorous pile of accessible cash is the foundation everything else stands on — and the difference between a family that weathers a bad month and one that's derailed by it."}
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
