import 'server-only';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json, Tables } from '@/lib/database.types';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { getAIConfig } from '@/lib/ai/settings';
import { fetchExternal } from '@/lib/server/external-fetch';
import { readBoundedResponseJson } from '@/lib/server/bounded-response-body';
import { syncMarketingProviders } from './provider-sync';

export type MarketingPlatformDb = SupabaseClient<Database>;
export type MarketingPage = Tables<'marketing_pages'>;
export type MarketingPageType =
  | 'landing' | 'question' | 'guide' | 'comparison' | 'alternative'
  | 'audience' | 'resource' | 'glossary' | 'feature' | 'blog' | 'custom';

export const PAGE_TYPES: { value: MarketingPageType; label: string; prefix: string }[] = [
  { value: 'landing', label: 'Landing page', prefix: '/lp' },
  { value: 'question', label: 'Question', prefix: '/questions' },
  { value: 'guide', label: 'Guide', prefix: '/guides' },
  { value: 'comparison', label: 'Comparison', prefix: '/compare' },
  { value: 'alternative', label: 'Alternative', prefix: '/alternatives' },
  { value: 'audience', label: 'Audience', prefix: '/audiences' },
  { value: 'resource', label: 'Resource', prefix: '/resources' },
  { value: 'glossary', label: 'Glossary', prefix: '/glossary' },
  { value: 'feature', label: 'Feature', prefix: '/features' },
  { value: 'blog', label: 'Blog', prefix: '/blog' },
  { value: 'custom', label: 'Custom', prefix: '/p' },
];

const PAGE_TYPE_SET = new Set<string>(PAGE_TYPES.map((item) => item.value));

export function isMarketingPageType(value: string): value is MarketingPageType {
  return PAGE_TYPE_SET.has(value);
}

export function pageTypeConfig(type: string): (typeof PAGE_TYPES)[number] {
  return PAGE_TYPES.find((item) => item.value === type) ?? PAGE_TYPES[PAGE_TYPES.length - 1];
}

