-- FamilyOS :: 0228 Blog articles — expansion batch 3
-- ----------------------------------------------------------------------------
-- Third wave of original, editorially-voiced articles for public.blog_posts,
-- two per category across all six topics, matching the 0202/0226/0227 format
-- (JSONB body blocks, production-verified free Unsplash hero images, tags,
-- accent color). Idempotent: ON CONFLICT (slug) DO UPDATE. SEO/AEO handled in
-- code (lib/blog/structured-data.ts); sitemap lists all slugs automatically.

INSERT INTO public.blog_posts
  (slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color,
   hero_image_url, hero_image_alt, hero_image_credit, body, published)
VALUES

-- ═══ PARENTING ═══════════════════════════════════════════════════════════════
(
  'connection-before-correction',
  'Connection Before Correction: Why a Hug Ends a Meltdown Faster Than a Lecture',
  'A dysregulated kid can''t learn a lesson — the thinking part of their brain is offline. Reach the feeling part first, then teach.',
  'Jessica Miller', '2026-07-04', 6, ARRAY['discipline','emotional health','child development'], 'Parenting', true, '#7c5dff',
  'https://images.unsplash.com/photo-1476703993599-0035a21b17a9?auto=format&fit=crop&w=1600&q=80',
  'A parent kneeling to comfort a young child at eye level',
  'Unsplash',
  $json$[
    {"type":"p","text":"Picture a kid mid-meltdown on the kitchen floor, and a parent standing over them explaining, with increasing volume, why the behavior is unacceptable. It never works, and there's a reason it can't: a child in full meltdown has effectively lost access to the thinking part of their brain. You're delivering a lecture to a locked door."},
    {"type":"h2","text":"You can''t reason with a flooded brain"},
    {"type":"p","text":"When big feelings take over, the logical, lesson-absorbing part of a child's mind goes offline — this is biology, not defiance. Trying to teach in that moment is like trying to teach someone to swim while they're drowning. First you get them to the shore. The lesson comes after, on dry land."},
    {"type":"h2","text":"Connection is the shore"},
    {"type":"p","text":"A calm presence, a hug, a lowered voice, getting down to their level — these aren't rewards for bad behavior, and they don't ''let the kid win.'' They're what brings the thinking brain back online. Once your child is regulated, and only then, can they actually hear ''we don't hit,'' remember it, and use it next time. Connect first, correct second."},
    {"type":"h2","text":"Correcting still happens — just later, and better"},
    {"type":"p","text":"Connection before correction is not permissiveness. The boundary still holds and the conversation still happens; it just happens when it can actually land. ''Earlier you were so upset you hit. Let's figure out what to do next time you feel that big'' — said to a calm kid — teaches infinitely more than anything shouted at a flailing one."},
    {"type":"p","text":"The next time your child falls apart, resist the urge to teach through the storm. Be the calm. The lesson will still be there when the weather clears — and this time, they'll be able to hear it."}
  ]$json$::jsonb, true
),
(
  'the-yes-day',
  'The Yes Day: What Happens When You Stop Saying No for 24 Hours',
  'Parenting is a river of small nos. One planned day of yes resets the whole relationship — and it costs less than you''d think.',
  'Marcus Bennett', '2026-07-03', 5, ARRAY['connection','play','family fun'], 'Parenting', false, '#7c5dff',
  'https://images.unsplash.com/photo-1587616211892-f743fcca64f9?auto=format&fit=crop&w=1600&q=80',
  'Children laughing and celebrating together at a bright party',
  'Unsplash',
  $json$[
    {"type":"p","text":"Count the nos in an average parenting day and it's staggering: no, not now, no, we can't, no, put that down, no, later, no, because I said so. Each one is usually right. But a kid who hears ''no'' forty times a day starts to experience their parent as a wall. A Yes Day is a scheduled, gleeful break in the wall — and it does more than it should."},
    {"type":"h2","text":"How a Yes Day actually works"},
    {"type":"p","text":"You pick a day, set a few sane guardrails in advance (a budget, a geographic range, nothing unsafe or truly outrageous), and then — within those lines — you say yes to what the kids ask. Ice cream before lunch? Yes. Pillow fort in the living room all day? Yes. Wear the costume to the store? Yes. The boundaries are set once, up front, so the day itself is pure green light."},
    {"type":"h2","text":"The magic isn''t the ice cream"},
    {"type":"p","text":"Kids don't remember a Yes Day for the sugar. They remember being delighted-in — a day their ideas were met with ''yes, let's'' instead of a reflexive ''no.'' It floods the relationship with the feeling of being on the same team. For one day, you're not the manager of their behavior; you're their co-conspirator. That feeling banks goodwill that lasts long after."},
    {"type":"h2","text":"You''ll learn something too"},
    {"type":"p","text":"Most parents discover, a little sheepishly, that half their daily nos were reflexes, not real limits. The world does not end when dessert comes first once. A Yes Day recalibrates your own defaults — you come back saying ''sure, why not'' a little more often, having learned that a lot of your nos were just habit wearing the costume of good parenting."},
    {"type":"p","text":"Try it once a season. It's cheaper than a big outing, and the kids will talk about it for years — not because you spent, but because you said yes."}
  ]$json$::jsonb, true
),

