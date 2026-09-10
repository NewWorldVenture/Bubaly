// lib/marketing/aeo.ts — public reader for the AEO Knowledge Center.
// The admin AEO console (/admin/marketing/aeo) manages marketing_aeo_questions;
// PUBLISHED rows are world-readable (migration 0228), so the public FAQ page and
// every blog article render the SAME answers + their FAQPage structured data.
// One edit in the admin console propagates everywhere — the closed loop.
import { unstable_cache } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { localeFallbackChain } from '@/lib/i18n/messages';

export type AeoQuestion = {
  /** Empty for questions that came from a page payload rather than a table row;
   *  those cannot be localized because there is nothing to join a translation to. */
  id: string;
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

function toPayloadQuestions(value: unknown, fallbackPath: string): AeoQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const question = typeof row.question === 'string' ? row.question.trim() : '';
    const answer = typeof row.answer === 'string' ? row.answer.trim() : '';
    if (!question || !answer) return [];
    return [{
      id: typeof row.id === 'string' ? row.id : '',
      question,
      answer,
      entity: typeof row.entity === 'string' ? row.entity : null,
      pattern: typeof row.pattern === 'string' ? row.pattern : null,
      sourcePath: typeof row.sourcePath === 'string' ? row.sourcePath : typeof row.source_path === 'string' ? row.source_path : fallbackPath,
      topic: typeof row.topic === 'string' ? row.topic : null,
      category: typeof row.category === 'string' ? row.category : null,
    }];
  });
}