export function normalizeMarketingSlug(value: string): string {
  return value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function buildMarketingPagePath(type: MarketingPageType, slug: string): string {
  const normalized = normalizeMarketingSlug(slug);
  if (!normalized) throw new Error('A page slug is required.');
  return `${pageTypeConfig(type).prefix}/${normalized}`;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeJson(value: unknown): Json {
  return (value ?? {}) as Json;
}

function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Split long page material into stable, slightly-overlapping retrieval chunks. */
export function chunkMarketingText(value: string, maxChars = 6_000, overlap = 400): string[] {
  const source = value.trim();
  if (!source) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < source.length) {
    const hardEnd = Math.min(source.length, start + maxChars);
    let end = hardEnd;
    if (hardEnd < source.length) {
      const boundary = source.lastIndexOf(' ', hardEnd);
      if (boundary > start + Math.floor(maxChars * 0.6)) end = boundary;
    }
    const chunk = source.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= source.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export type GeneratedMarketingPage = {
  title: string;
  summary: string;
  body: string;
  content: Record<string, unknown>;
  seo: { title: string; description: string; keywords: string[]; canonical: string };
  aeo: { questions: { question: string; answer: string; source_path: string }[] };
};

/** A deterministic, honest fallback. It keeps publishing usable when the AI
 * provider is unavailable and never fabricates rankings, testimonials, or proof. */
export function buildDeterministicMarketingPage(page: Pick<MarketingPage, 'page_type' | 'path' | 'title' | 'summary' | 'body'>): GeneratedMarketingPage {
  const title = text(page.title, 'Bubaly');
  const summary = text(page.summary, `Explore ${title} with Bubaly, the AI family operating system.`);
  const body = text(page.body, `${summary}\n\nBubaly brings the family calendar, tasks, meals, school, health, documents, and helpful AI actions into one shared place. Start with the details that matter most to your household and build from there.`);
  const questions = [
    `What is ${title}?`,
    `How does ${title} work with Bubaly?`,
    `Who is ${title} for?`,
  ].map((question) => ({ question, answer: summary, source_path: page.path }));
  return {
    title,
    summary,
    body,
    content: { sections: [{ type: 'prose', body }], generated: false },
    seo: {
      title: `${title} | Bubaly`,
      description: summary.slice(0, 160),
      keywords: [title.toLowerCase(), 'family organization', 'Bubaly'],
      canonical: page.path,
    },
    aeo: { questions },
  };
}

function parseModelJson(raw: string): Record<string, unknown> | null {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeGeneratedPage(page: Pick<MarketingPage, 'page_type' | 'path' | 'title' | 'summary' | 'body'>, candidate: Record<string, unknown>): GeneratedMarketingPage {
  const fallback = buildDeterministicMarketingPage(page);
  const seo = jsonObject(candidate.seo);
  const aeo = jsonObject(candidate.aeo);
  const rawQuestions = Array.isArray(aeo.questions) ? aeo.questions : fallback.aeo.questions;
  const questions = rawQuestions.slice(0, 12).map((item) => {
    const row = jsonObject(item);
    return {
      question: text(row.question, fallback.aeo.questions[0].question),
      answer: text(row.answer, fallback.summary),
      source_path: page.path,
    };
  });
  return {
    title: text(candidate.title, fallback.title),
    summary: text(candidate.summary, fallback.summary).slice(0, 400),
    body: text(candidate.body, fallback.body),
    content: jsonObject(candidate.content),
    seo: {
      title: text(seo.title, fallback.seo.title),
      description: text(seo.description, fallback.seo.description).slice(0, 160),
      keywords: Array.isArray(seo.keywords) ? seo.keywords.map(String).filter(Boolean).slice(0, 30) : fallback.seo.keywords,
      canonical: page.path,
    },
    aeo: { questions: questions.length ? questions : fallback.aeo.questions },
  };
}

async function generateWithAI(
  page: Pick<MarketingPage, 'page_type' | 'path' | 'title' | 'summary' | 'body'>,
  template: { instructions?: string | null; defaults?: Json } | null,
  rules: { name: string; instructions: string; value: Json }[],
): Promise<GeneratedMarketingPage | null> {
  if (!(await isAIConfigured())) return null;
  const provider = await resolveProvider();
  const ruleText = rules.map((rule) => `${rule.name}: ${rule.instructions}\n${JSON.stringify(rule.value)}`).join('\n\n');
  const prompt = [
    `Generate a production-ready ${page.page_type} marketing page for Bubaly.`,
    `Path: ${page.path}`,
    `Current title: ${page.title}`,
    `Current summary: ${page.summary ?? ''}`,
    `Current body: ${(page.body ?? '').slice(0, 8000)}`,
    `Template instructions: ${template?.instructions ?? 'Use clear, specific, accessible copy.'}`,
    `Template defaults: ${JSON.stringify(template?.defaults ?? {})}`,
    `Brand rules:\n${ruleText || 'Use a warm, precise, trustworthy voice.'}`,
    'Return JSON only with keys title, summary, body, content, seo, aeo.',
    'seo must contain title, description, keywords, canonical. aeo.questions must be an array of question and answer objects.',
    'Never invent rankings, citations, testimonials, customer counts, guarantees, or provider results.',
  ].join('\n\n');
  const completion = await provider.complete({
    system: 'You are the content operations engine for Bubaly. Produce useful, factual, accessible marketing content. Return valid JSON only.',
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    maxTokens: 2400,
  });
  const parsed = parseModelJson(completion.text);
  return parsed ? normalizeGeneratedPage(page, parsed) : null;
}

export async function enqueueMarketingGenerationJob(
  supabase: MarketingPlatformDb,
  input: {
    jobType: string;
    targetType?: string;
    targetId?: string | null;
    targetPath?: string | null;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
    priority?: number;
    createdBy?: string | null;
  },
): Promise<{ id: string | null; created: boolean }> {
  const { data, error } = await supabase.from('marketing_generation_jobs').insert({
    job_type: input.jobType,
    target_type: input.targetType ?? 'marketing_page',
    target_id: input.targetId ?? null,
    target_path: input.targetPath ?? null,
    idempotency_key: input.idempotencyKey,
    payload: safeJson(input.payload ?? {}),
    priority: input.priority ?? 50,
    created_by: input.createdBy ?? null,
  }).select('id').maybeSingle();
  if (!error) return { id: data?.id ?? null, created: true };
  if (error.code === '23505') {
    const existing = await supabase.from('marketing_generation_jobs').select('id').eq('idempotency_key', input.idempotencyKey).maybeSingle();
    if (existing.error) throw existing.error;
    return { id: existing.data?.id ?? null, created: false };
  }
  throw error;
}

async function finishJob(supabase: MarketingPlatformDb, job: Tables<'marketing_generation_jobs'>, result: Record<string, unknown>) {
  const { data, error } = await supabase.from('marketing_generation_jobs').update({
    status: 'succeeded', completed_at: new Date().toISOString(), locked_at: null, result: safeJson(result), error: null,
  }).eq('id', job.id).eq('status', 'running').select('id').maybeSingle();
  if (error || !data) throw error ?? new Error(`Could not persist success for marketing job ${job.id}.`);
}

async function failJob(supabase: MarketingPlatformDb, job: Tables<'marketing_generation_jobs'>, error: unknown) {
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  const terminal = job.attempts >= job.max_attempts;
  const { data, error: updateError } = await supabase.from('marketing_generation_jobs').update({
    status: terminal ? 'dead_letter' : 'queued',
    run_after: new Date(Date.now() + Math.min(60 * 60_000, 2 ** job.attempts * 30_000)).toISOString(),
    locked_at: null,
    error: message,
  }).eq('id', job.id).eq('status', 'running').select('id').maybeSingle();
  if (updateError || !data) throw updateError ?? new Error(`Could not persist failure for marketing job ${job.id}.`);
}

async function runRegeneration(supabase: MarketingPlatformDb, job: Tables<'marketing_generation_jobs'>) {
  if (!job.target_id) throw new Error('Regeneration job is missing target_id.');
  const { data: page, error: pageError } = await supabase.from('marketing_pages').select('*').eq('id', job.target_id).is('deleted_at', null).maybeSingle();
  if (pageError || !page) throw pageError ?? new Error('Marketing page not found.');
  const [templateResult, rulesResult] = await Promise.all([
    supabase.from('marketing_content_templates').select('instructions, defaults').eq('page_type', page.page_type).eq('status', 'active').eq('is_default', true).maybeSingle(),
    supabase.from('marketing_brand_rules').select('name, instructions, value').eq('active', true).order('name'),
  ]);
  if (templateResult.error) throw templateResult.error;
  if (rulesResult.error) throw rulesResult.error;
  const template = templateResult.data;
  const rules = rulesResult.data;
  let generated = buildDeterministicMarketingPage(page);
  let source: 'ai' | 'system' = 'system';
  try {
    const ai = await generateWithAI(page, template, rules ?? []);
    if (ai) { generated = ai; source = 'ai'; }
  } catch (error) {
    console.error('[marketing-platform] AI generation degraded to deterministic content', error);
  }
  const { error: updateError } = await supabase.from('marketing_pages').update({
    title: generated.title,
    summary: generated.summary,
    body: generated.body,
    content: safeJson(generated.content),
    seo: safeJson(generated.seo),
    aeo: safeJson(generated.aeo),
    updated_by: null,
  }).eq('id', page.id);
  if (updateError) throw updateError;
  const { error: versionError } = await supabase.from('marketing_page_versions').upsert({
    page_id: page.id,
    version: page.version,
    title: generated.title,
    summary: generated.summary,
    body: generated.body,
    content: safeJson(generated.content),
    seo: safeJson(generated.seo),
    aeo: safeJson(generated.aeo),
    change_source: source,
    change_note: `Automatic regeneration for version ${page.version}`,
  }, { onConflict: 'page_id,version' });
  if (versionError) throw versionError;
  await enqueueMarketingGenerationJob(supabase, {
    jobType: 'generate_questions', targetType: 'marketing_page', targetId: page.id, targetPath: page.path,
    idempotencyKey: `marketing-page:${page.id}:v:${page.version}:questions`, payload: { page_id: page.id, version: page.version }, priority: 65,
  });
  await enqueueMarketingGenerationJob(supabase, {
    jobType: 'embed_page', targetType: 'marketing_page', targetId: page.id, targetPath: page.path,
    idempotencyKey: `marketing-page:${page.id}:v:${page.version}:embedding`, payload: { page_id: page.id, version: page.version }, priority: 40,
  });
  return { pageId: page.id, version: page.version, source };
}

async function runQuestions(supabase: MarketingPlatformDb, job: Tables<'marketing_generation_jobs'>) {
  if (!job.target_id) throw new Error('Question job is missing target_id.');
  const { data: page, error } = await supabase.from('marketing_pages').select('id, path, title, summary, aeo, status').eq('id', job.target_id).is('deleted_at', null).maybeSingle();
  if (error || !page) throw error ?? new Error('Marketing page not found.');
  const aeo = jsonObject(page.aeo);
  const raw = Array.isArray(aeo.questions) ? aeo.questions : [];
  const questions = raw.slice(0, 12).map((item) => {
    const row = jsonObject(item);
    return { question: text(row.question, `What is ${page.title}?`), answer: text(row.answer, page.summary ?? `Learn about ${page.title}.`) };
  });
  const rows = questions.map((row) => ({
    question: row.question, answer: row.answer, entity: page.title, source_path: page.path,
    pattern: 'faq', status: page.status === 'published' ? 'published' : 'answered',
    clarity_score: 85, last_reviewed: new Date().toISOString(), metadata: safeJson({ source: 'marketing_platform', page_id: page.id }),
  }));
  const { error: deleteError } = await supabase.from('marketing_aeo_questions').delete().eq('source_path', page.path).contains('metadata', { source: 'marketing_platform' });
  if (deleteError) throw deleteError;
  if (rows.length) {
    const { error: insertError } = await supabase.from('marketing_aeo_questions').insert(rows);
    if (insertError) throw insertError;
  }
  return { pageId: page.id, questions: rows.length };
}

async function openAIEmbeddings(textInputs: string[], configuredKey?: string | null): Promise<{ vectors: number[][]; model: string }> {
  const apiKey = configuredKey ?? process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) throw new Error('Embedding provider is not configured. Set OPENAI_API_KEY.');
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  const response = await fetchExternal('https://api.openai.com/v1/embeddings', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: textInputs.map((input) => input.slice(0, 6_000)) }),
  }, 60_000);
  if (!response.ok) throw new Error(`Embedding provider returned ${response.status}.`);
  const data = await readBoundedResponseJson<{ data?: { index?: number; embedding?: number[] }[] }>(response, 8 * 1024 * 1024);
  const ordered = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (ordered.length !== textInputs.length) throw new Error('Embedding provider returned an incomplete batch.');
  const vectors = ordered.map((item) => item.embedding);
  if (vectors.some((vector) => !vector?.length)) throw new Error('Embedding provider returned an empty vector.');
  const validVectors = vectors as number[][];
  if (validVectors.some((vector) => vector.length !== 1536)) throw new Error('Embedding dimensions do not match the configured 1536-dimension index.');
  return { vectors: validVectors, model };
}

