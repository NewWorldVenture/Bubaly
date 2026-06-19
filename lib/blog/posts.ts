// Lightweight CMS-style content source. Swap this module for a headless CMS or MDX
// later without touching the blog routes — they only depend on these functions.

export type BlogPost = {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  date: string; // ISO
  readingMinutes: number;
  tags: string[];
  /** Body as ordered blocks so we never need a markdown parser dependency. */
  body: Array<{ type: 'p' | 'h2'; text: string }>;
};

const POSTS: BlogPost[] = [
  {
    slug: 'taming-the-family-mental-load',
    title: 'Taming the family mental load',
    excerpt: 'The invisible work of running a household is real. Here’s how to share it.',
    author: 'The FamilyOS Team',
    date: '2026-05-02',
    readingMinutes: 4,
    tags: ['organization', 'parenting'],
    body: [
      { type: 'p', text: 'Every household runs on a hidden layer of coordination: who has practice, what’s for dinner, when the prescription runs out, which form is due Friday. It rarely shows up on a to-do list, but it’s exhausting.' },
      { type: 'h2', text: 'Make the invisible visible' },
      { type: 'p', text: 'The first step is simply getting everything out of one person’s head and into a shared place the whole family can see. A single calendar, a single grocery list, one source of truth.' },
      { type: 'h2', text: 'Then share the load' },
      { type: 'p', text: 'With roles and assignments, the work spreads naturally. Teens own their own schedules; kids check off chores; an AI assistant handles the busywork of creating events and lists.' },
    ],
  },
  {
    slug: 'meal-planning-that-actually-sticks',
    title: 'Meal planning that actually sticks',
    excerpt: 'A simple weekly rhythm — and how to make the grocery list build itself.',
    author: 'The FamilyOS Team',
    date: '2026-05-18',
    readingMinutes: 3,
    tags: ['meals', 'routines'],
    body: [
      { type: 'p', text: 'Most meal-planning systems fail because they’re too much work. The trick is a light weekly rhythm you can keep without thinking.' },
      { type: 'h2', text: 'Plan once, shop automatically' },
      { type: 'p', text: 'In FamilyOS, plan the week’s dinners from your saved meals, then turn that plan into a grocery list with one action. The ingredients flow straight into a shared, real-time list.' },
    ],
  },
  {
    slug: 'an-ai-chief-of-staff-for-your-home',
    title: 'An AI chief of staff for your home',
    excerpt: 'What it means for an assistant to take action, not just answer.',
    author: 'The FamilyOS Team',
    date: '2026-06-01',
    readingMinutes: 5,
    tags: ['ai', 'product'],
    body: [
      { type: 'p', text: 'Chatbots answer questions. A chief of staff gets things done. That distinction is the whole idea behind the FamilyOS assistant.' },
      { type: 'h2', text: 'From words to records' },
      { type: 'p', text: 'Ask it to add soccer every Tuesday and it creates the recurring event. Ask it to plan dinners and build a grocery list, and it writes real rows into your family’s database — scoped securely to your household.' },
      { type: 'h2', text: 'Private by construction' },
      { type: 'p', text: 'Because the assistant acts through your authenticated session, it physically cannot touch another family’s data. Security isn’t bolted on; it’s the foundation.' },
    ],
  },
];

export function getAllPosts(): BlogPost[] {
  return [...POSTS].sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}
