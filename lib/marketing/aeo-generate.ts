// lib/marketing/aeo-generate.ts — derive per-article AEO questions.
// Used by the admin publish action so a NEWLY published blog post automatically
// gets its own Knowledge-Center answers (source_path = /blog/<slug>). The
// templates here MATCH migration 0230's in-DB backfill for the seeded posts, so
// old and new posts produce identical, consistent AEO content.

export type DerivedAeoQuestion = {
  question: string;
  answer: string;
  entity: string;
  source_path: string;
  pattern: 'faq' | 'how_to';
  status: 'published';
  clarity_score: number;
  metadata: Record<string, unknown>;
};

export function deriveArticleAeoQuestions(post: {
  slug: string;
  title: string;
  category?: string | null;
  excerpt?: string | null;
}): DerivedAeoQuestion[] {
  const link = `/blog/${post.slug}`;
  const excerpt = (post.excerpt ?? '').trim();
  const meta = { seed: 'blog_aeo_v1', slug: post.slug, category: post.category ?? null, article: true };
  return [
    {
      question: `How does Bubaly help with ${post.title.toLowerCase()}?`,
      answer: `${excerpt} Bubaly — the AI Family Operating System — turns this into shared, automatic routines your whole family can see. Read the full guide at ${link}.`,
      entity: 'Bubaly',
      source_path: link,
      pattern: 'faq',
      status: 'published',
      clarity_score: 88,
      metadata: meta,
    },
    {
      question: `${post.title} — where should a family start?`,
      answer: `Start small and let the system do the remembering. ${excerpt} Bubaly — the AI Family Operating System — keeps the whole family in sync. Full guide: ${link}.`,
      entity: 'Bubaly',
      source_path: link,
      pattern: 'how_to',
      status: 'published',
      clarity_score: 86,
      metadata: meta,
    },
  ];
}