async function runEmbedding(supabase: MarketingPlatformDb, job: Tables<'marketing_generation_jobs'>) {
  if (!job.target_id) throw new Error('Embedding job is missing target_id.');
  const { data: page, error } = await supabase.from('marketing_pages').select('id, title, summary, body, version').eq('id', job.target_id).is('deleted_at', null).maybeSingle();
  if (error || !page) throw error ?? new Error('Marketing page not found.');
  const source = [page.title, page.summary ?? '', page.body ?? ''].filter(Boolean).join('\n\n');
  const chunks = chunkMarketingText(source);
  if (!chunks.length) throw new Error('Marketing page has no embeddable content.');
  const hashes = chunks.map(contentHash);
  const { data: existingRows, error: existingError } = await supabase.from('marketing_embeddings')
    .select('id, chunk_index, content_hash').eq('source_type', 'page').eq('source_id', page.id);
  if (existingError) throw existingError;
  const currentHashes = new Set(hashes);
  const reusable = new Set((existingRows ?? []).filter((row) => currentHashes.has(row.content_hash)).map((row) => row.content_hash));
  const missing = chunks.map((content, index) => ({ content, index, hash: hashes[index] })).filter((row) => !reusable.has(row.hash));
  const staleIds = (existingRows ?? []).filter((row) => !currentHashes.has(row.content_hash)).map((row) => row.id);
  if (staleIds.length) {
    const { error: staleError } = await supabase.from('marketing_embeddings').update({ status: 'stale' }).in('id', staleIds);
    if (staleError) throw staleError;
  }
  if (!missing.length) return { pageId: page.id, chunks: chunks.length, embedded: 0, reused: reusable.size };
  const aiConfig = await getAIConfig(supabase);
  let embedded = 0;
  for (let offset = 0; offset < missing.length; offset += 32) {
    const batch = missing.slice(offset, offset + 32);
    const { vectors, model } = await openAIEmbeddings(batch.map((row) => row.content), aiConfig.openaiKey);
    const { error: insertError } = await supabase.from('marketing_embeddings').insert(batch.map((row, index) => ({
      source_type: 'page', source_id: page.id, chunk_index: row.index, content_hash: row.hash, content: row.content,
      embedding: JSON.stringify(vectors[index]) as unknown as Json, model, dimensions: vectors[index].length, status: 'ready',
    })));
    if (insertError) throw insertError;
    embedded += batch.length;
  }
  return { pageId: page.id, chunks: chunks.length, embedded, reused: reusable.size };
}