function toQuestion(r: Row): AeoQuestion {
  const meta = (r.metadata ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
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

/** Cache tag for every public AEO read, so an admin edit can drop them all. */
export const AEO_TAG = 'marketing-aeo';

/**
 * The per-path read, cached.
 *
 * MarketingAeoSection renders on the homepage, /features, /ai, /contact, the
 * legal pages and every /f/[id] — so the uncached version ran one Supabase
 * query per marketing page view. pg_stat_statements caught it at 7,627 calls
 * in 24 hours against a t4g.nano, the single largest recurring reader on the
 * database.
 *
 * `path` is an argument, so Next keys the cache per path and the pages do not
 * share each other's answers. Tagged rather than short-TTL because the whole
 * point of the AEO console is that one edit propagates everywhere immediately:
 * the admin write paths revalidate this tag, so "immediately" still holds.
 *
 * Only a read that SUCCEEDED is cached. readAeoQuestionsForPath degrades to
 * `available: false` when the database is unreachable, which is right for
 * rendering and wrong to store — caching it would keep the Knowledge Center
 * empty for an hour after a blip. So the cached function throws on that, and
 * the catch below sits outside the cache.
 */
const cachedRead = unstable_cache(
  async (path: string, limit: number): Promise<PublicAeoRead> => {
    const result = await readAeoQuestionsForPath(path, limit);
    if (!result.available) throw new Error(`[marketing-aeo] unavailable for ${path}`);
    return result;
  },
  ['marketing-aeo-path'],
  { revalidate: 3600, tags: [AEO_TAG] },
);

/** What the public pages call. Cached; falls back to a live-but-empty read. */
export async function readAeoQuestionsForPathCached(path: string, limit = 6): Promise<PublicAeoRead> {
  try {
    return await cachedRead(path, limit);
  } catch {
    // Already logged inside the uncached read. Render the page without the
    // Knowledge Center rather than failing it, and try again next render.
    return { questions: [], available: false };
  }
}

// The other two public readers of this table, cached the same way and under the
// same tag. /faq pulls 60 rows on every view, and every blog article ran two of
// these per view — all of it the same handful of admin-managed answers.

const cachedPublished = unstable_cache(
  async (limit: number): Promise<PublicAeoRead> => {
    const result = await readPublishedAeoQuestions(limit);
    if (!result.available) throw new Error('[marketing-aeo] published read unavailable');
    return result;
  },
  ['marketing-aeo-published'],
  { revalidate: 3600, tags: [AEO_TAG] },
);

/** Every published question — the /faq page. Cached. */
export async function readPublishedAeoQuestionsCached(limit = 60): Promise<PublicAeoRead> {
  try {
    return await cachedPublished(limit);
  } catch {
    return { questions: [], available: false };
  }
}

const cachedCategory = unstable_cache(
  async (category: string, limit: number): Promise<PublicAeoRead> => {
    const result = await readAeoQuestionsForCategory(category, limit);
    if (!result.available) throw new Error(`[marketing-aeo] category read unavailable for ${category}`);
    return result;
  },
  ['marketing-aeo-category'],
  { revalidate: 3600, tags: [AEO_TAG] },
);

/** Questions for one blog category. Cached. */
export async function readAeoQuestionsForCategoryCached(category: string, limit = 4): Promise<PublicAeoRead> {
  try {
    return await cachedCategory(category, limit);
  } catch {
    return { questions: [], available: false };
  }
}

/** Read the canonical page payload populated by the Super Admin content loop. */
export async function readAeoQuestionsForPath(path: string, limit = 6): Promise<PublicAeoRead> {
  try {
    const client = anonClient();
    // The AEO console is the editable source of truth. Prefer its published
    // rows so an admin answer reaches every matching public route immediately.
    const { data: rows, error: rowsError } = await client
      .from('marketing_aeo_questions')
      .select('*')
      .eq('source_path', path)
      .eq('status', 'published')
      .not('answer', 'is', null)
      .order('clarity_score', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (!rowsError) {
      const questions = (rows ?? []).map(toQuestion).filter((q) => q.answer.trim().length > 0);
      // A successful empty result is authoritative: deleting or unpublishing
      // an answer must remove it publicly instead of resurrecting stale JSON.
      return { questions, available: true };
    } else {
      console.error('[marketing-aeo] path question rows read failed', rowsError);
    }

    const { data, error } = await client
      .from('marketing_pages')
      .select('aeo')
      .eq('path', path)
      .eq('status', 'published')
      .is('deleted_at', null)
      .maybeSingle();
    if (error) {
      console.error('[marketing-aeo] path questions read failed', error);
      return { questions: [], available: false };
    }
    const payload = data?.aeo;
    const questions = toPayloadQuestions(
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>).questions : payload,
      path,
    );
    return { questions: questions.slice(0, limit), available: !error || Boolean(data) };
  } catch (error) {
    console.error('[marketing-aeo] path questions read failed', error);
    return { questions: [], available: false };
  }
}

/**
 * Swap in the reader's language.
 *
 * The knowledge base is stored once, in English, because it is editorial
 * content an admin maintains — so a localized page rendered a translated
 * heading over an English accordion. `marketing_aeo_question_translations`
 * (migration 0277) adds the missing locale dimension; this applies it.
 *
 * On a non-English locale an UNTRANSLATED question is dropped rather than shown
 * in English. Half-translating a page is the bug being fixed here, and a
 * shorter list in the reader's own language beats a full one in someone else's.
 * English locales skip the lookup entirely and are unaffected.
 *
 * Two things stop that rule from turning a translation gap into a hole.
 *
 * A regional locale reads its parent's rows. The translation table is keyed on
 * the exact code, but fr-CA, es-MX and es-US ship as OVERLAY catalogues that
 * resolve their chrome through fr-FR and es-ES — so keying the answers strictly
 * would leave a French-Canadian reader with French chrome around no Knowledge
 * Center at all, for want of a row that exists one step up the same chain the
 * rest of the page already walks. `localeFallbackChain` is that chain, shared
 * with the catalogue so the two cannot drift; a nearer locale's row wins.
 *
 * And when NOTHING in the set resolves, the English questions come back rather
 * than an empty list. Dropping is only ever the better answer while something
 * survives it: MarketingAeoSection renders nothing at all for an empty list, so
 * the last question dropped takes the heading and the FAQPage schema with it.
 * That is how an empty translation table read on the live site — French chrome
 * and no accordion, silently, on every page. English answers under a translated
 * heading are the smaller problem AND the visible one, which is the same
 * judgement the payload branch below already makes.
 */
export async function localizeAeoQuestions(
  questions: AeoQuestion[],
  locale: string,
): Promise<AeoQuestion[]> {
  if (questions.length === 0) return questions;
  if (locale.startsWith('en')) return questions;

  const ids = questions.map((q) => q.id).filter(Boolean);
  // Questions that came from a page payload carry no row id, so there is
  // nothing to join a translation to. Keep them rather than blanking the
  // section: an untranslatable answer is a smaller problem than a missing one.
  if (ids.length === 0) return questions;

  const chain = localeFallbackChain(locale);
  try {
    const { data, error } = await anonClient()
      .from('marketing_aeo_question_translations')
      .select('question_id, locale, question, answer')
      .in('locale', chain)
      .in('question_id', ids);
    if (error) {
      // A failed lookup must not blank the section: fall back to what we have.
      console.error('[marketing-aeo] translation read failed', error);
      return questions;
    }
    // Lower index = nearer relative, so fr-CA beats fr-FR for a fr-CA reader.
    const distance = new Map(chain.map((code, index) => [code, index]));
    const byId = new Map<string, { locale: string; question: string; answer: string }>();
    for (const row of data ?? []) {
      const nearer = byId.get(row.question_id);
      if (nearer && (distance.get(nearer.locale) ?? Infinity) <= (distance.get(row.locale) ?? Infinity)) continue;
      byId.set(row.question_id, row);
    }
    if (byId.size === 0) return questions;
    return questions.flatMap((q) => {
      const translated = byId.get(q.id);
      if (!translated) return [];
      return [{ ...q, question: translated.question, answer: translated.answer }];
    });
  } catch (error) {
    console.error('[marketing-aeo] translation read failed', error);
    return questions;
  }
}
