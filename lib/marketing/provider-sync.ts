import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { fetchExternal } from '@/lib/server/external-fetch';
import { readBoundedResponseJson } from '@/lib/server/bounded-response-body';

type Db = SupabaseClient<Database>;
type Provider = 'google_search_console' | 'bing_webmaster' | 'ai_citation';

type Observation = {
  provider: Provider;
  engine: string;
  observed_for: string;
  page_path: string;
  query: string;
  clicks?: number;
  impressions?: number;
  ctr?: number | null;
  average_position?: number | null;
  citations?: number;
  cited?: boolean | null;
  payload?: Json;
  source_status: 'observed' | 'unavailable' | 'partial' | 'manual';
};

function isoDate(date = new Date()): string { return date.toISOString().slice(0, 10); }

function siteUrl(): string {
  const value = process.env.NEXT_PUBLIC_SITE_URL;
  if (!value) throw new Error('NEXT_PUBLIC_SITE_URL is not configured.');
  return value.replace(/\/$/, '');
}

function tokenForGoogle(): string | null {
  const direct = process.env.GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN?.trim();
  if (direct) return direct;
  const legacy = process.env.GOOGLE_SEARCH_CONSOLE_KEY?.trim();
  return legacy?.startsWith('ya29.') ? legacy : null;
}

async function writeSyncState(db: Db, provider: Provider, state: { status: string; error?: string | null; rows?: number; started?: string; completed?: string }) {
  await db.from('marketing_provider_syncs').upsert({
    provider,
    status: state.status,
    last_started_at: state.started ?? null,
    last_completed_at: state.completed ?? null,
    last_error: state.error ?? null,
    rows_imported: state.rows ?? 0,
    metadata: { source: 'marketing-provider-sync' },
  });
}

async function writeObservations(db: Db, rows: Observation[]): Promise<number> {
  if (!rows.length) return 0;
  const { error } = await db.from('marketing_provider_observations').upsert(rows, { onConflict: 'provider,engine,observed_for,page_path,query' });
  if (error) throw error;
  return rows.length;
}