async function runJob(supabase: MarketingPlatformDb, job: Tables<'marketing_generation_jobs'>) {
  switch (job.job_type) {
    case 'regenerate_page': return runRegeneration(supabase, job);
    case 'generate_questions': return runQuestions(supabase, job);
    case 'embed_page': return runEmbedding(supabase, job);
    case 'generate_metadata': return runRegeneration(supabase, job);
    case 'sitemap_sync':
      revalidatePath('/sitemap.xml');
      return { synced: true, path: '/sitemap.xml' };
    case 'refresh_provider_data':
      return { refreshed: true, results: await syncMarketingProviders(supabase) };
    default: throw new Error(`Unsupported marketing job type: ${job.job_type}`);
  }
}

export async function processMarketingGenerationJobs(supabase: MarketingPlatformDb, limit = 10) {
  const { data: jobs, error } = await supabase.rpc('claim_marketing_generation_jobs', { p_limit: limit });
  if (error) throw error;
  const summary = { claimed: jobs?.length ?? 0, succeeded: 0, failed: 0, deadLettered: 0, persistenceFailed: 0 };
  for (const job of jobs ?? []) {
    try {
      const result = await runJob(supabase, job);
      await finishJob(supabase, job, result as Record<string, unknown>);
      summary.succeeded++;
    } catch (error) {
      summary.failed++;
      if (job.attempts >= job.max_attempts) summary.deadLettered++;
      try {
        await failJob(supabase, job, error);
      } catch (persistenceError) {
        summary.persistenceFailed++;
        console.error(`[marketing-platform] job ${job.id} failure state could not be persisted`, persistenceError);
      }
      console.error(`[marketing-platform] job ${job.id} failed`, error);
    }
  }
  if (summary.persistenceFailed > 0) throw new Error(`Could not persist ${summary.persistenceFailed} marketing job failure state${summary.persistenceFailed === 1 ? '' : 's'}.`);
  return summary;
}