-- ═══ ORGANIZATION ════════════════════════════════════════════════════════════
(
  'one-in-one-out',
  'The One-In-One-Out Rule That Keeps Clutter From Creeping Back',
  'Decluttering is a moment; staying decluttered is a system. This one rule is the system, and it fits in a single sentence.',
  'Priya Anand', '2026-07-04', 4, ARRAY['decluttering','habits','minimalism'], 'Organization', true, '#3b82f6',
  'https://images.unsplash.com/photo-1502086223501-7ea6ecd79368?auto=format&fit=crop&w=1600&q=80',
  'An organized drawer with dividers holding neatly sorted everyday items',
  'Unsplash',
  $json$[
    {"type":"p","text":"You can spend a heroic weekend decluttering and, three months later, be exactly back where you started. That's not a willpower failure — it's a physics failure. Stuff flows in constantly (gifts, impulse buys, kids' party favors) and unless something flows out at the same rate, the tide always rises again. One-In-One-Out is the valve."},
    {"type":"h2","text":"The rule, in one sentence"},
    {"type":"p","text":"When a new thing comes in, an old thing of the same kind goes out. New pair of shoes? An old pair leaves. New toy? A toy is donated. New mug from that trip? A tired mug retires. The house stays at equilibrium not because you're disciplined, but because the rule does the arithmetic for you, automatically, at the moment of entry."},
    {"type":"h2","text":"It works best at the front door"},
    {"type":"p","text":"The rule is easiest when applied the instant something arrives, not months later during a purge. Unboxing a new gadget is the perfect time to retire the one it replaces — the decision is obvious and the old one is right there. Deferred, that same decision becomes agonizing. One-In-One-Out turns a hard annual reckoning into a tiny, painless, in-the-moment swap."},
    {"type":"h2","text":"Teach it to the kids with toys"},
    {"type":"p","text":"Kids' rooms are where clutter breeds fastest, and One-In-One-Out is a gentle way to teach the lesson young. Before a birthday or holiday, have them choose toys to pass on to kids who have less. It frames letting go as generosity rather than loss, and it keeps the playroom from becoming an unmanageable landfill of forgotten plastic."},
    {"type":"p","text":"Decluttering is an event you'll have to keep repeating. One-In-One-Out is the habit that finally lets you stop."}
  ]$json$::jsonb, true
),
(
  'the-toy-rotation-trick',
  'The Toy Rotation Trick: Fewer Toys Out, More Actual Play',
  'A playroom stuffed with options doesn''t inspire play — it overwhelms it. Hide two-thirds of the toys and watch play deepen.',
  'Priya Anand', '2026-07-02', 5, ARRAY['organizing','play','kids'], 'Organization', false, '#3b82f6',
  'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=1600&q=80',
  'A calm, tidy play space with a small curated set of toys',
  'Unsplash',
  $json$[
    {"type":"p","text":"Here's a paradox every parent has witnessed: a child surrounded by fifty toys, wailing that there's ''nothing to play with.'' It's not ingratitude. It's overwhelm. A sea of options short-circuits the imagination — there are too many choices to commit to any of them. The counterintuitive fix is to take most of the toys away."},
    {"type":"h2","text":"Split the toys into three bins"},
    {"type":"p","text":"Gather everything and divide it into roughly three groups. One group stays out; the other two get boxed and stashed in a closet, the garage, anywhere out of sight. That's it. The playroom now holds a curated, visible, manageable set — few enough that each toy can actually be seen, chosen, and played with deeply instead of dumped and abandoned."},
    {"type":"h2","text":"Rotate every couple of weeks"},
    {"type":"p","text":"When interest in the current set fades, swap it for a boxed group. Because the kids haven't seen those toys in weeks, they land like brand-new gifts — the old wooden train is suddenly fascinating again. You get the delight of ''new'' toys without buying a thing, and the toys you already own finally get the attention they deserve."},
    {"type":"h2","text":"Less really is more, for their brains too"},
    {"type":"p","text":"Fewer toys out means longer, more focused, more imaginative play — kids build elaborate worlds with a small set instead of skimming a huge one. It also makes cleanup trivial (a manageable number of things has a manageable number of homes). Abundance overwhelms; curation invites depth. Your child's attention span will thank you."},
    {"type":"p","text":"You don't need to buy less or love your kids less. You just need most of the toys to be somewhere they can't see them."}
  ]$json$::jsonb, true
),

