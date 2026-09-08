// scripts/translate-aeo-questions.mjs
//
// Fills marketing_aeo_question_translations so the Knowledge Center renders in
// the reader's language instead of English under a translated heading.
//
// The knowledge base is stored once, in English, because it is editorial
// content an admin maintains in /admin/marketing/aeo. Migration 0277 gives it a
// locale dimension; this populates it.
//
// Only the questions the public site can actually surface are translated by
// default — `readAeoQuestionsForPathCached` takes the six highest-clarity rows
// per path — so this does not machine-translate thousands of rows nobody reads.
// Raise it with --limit when you want deeper coverage.
//
//   node scripts/translate-aeo-questions.mjs --dry-run
//   node scripts/translate-aeo-questions.mjs --apply
//   node scripts/translate-aeo-questions.mjs --apply --locales es-ES,fr-FR --limit 200
//
// Idempotent and resumable: a (question, locale) that already has a row is
// skipped unless --overwrite is passed, and rows written here are marked
// source='machine' so a human review pass can be told apart and preserved.

import { readdirSync } from 'node:fs';
import nextEnv from '@next/env';
import { createClient } from '@supabase/supabase-js';

nextEnv.loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const model = process.env.AI_MODEL || 'gpt-4o-mini';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const apply = args.includes('--apply');
const overwrite = args.includes('--overwrite');
const limit = Number(flag('--limit') ?? 120);
const batchSize = Number(flag('--batch') ?? 10);

/** Every locale with a real catalogue, minus English (the source language). */
function targetLocales() {
  const requested = flag('--locales');
  if (requested) return requested.split(',').map((value) => value.trim()).filter(Boolean);
  return readdirSync('lib/i18n/messages')
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .filter((locale) => !locale.startsWith('en'));
}

if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
if (apply && !openaiKey) {
  console.error('OPENAI_API_KEY is required to translate. Run with --dry-run to see the plan.');
  process.exit(1);
}

const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const LANGUAGE = {
  'es-ES': 'European Spanish (Spain)',
  'es-MX': 'Mexican Spanish',
  'es-US': 'US Spanish',
  'fr-FR': 'French (France)',
  'fr-CA': 'Canadian French',
  'de-DE': 'German (Germany)',
  'it-IT': 'Italian (Italy)',
  'nl-NL': 'Dutch (Netherlands)',
  'pt-PT': 'European Portuguese (Portugal)',
};

/**
 * Translate a batch in one call. The model is asked for strict JSON keyed by the
 * row id so a reordered or partial answer cannot silently pair a translation
 * with the wrong question.
 */
async function translateBatch(rows, locale) {
  const language = LANGUAGE[locale] ?? locale;
  const payload = rows.map((row) => ({ id: row.id, question: row.question, answer: row.answer }));

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            `Translate product FAQ content into ${language}.`,
            'Keep the meaning exact and the tone plain and warm — this is customer-facing marketing copy.',
            'Do NOT translate the product name "Bubaly". Keep any URLs, paths and punctuation such as em dashes as they are.',
            'Return JSON: {"items":[{"id":"<same id>","question":"…","answer":"…"}]}.',
            'Return one item per input id, with no ids you were not given.',
          ].join(' '),
        },
        { role: 'user', content: JSON.stringify({ items: payload }) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`translation request failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('translation response was empty');

  const parsed = JSON.parse(content);
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const wanted = new Set(rows.map((row) => row.id));
  return items.filter(
    (item) =>
      item && wanted.has(item.id)
      && typeof item.question === 'string' && item.question.trim()
      && typeof item.answer === 'string' && item.answer.trim(),
  );
}

async function main() {
  const locales = targetLocales();

  // The rows the public site can surface: published, answered, best first.
  const { data: questions, error } = await db
    .from('marketing_aeo_questions')
    .select('id, question, answer')
    .eq('status', 'published')
    .not('answer', 'is', null)
    .order('clarity_score', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(`question read failed: ${error.message}`);

  const rows = (questions ?? []).filter((row) => row.answer?.trim());
  console.log(`${rows.length} published question(s); ${locales.length} target locale(s): ${locales.join(', ')}`);

  for (const locale of locales) {
    const { data: existing, error: existingError } = await db
      .from('marketing_aeo_question_translations')
      .select('question_id')
      .eq('locale', locale)
      .in('question_id', rows.map((row) => row.id));
    if (existingError) throw new Error(`translation read failed: ${existingError.message}`);

    const done = new Set((existing ?? []).map((row) => row.question_id));
    const todo = overwrite ? rows : rows.filter((row) => !done.has(row.id));
    if (todo.length === 0) {
      console.log(`  ${locale}: already complete`);
      continue;
    }
    if (!apply) {
      console.log(`  ${locale}: would translate ${todo.length} (${done.size} already present)`);
      continue;
    }

    let written = 0;
    for (let index = 0; index < todo.length; index += batchSize) {
      const batch = todo.slice(index, index + batchSize);
      let translated;
      try {
        translated = await translateBatch(batch, locale);
      } catch (batchError) {
        // One bad batch must not lose the batches already written.
        console.error(`  ${locale}: batch at ${index} failed — ${batchError.message}`);
        continue;
      }
      if (translated.length === 0) continue;

      const { error: writeError } = await db
        .from('marketing_aeo_question_translations')
        .upsert(
          translated.map((item) => ({
            question_id: item.id,
            locale,
            question: item.question.trim(),
            answer: item.answer.trim(),
            source: 'machine',
          })),
          { onConflict: 'question_id,locale' },
        );
      if (writeError) throw new Error(`translation write failed: ${writeError.message}`);
      written += translated.length;
      process.stdout.write(`\r  ${locale}: ${written}/${todo.length}`);
    }
    process.stdout.write('\n');
  }

  if (!apply) console.log('\nDry run. Re-run with --apply to write translations.');
}

await main();
