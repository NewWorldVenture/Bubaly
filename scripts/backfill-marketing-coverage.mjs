import nextEnv from '@next/env';
import { createClient } from '@supabase/supabase-js';

nextEnv.loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const apply = process.argv.includes('--apply');
const READ_PAGE_SIZE = 1000;
const WRITE_BATCH_SIZE = 100;

if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function readAll(table, select, configure = (query) => query) {
  const rows = [];
  for (let offset = 0; ; offset += READ_PAGE_SIZE) {
    let query = db.from(table).select(select).range(offset, offset + READ_PAGE_SIZE - 1);
    query = configure(query) ?? query;
    const { data, error } = await query;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < READ_PAGE_SIZE) return rows;
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function humanize(value) {
  return value.replace(/^\/+|\/+$/g, '').split('/').pop()?.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Bubaly';
}

function buildSeo(page) {
  const current = record(page.seo);
  const title = text(current.title, `${text(page.title, humanize(page.path))} | Bubaly`);
  const description = text(current.description, text(page.summary, `Explore ${text(page.title, humanize(page.path))} with Bubaly, the AI family operating system.`).slice(0, 160));
  return { title, description: description.slice(0, 160), keywords: Array.isArray(current.keywords) ? current.keywords.map(String).filter(Boolean).slice(0, 30) : [text(page.title, humanize(page.path)).toLowerCase(), 'Bubaly'], canonical: page.path };
}

function buildQuestions(page) {
  const title = text(page.title, humanize(page.path));
  const summary = text(page.summary, `Explore ${title} with Bubaly, the AI family operating system.`);
  return [
    { question: `What is ${title}?`, answer: summary },
    { question: `How does ${title} work with Bubaly?`, answer: `${title} is part of Bubaly, the AI family operating system that keeps family information, routines, and next steps connected in one shared place.` },
    { question: `Who is ${title} for?`, answer: `It is for families who want a clear, private, and practical way to organize ${title.toLowerCase()} alongside the rest of family life.` },
  ].map((row) => ({ ...row, source_path: page.path }));
}

function isUsableAeo(value) {
  const questions = record(value).questions;
  return Array.isArray(questions) && questions.length >= 3 && questions.every((item) => text(record(item).question) && text(record(item).answer));
}

function isPlaceholderAeo(row) {
  const metadata = record(row.metadata);
  return !String(row.source_path ?? '').startsWith('/')
    || /^question \d+$/i.test(String(row.question ?? '').trim())
    || metadata.seed === 'sample';
}

const [pages, seoRows, aeoRows] = await Promise.all([
  readAll('marketing_pages', 'id,path,page_type,title,summary,seo,aeo,status', (query) => query.is('deleted_at', null)),
  readAll('marketing_seo_pages', 'id,path,title,meta_description,status,metadata', (query) => query.eq('status', 'active')),
  readAll('marketing_aeo_questions', 'id,question,answer,source_path,status,metadata', (query) => query.eq('status', 'published')),
]);

const canonicalByPath = new Map(pages.map((page) => [page.path, page]));
const pageUpdates = [];
for (const page of pages) {
  const seo = buildSeo(page);
  const aeo = isUsableAeo(page.aeo) ? page.aeo : { questions: buildQuestions(page) };
  const currentSeo = record(page.seo);
  const seoComplete = text(currentSeo.title) && text(currentSeo.description) && currentSeo.canonical === page.path;
  if (!seoComplete || !isUsableAeo(page.aeo)) {
    pageUpdates.push({ id: page.id, path: page.path, seo, aeo });
  }
}

const seoUpdates = [];
for (const row of seoRows) {
  const page = canonicalByPath.get(row.path);
  const fallbackTitle = page ? text(page.title, humanize(row.path)) : humanize(row.path);
  const fallbackDescription = page
    ? text(page.summary, `Explore ${fallbackTitle} with Bubaly, the AI family operating system.`)
    : `Explore ${fallbackTitle} with Bubaly, the AI family operating system.`;
  const title = text(row.title, fallbackTitle);
  const description = text(row.meta_description, fallbackDescription).slice(0, 160);
  if (title !== row.title || description !== row.meta_description) {
    seoUpdates.push({ id: row.id, path: row.path, title, meta_description: description, metadata: { ...record(row.metadata), source: 'marketing_coverage' } });
  }
}

const publishedPages = pages.filter((page) => page.status === 'published');
const existingCoveragePaths = new Set(
  aeoRows.filter((row) => !isPlaceholderAeo(row) && record(row.metadata).source === 'marketing_platform').map((row) => row.source_path),
);
const missingCoveragePages = publishedPages.filter((page) => !existingCoveragePaths.has(page.path));
const placeholderAeoIds = aeoRows.filter(isPlaceholderAeo).map((row) => row.id);

console.log(`Marketing coverage: ${pages.length} canonical pages read (${publishedPages.length} published).`);
console.log(`Marketing coverage: ${pageUpdates.length} canonical SEO/AEO payloads need repair.`);
console.log(`Marketing coverage: ${seoUpdates.length} legacy SEO rows need repair; ${placeholderAeoIds.length} placeholder AEO rows need removal.`);
console.log(`Marketing coverage: ${missingCoveragePages.length} published pages need citable AEO registration.`);
if (!apply) {
  console.log('Dry run only. Re-run with --apply to persist the coverage reconciliation.');
  process.exit(0);
}

for (let offset = 0; offset < pageUpdates.length; offset += WRITE_BATCH_SIZE) {
  const batch = pageUpdates.slice(offset, offset + WRITE_BATCH_SIZE);
  await Promise.all(batch.map(async ({ id, path, seo, aeo }) => {
    const { error } = await db.from('marketing_pages').update({ seo, aeo, updated_by: null }).eq('id', id);
    if (error) throw new Error(`${path}: canonical coverage update failed: ${error.message}`);
  }));
}

for (let offset = 0; offset < seoUpdates.length; offset += WRITE_BATCH_SIZE) {
  const batch = seoUpdates.slice(offset, offset + WRITE_BATCH_SIZE);
  await Promise.all(batch.map(async ({ id, path, title, meta_description, metadata }) => {
    const { error } = await db.from('marketing_seo_pages').update({ title, meta_description, metadata }).eq('id', id);
    if (error) throw new Error(`${path}: legacy SEO update failed: ${error.message}`);
  }));
}

for (let offset = 0; offset < placeholderAeoIds.length; offset += WRITE_BATCH_SIZE) {
  const ids = placeholderAeoIds.slice(offset, offset + WRITE_BATCH_SIZE);
  const { error } = await db.from('marketing_aeo_questions').delete().in('id', ids);
  if (error) throw new Error(`placeholder AEO cleanup failed: ${error.message}`);
}

const coverageRows = missingCoveragePages.flatMap((page) => buildQuestions(page).map((row) => ({
  ...row,
  entity: page.title,
  pattern: 'faq',
  status: 'published',
  clarity_score: 85,
  last_reviewed: new Date().toISOString(),
  metadata: { source: 'marketing_platform', page_id: page.id },
})));
for (let offset = 0; offset < coverageRows.length; offset += WRITE_BATCH_SIZE) {
  const batch = coverageRows.slice(offset, offset + WRITE_BATCH_SIZE);
  const { error } = await db.from('marketing_aeo_questions').insert(batch);
  if (error) throw new Error(`AEO coverage insert ${offset}-${offset + batch.length} failed: ${error.message}`);
}

console.log(`Marketing coverage applied: ${pageUpdates.length} canonical pages, ${seoUpdates.length} legacy SEO rows, ${placeholderAeoIds.length} placeholder AEO rows removed, ${coverageRows.length} AEO answers registered.`);