-- ═══ SCHOOL & ACTIVITIES ═════════════════════════════════════════════════════
(
  'keep-reading-aloud',
  'Keep Reading Aloud Long After They Can Read Themselves',
  'The day a kid learns to read is not the day to stop reading to them. It might be the most important time to keep going.',
  'Elena Rodriguez', '2026-07-04', 6, ARRAY['reading','literacy','connection'], 'School & Activities', true, '#10b981',
  'https://images.unsplash.com/photo-1476234251651-f353703a034d?auto=format&fit=crop&w=1600&q=80',
  'A parent and child reading a book together outdoors',
  'Unsplash',
  $json$[
    {"type":"p","text":"There's a quiet milestone most families treat as a finish line: the child can read on their own now, so the nightly read-aloud winds down. It's an understandable instinct and, according to decades of literacy research, a small mistake. The years after a kid learns to read are some of the best years to keep reading to them."},
    {"type":"h2","text":"Their ears run ahead of their eyes"},
    {"type":"p","text":"A child's listening comprehension outpaces their reading ability for years. A seven-year-old who's decoding simple chapter books can understand and adore a far richer, funnier, more complex story read aloud. Reading up a level feeds them vocabulary, sentence rhythm, and ideas they can't yet reach on the page alone. You're pouring language into a wider funnel than the one their own reading can fill."},
    {"type":"h2","text":"It keeps books feeling like joy, not work"},
    {"type":"p","text":"Once reading becomes a school task — leveled, tested, assigned — it's easy for kids to file it under ''work.'' A parent's voice doing the silly character accents keeps the other association alive: books are pleasure, closeness, adventure. That emotional link is what turns a kid who can read into a kid who wants to, which is the whole ballgame."},
    {"type":"h2","text":"The real payload is the closeness"},
    {"type":"p","text":"A read-aloud is a nightly ritual of undivided attention — a warm, screen-free, shoulder-to-shoulder ten minutes that gets harder to come by as kids grow. The story is almost a pretext. Families who read aloud into the tween years often find it's the setting where the real conversations sneak out, in the quiet after ''the end.''"},
    {"type":"p","text":"Don't retire the bedtime story the moment they can decode it. Read up, read on, and keep the best ten minutes of the day."}
  ]$json$::jsonb, true
),
(
  'the-picture-checklist',
  'The Picture Checklist That Ends Morning Nagging Before School',
  'You''re not a drill sergeant; you just sound like one every morning. Hand the routine to a checklist and get your nice voice back.',
  'Elena Rodriguez', '2026-07-02', 5, ARRAY['school','routines','independence'], 'School & Activities', false, '#10b981',
  'https://images.unsplash.com/photo-1506784983877-45594efa4cbe?auto=format&fit=crop&w=1600&q=80',
  'A backpack and morning checklist laid out and ready by the door',
  'Unsplash',
  $json$[
    {"type":"p","text":"The school-morning nag is a role no parent auditioned for: ''brush your teeth, did you brush your teeth, where are your shoes, get your backpack, SHOES.'' You become a human alarm clock repeating the same six instructions until everyone's frazzled. The fix isn't more reminders. It's outsourcing the reminding to something that isn't you."},
    {"type":"h2","text":"Let the list be the boss"},
    {"type":"p","text":"Make a simple checklist of the morning steps — get dressed, breakfast, teeth, hair, shoes, backpack — and post it where the kid can see it. For pre-readers, use pictures or photos of your own child doing each step. Now the checklist gives the instructions, not you. ''What's next on your list?'' replaces the tenth reminder, and the answer is right there on the wall."},
    {"type":"h2","text":"It transfers ownership, not just tasks"},
    {"type":"p","text":"The deeper win is psychological. When you nag, the responsibility lives with you — the kid just reacts. When the list runs the morning, the responsibility shifts to them: they're in charge of getting through their own steps. Checking off each one delivers a little hit of competence and pride. You've turned a battle of wills into a task they own."},
    {"type":"h2","text":"Fewer words, warmer mornings"},
    {"type":"p","text":"With the list doing the heavy lifting, your voice is freed up for the good stuff — a joke, a snuggle, ''have a great day'' — instead of a countdown of demands. The house gets quieter and kinder, the kid gets more capable, and the last thing they hear before school stops being your stressed-out voice listing their failures."},
    {"type":"p","text":"Print it, laminate it, stick it by the door. Then step back and let a piece of paper do the nagging you never wanted to do anyway."}
  ]$json$::jsonb, true
),

