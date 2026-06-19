// Lightweight CMS-style content source. Swap for a headless CMS later without touching blog routes.

export type BlogCategory =
  | 'Parenting'
  | 'Organization'
  | 'School & Activities'
  | 'AI & Technology'
  | 'Wellness'
  | 'Family Finances';

export type BlogPost = {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  date: string;
  readingMinutes: number;
  tags: string[];
  category: BlogCategory;
  featured?: boolean;
  accentColor?: string;
  body: Array<{ type: 'p' | 'h2'; text: string }>;
};

const POSTS: BlogPost[] = [
  {
    slug: 'an-ai-chief-of-staff-for-your-home',
    title: 'The AI Family Assistant: A New Way to Stay Ahead of Everything',
    excerpt: 'From school emails to soccer practice, see how AI can help your family stay organized, stress-free, and always one step ahead.',
    author: 'Jessica Miller',
    date: '2024-05-12',
    readingMinutes: 6,
    tags: ['ai', 'product'],
    category: 'AI & Technology',
    featured: true,
    accentColor: '#7c5dff',
    body: [
      { type: 'p', text: "Chatbots answer questions. A chief of staff gets things done. That distinction is the whole idea behind the FamilyOS assistant." },
      { type: 'h2', text: 'From words to records' },
      { type: 'p', text: "Ask it to add soccer every Tuesday and it creates the recurring event. Ask it to plan dinners and build a grocery list, and it writes real rows into your family's database." },
    ],
  },
  {
    slug: 'sync-family-schedule',
    title: "How to Sync Your Family's Schedule (Without the Chaos)",
    excerpt: "A practical guide to keeping everyone on the same page — from soccer practice to dentist appointments.",
    author: 'The FamilyOS Team',
    date: '2024-05-10',
    readingMinutes: 5,
    tags: ['organization'],
    category: 'Organization',
    accentColor: '#3b82f6',
    body: [{ type: 'p', text: "Every household runs on a hidden layer of coordination. Here's how to make it visible and shared." }],
  },
  {
    slug: 'last-day-school-checklist',
    title: "Last-Day-of-School Checklist: Don't Miss a Thing",
    excerpt: "Return the library books, pick up art projects, say goodbye to teachers — a complete end-of-year checklist.",
    author: 'The FamilyOS Team',
    date: '2024-05-09',
    readingMinutes: 4,
    tags: ['school'],
    category: 'School & Activities',
    accentColor: '#10b981',
    body: [{ type: 'p', text: "The last week of school is a whirlwind. Here's how to get through it without forgetting anything." }],
  },
  {
    slug: 'healthy-family-habits',
    title: 'Healthy Family Habits That Stick (Even on Busy Weeks)',
    excerpt: "Small rituals that make a big difference — and how to actually maintain them when life gets hectic.",
    author: 'The FamilyOS Team',
    date: '2024-05-07',
    readingMinutes: 6,
    tags: ['wellness'],
    category: 'Wellness',
    accentColor: '#f59e0b',
    body: [{ type: 'p', text: "The habits that stick are the ones that require the least willpower." }],
  },
  {
    slug: 'family-budget-basics',
    title: 'Budgeting as a Family: 5 Simple Steps to Get Started',
    excerpt: "Money conversations don't have to be stressful. Here's a framework that actually works for busy families.",
    author: 'The FamilyOS Team',
    date: '2024-05-04',
    readingMinutes: 5,
    tags: ['finances'],
    category: 'Family Finances',
    accentColor: '#ec4899',
    body: [{ type: 'p', text: "Starting a family budget feels overwhelming. Break it into five simple steps." }],
  },
  {
    slug: 'ai-family-life',
    title: '5 Ways AI Can Make Family Life So Much Easier',
    excerpt: "From meal planning to homework help, AI is quietly transforming how modern families operate.",
    author: 'The FamilyOS Team',
    date: '2024-05-02',
    readingMinutes: 6,
    tags: ['ai'],
    category: 'AI & Technology',
    accentColor: '#7c5dff',
    body: [{ type: 'p', text: "AI isn't just for tech companies. Here are five practical ways it's changing family life." }],
  },
  {
    slug: 'quality-time',
    title: 'How to Create More Quality Time (Without More Time)',
    excerpt: "The secret isn't finding more hours. It's making the hours you have count.",
    author: 'The FamilyOS Team',
    date: '2024-04-30',
    readingMinutes: 6,
    tags: ['parenting', 'wellness'],
    category: 'Parenting',
    accentColor: '#f97316',
    body: [{ type: 'p', text: "Most parents already know how precious time with their kids is. The challenge is protecting it." }],
  },
  {
    slug: 'taming-the-family-mental-load',
    title: 'Taming the family mental load',
    excerpt: "The invisible work of running a household is real. Here's how to share it.",
    author: 'The FamilyOS Team',
    date: '2026-05-02',
    readingMinutes: 4,
    tags: ['organization', 'parenting'],
    category: 'Parenting',
    body: [{ type: 'p', text: "Every household runs on a hidden layer of coordination." }],
  },
  {
    slug: 'meal-planning-that-actually-sticks',
    title: 'Meal planning that actually sticks',
    excerpt: "A simple weekly rhythm — and how to make the grocery list build itself.",
    author: 'The FamilyOS Team',
    date: '2026-05-18',
    readingMinutes: 3,
    tags: ['meals', 'routines'],
    category: 'Organization',
    body: [{ type: 'p', text: "Most meal-planning systems fail because they're too much work." }],
  },
];

export function getAllPosts(): BlogPost[] {
  return [...POSTS].sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}

export function getFeaturedPost(): BlogPost | undefined {
  return POSTS.find((p) => p.featured) ?? POSTS[0];
}

export const ALL_CATEGORIES: BlogCategory[] = [
  'Parenting', 'Organization', 'School & Activities', 'AI & Technology', 'Wellness', 'Family Finances',
];