async function syncGoogle(db: Db): Promise<number> {
  const started = new Date().toISOString();
  const token = tokenForGoogle();
  if (!token) {
    await writeSyncState(db, 'google_search_console', { status: 'not_configured', error: 'Set GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN for Search Console API access.', started });
    return 0;
  }
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const property = encodeURIComponent(siteUrl());
    const response = await fetchExternal(`https://searchconsole.googleapis.com/webmasters/v3/sites/${property}/searchAnalytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: isoDate(start), endDate: isoDate(end), dimensions: ['page', 'query'], rowLimit: 25_000 }),
    }, 60_000);
    if (!response.ok) throw new Error(`Google Search Console returned ${response.status}.`);
    const data = await readBoundedResponseJson<{ rows?: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }[] }>(response, 4 * 1024 * 1024);
    const rows: Observation[] = (data.rows ?? []).map((row) => ({
      provider: 'google_search_console', engine: 'google', observed_for: isoDate(end),
      page_path: row.keys?.[0]?.startsWith('http') ? new URL(row.keys[0]).pathname : row.keys?.[0] ?? '',
      query: row.keys?.[1] ?? '', clicks: row.clicks ?? 0, impressions: row.impressions ?? 0,
      ctr: row.ctr ?? null, average_position: row.position ?? null, payload: row as unknown as Json, source_status: 'observed',
    }));
    const count = await writeObservations(db, rows);
    await writeSyncState(db, 'google_search_console', { status: 'connected', rows: count, started, completed: new Date().toISOString() });
    return count;
  } catch (error) {
    await writeSyncState(db, 'google_search_console', { status: 'error', error: String(error instanceof Error ? error.message : error).slice(0, 500), started });
    throw error;
  }
}

async function syncBing(db: Db): Promise<number> {
  const started = new Date().toISOString();
  const apiKey = process.env.BING_WEBMASTER_API_KEY?.trim();
  if (!apiKey) {
    await writeSyncState(db, 'bing_webmaster', { status: 'not_configured', error: 'Set BING_WEBMASTER_API_KEY for Bing Webmaster API access.', started });
    return 0;
  }
  try {
    const url = `https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats?siteUrl=${encodeURIComponent(siteUrl())}&apikey=${encodeURIComponent(apiKey)}`;
    const response = await fetchExternal(url, { method: 'GET' }, 60_000);
    if (!response.ok) throw new Error(`Bing Webmaster returned ${response.status}.`);
    const data = await readBoundedResponseJson<{ d?: unknown[] }>(response, 4 * 1024 * 1024);
    const rows: Observation[] = (data.d ?? []).map((row) => ({
      provider: 'bing_webmaster', engine: 'bing', observed_for: isoDate(), page_path: '', query: '',
      payload: row as Json, source_status: 'observed',
    }));
    const count = await writeObservations(db, rows);
    await writeSyncState(db, 'bing_webmaster', { status: 'connected', rows: count, started, completed: new Date().toISOString() });
    return count;
  } catch (error) {
    await writeSyncState(db, 'bing_webmaster', { status: 'error', error: String(error instanceof Error ? error.message : error).slice(0, 500), started });
    throw error;
  }
}

async function syncAiCitations(db: Db): Promise<number> {
  const started = new Date().toISOString();
  const endpoint = process.env.AI_CITATION_API_URL?.trim();
  const apiKey = process.env.AI_CITATION_API_KEY?.trim();
  if (!endpoint || !apiKey) {
    await writeSyncState(db, 'ai_citation', { status: 'not_configured', error: 'Set AI_CITATION_API_URL and AI_CITATION_API_KEY for citation observations.', started });
    return 0;
  }
  try {
    const response = await fetchExternal(endpoint, { method: 'GET', headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' } }, 60_000);
    if (!response.ok) throw new Error(`AI citation provider returned ${response.status}.`);
    const data = await readBoundedResponseJson<{ rows?: Record<string, unknown>[] } | Record<string, unknown>[]>(response, 4 * 1024 * 1024);
    const sourceRows = Array.isArray(data) ? data : data.rows ?? [];
    const rows: Observation[] = sourceRows.map((row) => ({
      provider: 'ai_citation', engine: typeof row.engine === 'string' && row.engine.trim() ? row.engine : 'unknown',
      observed_for: typeof row.observed_for === 'string' ? row.observed_for : isoDate(),
      page_path: typeof row.page_path === 'string' ? row.page_path : '',
      query: typeof row.query === 'string' ? row.query : '',
      citations: Number(row.citations ?? 0) || 0, cited: typeof row.cited === 'boolean' ? row.cited : null,
      payload: row as Json, source_status: 'observed',
    }));
    const count = await writeObservations(db, rows);
    await writeSyncState(db, 'ai_citation', { status: 'connected', rows: count, started, completed: new Date().toISOString() });
    return count;
  } catch (error) {
    await writeSyncState(db, 'ai_citation', { status: 'error', error: String(error instanceof Error ? error.message : error).slice(0, 500), started });
    throw error;
  }
}

export async function syncMarketingProviders(db: Db) {
  const results: Record<Provider, { ok: boolean; rows: number; error?: string }> = {
    google_search_console: { ok: true, rows: 0 }, bing_webmaster: { ok: true, rows: 0 }, ai_citation: { ok: true, rows: 0 },
  };
  for (const [provider, fn] of Object.entries({ google_search_console: syncGoogle, bing_webmaster: syncBing, ai_citation: syncAiCitations }) as [Provider, (db: Db) => Promise<number>][]) {
    try { results[provider].rows = await fn(db); }
    catch (error) { results[provider] = { ok: false, rows: 0, error: 'Provider synchronization failed.' }; console.error(`[marketing-provider-sync] ${provider}`, error); }
  }
  return results;
}
