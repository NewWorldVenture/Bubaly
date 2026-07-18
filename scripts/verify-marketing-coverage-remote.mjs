import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}` };
const failures = [];

async function getRows(resource, label) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const separator = resource.includes('?') ? '&' : '?';
    const response = await fetch(`${url}/rest/v1/${resource}${separator}limit=1000&offset=${offset}`, { headers });
    if (!response.ok) throw new Error(`${label} query failed (HTTP ${response.status}).`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function usableQuestions(value) {
  const questions = record(value).questions;
  return Array.isArray(questions) && questions.length >= 3 && questions.every((item) => text(record(item).question) && text(record(item).answer));
}

try {
  const [pages, seoRows, aeoRows] = await Promise.all([
    getRows('marketing_pages?select=id,path,title,summary,seo,aeo,status&deleted_at=is.null', 'marketing_pages'),
    getRows('marketing_seo_pages?select=id,path,title,meta_description,status&status=eq.active', 'marketing_seo_pages'),
    getRows('marketing_aeo_questions?select=id,question,answer,source_path,status,metadata&status=eq.published', 'marketing_aeo_questions'),
  ]);
  const published = pages.filter((page) => page.status === 'published');
  for (const page of published) {
    const seo = record(page.seo);
    if (!text(seo.title) || !text(seo.description) || seo.canonical !== page.path) failures.push(`published page ${page.path} has incomplete canonical SEO`);
    if (!usableQuestions(page.aeo)) failures.push(`published page ${page.path} has incomplete canonical AEO`);
  }
  for (const row of seoRows) {
    if (!text(row.title) || !text(row.meta_description)) failures.push(`active SEO row ${row.path} has incomplete metadata`);
  }
  for (const row of aeoRows) {
    const source = String(row.source_path ?? '');
    if (!source.startsWith('/') || !text(row.question) || !text(row.answer) || /^question \d+$/i.test(row.question.trim())) {
      failures.push(`published AEO row ${row.id} is not citable`);
    }
  }
  const coveragePaths = new Set(aeoRows.filter((row) => record(row.metadata).source === 'marketing_platform').map((row) => row.source_path));
  for (const page of published) if (!coveragePaths.has(page.path)) failures.push(`published page ${page.path} has no registered public AEO row`);
  if (failures.length) {
    console.error(`Marketing coverage verification failed: ${failures.length} issue${failures.length === 1 ? '' : 's'}.`);
    for (const failure of failures.slice(0, 100)) console.error(`- ${failure}`);
    if (failures.length > 100) console.error(`- ...and ${failures.length - 100} more.`);
    process.exit(1);
  }
  console.log(`Marketing coverage verification passed: ${published.length} published pages, ${seoRows.length} active SEO rows, and ${aeoRows.length} published AEO rows.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