-- ═══ AI & TECHNOLOGY ═════════════════════════════════════════════════════════
(
  'your-family-needs-a-second-brain',
  'Your Family Needs a Second Brain (and It Shouldn''t Be Your Memory)',
  'One parent usually becomes the household''s human database — every date, size, and password lives in their head. That''s a single point of failure.',
  'Jessica Miller', '2026-07-04', 6, ARRAY['ai','mental load','organization'], 'AI & Technology', true, '#6366f1',
  'https://images.unsplash.com/photo-1489710437720-ebb67ec84dd2?auto=format&fit=crop&w=1600&q=80',
  'A parent and child looking at a tablet together on a couch',
  'Unsplash',
  $json$[
    {"type":"p","text":"In most families, one person quietly becomes the database. They know the pediatrician's number, the kids' shoe sizes, the wifi password, which cousin is allergic to what, when the car registration is due, and the exact location of everything. It feels like being organized. It's actually a dangerous single point of failure — and a crushing invisible load on one person's mind."},
    {"type":"h2","text":"A brain is a terrible filing cabinet"},
    {"type":"p","text":"Human memory is brilliant at ideas and awful at appointment times. When the household's logistics live only in one person's head, two bad things happen: that person is perpetually mentally taxed, and everyone else is helpless without them. Ask ''when's the dentist?'' and if the keeper of the database is out, the answer is simply lost. That's fragile by design."},
    {"type":"h2","text":"Move it out of the head and into a shared system"},
    {"type":"p","text":"A family ''second brain'' is any shared, searchable place where the facts live instead of in one skull — the calendar, the household binder, the shared notes, increasingly an AI assistant you can just ask. The test is simple: could the other parent find the field-trip date without texting you? If yes, you've built a second brain. If no, you are the second brain, and you're tired."},
    {"type":"h2","text":"AI is finally good at the boring recall"},
    {"type":"p","text":"This is exactly the unglamorous job AI is suited for: ''remind me what size coat Leo wears,'' ''when did we last replace the furnace filter,'' ''what's the code for the school gate.'' Offloading recall isn't laziness — it's freeing up the one truly scarce resource in a family, a parent's attention, for the things a database can never do, like actually being present."},
    {"type":"p","text":"The goal isn't to remember more. It's to need to remember less — so the household keeps running even when the person who usually remembers everything gets to stop."}
  ]$json$::jsonb, true
),
(
  'the-family-photo-avalanche',
  'Taming the Family Photo Avalanche (With a Little Help From AI)',
  'You have 40,000 photos and can''t find the one from last Tuesday. The memories you''re capturing are being buried by the capturing.',
  'Marcus Bennett', '2026-07-02', 5, ARRAY['ai','photos','organization'], 'AI & Technology', false, '#6366f1',
  'https://images.unsplash.com/photo-1531482615713-2afd69097998?auto=format&fit=crop&w=1600&q=80',
  'A phone held up showing a gallery of family photos',
  'Unsplash',
  $json$[
    {"type":"p","text":"Every modern parent is a documentary filmmaker with no editor. We take twelve near-identical photos of the birthday cake, four hundred of the beach trip, a blurry burst of the school play — and then never look at any of them again, because finding a specific memory in a pile of forty thousand is worse than not having it. We're burying the moments in the act of saving them."},
    {"type":"h2","text":"Capturing isn''t keeping"},
    {"type":"p","text":"A photo you can never find again is functionally lost. The whole point of taking pictures is to revisit them — to actually feel the memory later — and an unsorted avalanche makes that nearly impossible. The value was never in the taking; it was in the looking-back, and the looking-back is exactly what the pile destroys."},
    {"type":"h2","text":"Let AI do the sorting you''ll never do"},
    {"type":"p","text":"This is one of the genuinely great uses of AI in family life. Modern photo tools can search by face, place, and thing — ''show me photos of Grandma and the kids,'' ''find the beach trip from two summers ago'' — surfacing the needle without you ever building the haystack's index by hand. The sorting you were never going to do gets done automatically."},
    {"type":"h2","text":"Curate a little, on purpose"},
    {"type":"p","text":"Technology handles retrieval; a small human habit handles meaning. Once a month, pick a handful of real favorites into an album, or let an assistant assemble a ''best of'' for you to trim. A tiny curated set that actually gets looked at — printed, made into a book, set as the family screensaver — is worth more than ten thousand photos nobody opens."},
    {"type":"p","text":"Take all the pictures you want. Just let a machine make them findable again, so the memories you captured don't get lost in the pile of capturing them."}
  ]$json$::jsonb, true
),

