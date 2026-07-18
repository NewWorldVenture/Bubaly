// lib/marketing/aeo.ts — public reader for the AEO Knowledge Center.
// The admin AEO console (/admin/marketing/aeo) manages marketing_aeo_questions;
// PUBLISHED rows are world-readable (migration 0228), so the public FAQ page and
// every blog article render the SAME answers + their FAQPage structured data.
// One edit in the admin console propagates everywhere — the closed loop.
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export type AeoQuestion = {
  question: string;
  answer: string;
  entity: string | null;
  pattern: string | null;
  sourcePath: string | null;
  topic: string | null;
  category: string | null;
};

export type PublicAeoRead = {
  questions: AeoQuestion[];
  /** False means the source could not be read; an empty successful result is valid. */
  available: boolean;
};

function anonClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}

type Row = Database['public']['Tables']['marketing_aeo_questions']['Row'];

function toQuestion(r: Row): AeoQuestion {
  const meta = (r.metadata ?? {}) as Record<string, unknown>;
  return {
    question: r.question,
    answer: r.answer ?? '',
    entity: r.entity,
    pattern: r.pattern,
    sourcePath: r.source_path,
    topic: typeof meta.topic === 'string' ? meta.topic : null,
    category: typeof meta.category === 'string' ? meta.category : null,
  };
}

/** Published AEO questions that carry a real answer (safe to render + cite). */
export async function readPublishedAeoQuestions(limit = 60): Promise<PublicAeoRead> {
  try {
    const { data, error } = await anonClient()
      .from('marketing_aeo_questions')
      .select('*')
      .eq('status', 'published')
      .not('answer', 'is', null)
      .order('clarity_score', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) {
      console.error('[marketing-aeo] published questions read failed', error);
      return { questions: [], available: false };
    }
    return {
      questions: (data ?? []).map(toQuestion).filter((q) => q.answer.trim().length > 0),
      available: true,
    };
  } catch (error) {
    console.error('[marketing-aeo] published questions read failed', error);
    return { questions: [], available: false };
  }
}

export async function getPublishedAeoQuestions(limit = 60): Promise<AeoQuestion[]> {
  return (await readPublishedAeoQuestions(limit)).questions;
}

/**
 * Published AEO questions most relevant to a blog category — so each article can
 * render an on-topic FAQ block + FAQPage schema that links back to the AEO
 * Knowledge Center. Falls back to general questions if a category is thin.
 */
export async function readAeoQuestionsForCategory(category: string, limit = 4): Promise<PublicAeoRead> {
  try {
    const client = anonClient();
    const { data, error } = await client
      .from('marketing_aeo_questions')
      .select('*')
      .eq('status', 'published')
      .not('answer', 'is', null)
      .eq('metadata->>category', category)
      .order('clarity_score', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) {
      console.error('[marketing-aeo] category questions read failed', error);
      return { questions: [], available: false };
    }
    let rows = (data ?? []).map(toQuestion).filter((q) => q.answer.trim().length > 0);
    let available = true;
    if (rows.length < limit) {
      const extra = await readPublishedAeoQuestions(limit * 2);
      available = extra.available;
      const seen = new Set(rows.map((r) => r.question));
      for (const q of extra.questions) {
        if (rows.length >= limit) break;
        if (!seen.has(q.question)) { rows = [...rows, q]; seen.add(q.question); }
      }
    }
    return { questions: rows.slice(0, limit), available };
  } catch (error) {
    console.error('[marketing-aeo] category questions read failed', error);
    return { questions: [], available: false };
  }
}

export async function getAeoQuestionsForCategory(category: string, limit = 4): Promise<AeoQuestion[]> {
  return (await readAeoQuestionsForCategory(category, limit)).questions;
}
