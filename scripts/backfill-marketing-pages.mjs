import nextEnv from '@next/env';
import { createClient } from '@supabase/supabase-js';

nextEnv.loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const apply = process.argv.includes('--apply');
const PAGE_BATCH_SIZE = 100;
const READ_PAGE_SIZE = 1000;

if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function readAll(table, select, configure = () => {}) {
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

function slugFromPath(path) {
  const value = path.replace(/^\/+|\/+$/g, '').split('/').pop() || 'page';
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'page';
}

function humanize(value) {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function textFromJson(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(textFromJson).filter(Boolean).join('\n\n');
  if (value && typeof value === 'object') {
    const record = value;
    for (const key of ['text', 'content', 'body', 'children']) {
      const text = textFromJson(record[key]);
      if (text) return text;
    }
  }
  return '';
}

function pageFromBlog(post) {
  const summary = post.excerpt?.trim() || `Read ${post.title} in the Bubaly family knowledge center.`;
  const body = textFromJson(post.body) || summary;
  return {
    page_type: 'blog',
    slug: post.slug,
    path: `/blog/${post.slug}`,
    title: post.title,
    summary,
    body,
    content: {
      source: 'blog_posts',
      source_id: post.id,
      category: post.category,
      tags: post.tags ?? [],
      blocks: post.body ?? [],
    },
    seo: {
      title: post.title,
      description: summary.slice(0, 160),
      keywords: post.tags ?? [],
      canonical: `/blog/${post.slug}`,
    },
    aeo: {},
    status: post.published ? 'published' : 'draft',
    published_at: post.published ? post.published_at : null,
    deleted_at: null,
  };
}

function pageFromLanding(page) {
  const path = `/lp/${page.slug}`;
  const title = page.headline || page.title;
  const summary = page.subhead?.trim() || page.title;
  return {
    page_type: 'landing',
    slug: page.slug,
    path,
    title,
    summary,
    body: page.body || summary,
    content: { source: 'marketing_landing_pages', source_id: page.id, metadata: page.metadata ?? {} },
    seo: { title, description: summary.slice(0, 160), keywords: [], canonical: path },
    aeo: {},
    status: page.published && page.status !== 'archived' ? 'published' : page.status === 'archived' ? 'archived' : 'draft',
    published_at: page.published ? page.updated_at : null,
    deleted_at: page.deleted_at ?? null,
  };
}

function pageTypeForPath(path) {
  const prefix = path.split('/')[1];
  return ['questions', 'guides', 'compare', 'alternatives', 'audiences', 'resources', 'glossary', 'features', 'blog'].includes(prefix)
    ? ({ questions: 'question', guides: 'guide', compare: 'comparison', alternatives: 'alternative', audiences: 'audience', resources: 'resource', glossary: 'glossary', features: 'feature', blog: 'blog' }[prefix])
    : 'custom';
}

function pageFromSeo(page) {
  const slug = slugFromPath(page.path);
  const title = page.title?.trim() || humanize(slug);
  const summary = page.meta_description?.trim() || `Explore ${title} with Bubaly, the AI family operating system.`;
  return {
    page_type: pageTypeForPath(page.path),
    slug,
    path: page.path,
    title,
    summary,
    body: summary,
    content: { source: 'marketing_seo_pages', source_id: page.id, metadata: page.metadata ?? {} },
    seo: { title, description: summary.slice(0, 160), keywords: [], canonical: page.path },
    aeo: {},
    status: page.status === 'active' ? 'published' : 'draft',
    published_at: page.status === 'active' ? page.updated_at : null,
    deleted_at: null,
  };
}

const [existing, blogs, landings, seoPages] = await Promise.all([
  readAll('marketing_pages', 'path'),
  readAll('blog_posts', 'id,slug,title,excerpt,category,tags,body,published,published_at'),
  readAll('marketing_landing_pages', 'id,slug,title,headline,subhead,body,status,published,metadata,deleted_at,updated_at', (query) => query.is('deleted_at', null)),
  readAll('marketing_seo_pages', 'id,path,title,meta_description,status,metadata,updated_at', (query) => query.eq('status', 'active')),
]);

const existingPaths = new Set(existing.map((page) => page.path));
const candidates = [
  ...blogs.map(pageFromBlog),
  ...landings.map(pageFromLanding),
  ...seoPages.map(pageFromSeo),
];
const unique = [];
const seen = new Set(existingPaths);
for (const page of candidates) {
  if (!page.path || seen.has(page.path)) continue;
  seen.add(page.path);
  unique.push(page);
}

console.log(`Marketing page backfill: ${blogs.length} blogs, ${landings.length} landings, ${seoPages.length} active SEO pages read.`);
console.log(`Marketing page backfill: ${unique.length} canonical pages are missing.`);
if (!apply) {
  console.log('Dry run only. Re-run with --apply to insert missing canonical pages.');
  process.exit(0);
}

for (let offset = 0; offset < unique.length; offset += PAGE_BATCH_SIZE) {
  const batch = unique.slice(offset, offset + PAGE_BATCH_SIZE);
  const { error } = await db.from('marketing_pages').upsert(batch, { onConflict: 'path', ignoreDuplicates: true });
  if (error) throw new Error(`marketing_pages batch ${offset}-${offset + batch.length} failed: ${error.message}`);
  console.log(`Inserted canonical page batch ${offset + 1}-${offset + batch.length}.`);
}

console.log(`Marketing page backfill applied: ${unique.length} missing canonical pages inserted.`);