-- ═══ WELLNESS ════════════════════════════════════════════════════════════════
(
  'the-worry-window',
  'The Worry Window: A 10-Minute Trick for Anxious Kids (and Their Parents)',
  'You can''t argue a worried kid out of their worry. But you can give the worry a scheduled place to live — and free up the rest of the day.',
  'Dr. Sarah Kim', '2026-07-04', 6, ARRAY['anxiety','mental health','emotional health'], 'Wellness', true, '#f59e0b',
  'https://images.unsplash.com/photo-1554224154-26032ffc0d07?auto=format&fit=crop&w=1600&q=80',
  'A parent and child sitting calmly together by a window',
  'Unsplash',
  $json$[
    {"type":"p","text":"When a child is anxious, the worries don't stay in one place — they leak into breakfast, into the car, into bedtime, into everything. And the well-meaning parent response (''don't worry, it'll be fine!'') almost never helps, because you can't logic someone out of a feeling. There's a gentler, oddly effective tool borrowed from therapists: the Worry Window."},
    {"type":"h2","text":"Give the worry an appointment"},
    {"type":"p","text":"The idea is to designate a short, daily ''worry time'' — say ten minutes after dinner — when your child is allowed, even invited, to voice every worry, and you listen. Throughout the rest of the day, when a worry pops up, you gently acknowledge it and ''save it for the Worry Window.'' The worry isn't dismissed; it's scheduled. That distinction is everything."},
    {"type":"h2","text":"Why containment beats suppression"},
    {"type":"p","text":"Telling a kid ''stop worrying'' asks them to suppress, which tends to make worries louder. The Worry Window does the opposite: it validates that the worry is real and gives it a container. Kids often find that by the time the window arrives, half the worries have quietly evaporated — and the ones that remain get real airtime and your full attention. Contained worry shrinks; suppressed worry grows."},
    {"type":"h2","text":"During the window, listen more than you fix"},
    {"type":"p","text":"When worry time comes, your job is mostly to listen and reflect — ''that sounds really scary, tell me more'' — not to rush in with solutions. For worries you can act on, you can problem-solve together. For the many that you can't, being heard is the help. A kid who knows their fears have a place to be spoken is far less ruled by them the rest of the day."},
    {"type":"p","text":"You can't take the worry away. But you can give it a window — and hand your child back the other twenty-three hours and fifty minutes."}
  ]$json$::jsonb, true
),
(
  'outside-is-the-reset-button',
  'Outside Is the Reset Button: The Case for the After-School Park Run',
  'The rough transition from school to home has a stupidly simple fix, and it''s free, and it''s right outside your door.',
  'Dr. Sarah Kim', '2026-07-02', 5, ARRAY['outdoors','movement','routines'], 'Wellness', false, '#f59e0b',
  'https://images.unsplash.com/photo-1495364141860-b0d03eccd065?auto=format&fit=crop&w=1600&q=80',
  'Kids running and playing freely in a park at golden hour',
  'Unsplash',
  $json$[
    {"type":"p","text":"The after-school hours are a notorious minefield: kids come home wired, cranky, and weirdly ready to fall apart over nothing. They've spent all day holding it together in a classroom, and the second they hit the safety of home, the pressure valve blows. Before you head inside to homework and dinner, try the counterintuitive move — don't go inside. Go to the park."},
    {"type":"h2","text":"They''ve been sitting still for hours"},
    {"type":"p","text":"A school day asks kids to sit, focus, and inhibit their impulses for an unnatural length of time. By dismissal, their bodies are coiled with unspent energy and their nervous systems are frayed from constant self-control. Homework right now is a losing battle. What they need first isn't more sitting — it's to run, climb, swing, and shake the whole day out of their limbs."},
    {"type":"h2","text":"Movement is the reset, not the reward"},
    {"type":"p","text":"Thirty minutes of hard outdoor play does what no amount of coaxing can: it discharges the tension, floods the brain with the chemistry of calm and focus, and resets the mood. Kids who run the yard out before homework do the homework faster and with fewer meltdowns. The park isn't stealing time from the afternoon — it's what makes the rest of the afternoon possible."},
    {"type":"h2","text":"It resets the parents, too"},
    {"type":"p","text":"There's a bonus: you get outside, you move a little, you talk on the walk in a way that rarely happens across a kitchen table. The after-school park run becomes a shared decompression for the whole family — a daily hinge between the school world and the home world that lets everyone arrive at dinner as their better selves."},
    {"type":"p","text":"Before the homework fight, before the witching hour, try the oldest reset there is: send them outside. It's free, it's fast, and it fixes more than it has any right to."}
  ]$json$::jsonb, true
),

-- ═══ FAMILY FINANCES ═════════════════════════════════════════════════════════
(
  'the-monthly-money-date',
  'The Monthly Money Date: How Couples Stop Fighting About Money',
  'Money fights are rarely about money. They''re about two people who never sat down, on purpose, to look at the same numbers together.',
  'David Okafor', '2026-07-04', 6, ARRAY['budget','partnership','family finances'], 'Family Finances', true, '#f43f5e',
  'https://images.unsplash.com/photo-1611371805429-8b5c1b2c34ba?auto=format&fit=crop&w=1600&q=80',
  'A close-up of a classic board game money track — the family economy in miniature',
  'Unsplash',
  $json$[
    {"type":"p","text":"Money is one of the top things couples fight about, but the fights are almost never really about the dollars. They're about surprise, about feeling unheard, about two people operating from two different mental spreadsheets that only collide during an argument. The fix is disarmingly boring: a scheduled, recurring, low-drama money date."},
    {"type":"h2","text":"Schedule it so it isn''t an ambush"},
    {"type":"p","text":"The worst time to talk about money is in the heat of a surprise bill or a resented purchase. A monthly money date moves the conversation to calm, neutral ground — a set time, maybe with a glass of wine or a coffee, when you both know it's coming. Nobody's blindsided, nobody's defensive, and the numbers get discussed before they become a fight."},
    {"type":"h2","text":"Look at the same reality together"},
    {"type":"p","text":"So much money conflict comes from partners having different pictures of where things stand. The money date creates one shared picture: here's what came in, here's what went out, here's what's coming, here's how we're doing against our goals. When both people are looking at the same reality, the conversation shifts from ''you spent too much'' to ''how do we want to handle this,'' which is a completely different room to be in."},
    {"type":"h2","text":"Talk goals, not just gaps"},
    {"type":"p","text":"A money date isn't only for policing spending — that would make it something to dread. Spend part of it dreaming: the trip you're saving for, the debt you're killing, the cushion you're building. Connecting the monthly numbers to a shared future turns budgeting from a chore into teamwork. You stop being two people guarding separate wallets and start being partners aimed at the same horizon."},
    {"type":"p","text":"Put it on the calendar once a month. An hour of talking on purpose beats a year of fighting by accident."}
  ]$json$::jsonb, true
),
(
  'the-give-jar',
  'The Give Jar: Teaching Generosity Right Alongside Saving',
  'We teach kids to spend and save. The third jar — the one for giving — quietly grows a different kind of wealth.',
  'David Okafor', '2026-07-02', 5, ARRAY['giving','money skills','values'], 'Family Finances', false, '#f43f5e',
  'https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=1600&q=80',
  'A child dividing coins into labeled jars, including one for giving',
  'Unsplash',
  $json$[
    {"type":"p","text":"When we teach kids about money, we usually cover two moves: spend it or save it. But there's a third jar that does something the other two can't — the Give jar. Setting aside a small slice of every dollar for generosity teaches a lesson about money that most adults never fully learned: that having some is also a chance to help."},
    {"type":"h2","text":"Three jars, every time money comes in"},
    {"type":"p","text":"The system is simple: whenever a kid earns or receives money, it splits three ways — some to Spend, some to Save toward a goal, and some to Give. The Give jar is usually the smallest, but its presence is the point. It makes generosity a normal, automatic part of what you do with money, not an occasional afterthought when someone's collecting."},
    {"type":"h2","text":"Let the child choose the cause"},
    {"type":"p","text":"The magic happens when the Give jar fills and the child gets to decide where it goes — an animal shelter, a friend in need, a cause they saw on the news and couldn't stop thinking about. That choice transforms giving from an abstract virtue into a concrete, empowering act. They feel the specific good their own money did, and that feeling is the whole curriculum."},
    {"type":"h2","text":"You''re teaching that money serves values"},
    {"type":"p","text":"The deepest lesson of the Give jar isn't about charity — it's about the relationship between money and meaning. A kid who grows up routinely directing some of their money toward what they care about learns that money is a tool in service of their values, not a scoreboard. That's a kind of wealth no balance can measure, and it starts with a jar and a few coins."},
    {"type":"p","text":"Add the third jar. Spending is fun and saving is wise, but giving is where kids learn that having enough means you get to share."}
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
