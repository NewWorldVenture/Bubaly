import nextEnv from '@next/env';
import { pathToFileURL } from 'node:url';

// Presence checks retrieve zero rows; authenticated CRUD and RLS tests remain
// separate requirements. Retain historical checks alongside the new modules.
export const SCHEMA_CHECKS = [
  ['workload_snapshots', '0174_workload_snapshots.sql'],
  ['independence_milestones', '0175_independence_milestones.sql'],
  ['money_timeline_insights', '0168_money_timeline_insights.sql'],
  ['paperwork_items', '0169_paperwork_items.sql'],
  ['contact_interactions', '0170_contact_interactions.sql'],
  ['crm_contact_profile', '0171_crm_contact_profile.sql'],
  ['crm_lead_scores', '0172_crm_lead_scores.sql'],
  ['marketplace_circles', '0176_marketplace_circles.sql'],
  ['resend_webhook_events', '0180_resend_webhook_dedup.sql'],
  ['guardian_callback_events', '0181_guardian_callback_replay.sql'],
  ['stripe_webhook_events.claim_columns', '0189_reconcile_stripe_webhook_claims.sql', 'processing_started_at,claim_token'],
  ['wardrobe_items', '0240_closet_outfits.sql'],
  ['outfits', '0240_closet_outfits.sql'],
  ['outfit_logs', '0240_closet_outfits.sql'],
  ['watchlist_titles', '0241_family_watchlist.sql'],
  ['watchlist_votes', '0241_family_watchlist.sql'],
  ['watch_sessions', '0241_family_watchlist.sql'],
  ['home_locations', '0242_home_inventory.sql'],
  ['inventory_items', '0242_home_inventory.sql'],
  ['inventory_moves', '0242_home_inventory.sql'],
  ['sleep_logs', '0243_sleep_coach.sql'],
  ['bedtime_routines', '0243_sleep_coach.sql'],
  ['sleep_checkins', '0243_sleep_coach.sql'],
  ['declutter_zones', '0244_declutter.sql'],
  ['declutter_missions', '0244_declutter.sql'],
  ['declutter_sessions', '0244_declutter.sql'],
  ['moves', '0245_move_planner.sql'],
  ['move_tasks', '0245_move_planner.sql'],
  ['move_boxes', '0245_move_planner.sql'],
  ['home_projects', '0246_home_projects.sql'],
  ['project_materials', '0246_home_projects.sql'],
  ['project_quotes', '0246_home_projects.sql'],
  ['career_profiles', '0247_career_hub.sql'],
  ['job_applications', '0247_career_hub.sql'],
  ['resume_versions', '0247_career_hub.sql'],
  ['language_goals', '0248_language_practice.sql'],
  ['language_sessions', '0248_language_practice.sql'],
  ['vocab_cards', '0248_language_practice.sql'],
  ['ai_requests', '0250_ai_runtime_core.sql'],
  ['ai_request_context', '0250_ai_runtime_core.sql'],
  ['ai_plans', '0250_ai_runtime_core.sql'],
  ['ai_plan_steps', '0250_ai_runtime_core.sql'],
  ['ai_run_events', '0250_ai_runtime_core.sql'],
  ['ai_tool_calls', '0250_ai_runtime_core.sql'],
  ['family_automation_runs.runtime_columns', '0250_ai_runtime_core.sql', 'request_id,plan_id,requested_by_member_id,state,current_step_id,run_after,lease_owner,lease_expires_at,attempt,max_attempts,idempotency_key,cancel_requested_at,paused_at,run_type,progress,started_at,completed_at,error'],
  ['ai_conversations.runtime_columns', '0250_ai_runtime_core.sql', 'state,prompt_version'],
  ['ai_messages.runtime_columns', '0250_ai_runtime_core.sql', 'structured_content,model,usage,request_id,sender_member_id'],
  ['approval_requests.runtime_columns', '0251_ai_trust_hardening.sql', 'request_id,run_id,plan_step_id,plan_step_ids,consequences,evidence,edited_payload,payload_kind,reviewed_by,review_note'],
  ['ai_requests.runtime_columns', '0255_ai_runtime_lockdown.sql', 'client_request_id'],
  ['home_briefs.runtime_columns', '0258_home_briefs_kind.sql', 'kind,handled,delivered_at'],
  ['routine_runs', '0259_routine_schedules.sql'],
  ['family_automation_rules.runtime_columns', '0259_routine_schedules.sql', 'schedule_kind,schedule_expr,anchor_key,offset_days,at_hour,next_run_at,said,source_request_id'],
];

// Only fixed diagnostic categories leave this parser. Provider messages, hints,
// details, arbitrary codes and credential values must never reach audit output.
const ERROR_BODY_LIMIT = 4096;
const REPORTED_ERRORS = new Map([
  ['401:PGRST301', 'jwt-rejection-reported'],
  ['401:PGRST302', 'authentication-required-reported'],
  ['401:PGRST303', 'jwt-claims-rejection-reported'],
  ['401:42501', 'insufficient-privilege-reported'],
  ['403:42501', 'insufficient-privilege-reported'],
  ['500:PGRST300', 'jwt-verifier-unavailable-reported'],
]);

function cancelBody(body) {
  // Cleanup must neither erase a received HTTP status nor hold up the audit.
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* best effort */ }
}

async function reportedFailure(response, signal) {
  let reader;
  let onAbort;
  try {
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (![401, 403, 500].includes(response.status) || contentType !== 'application/json' || !response.body) {
      return undefined;
    }
    reader = response.body.getReader();
    const aborted = Symbol('aborted');
    const deadline = new Promise((resolve) => {
      onAbort = () => resolve(aborted);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    const chunks = [];
    let length = 0;
    let reads = 0;
    while (true) {
      // Also bound empty/tiny chunks, which could otherwise starve the timer.
      if (++reads > 128) return undefined;
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk === aborted) return undefined;
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > ERROR_BODY_LIMIT) return undefined;
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const error = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
    if (Object.hasOwn(error, 'code')) {
      return typeof error.code === 'string'
        ? REPORTED_ERRORS.get(`${response.status}:${error.code}`)
        : undefined;
    }
    // This records an exact provider-reported literal, not proof of the key's
    // validity, source, privilege, or the cause of a different response.
    if (response.status === 401 && error.message === 'Invalid API key') {
      return 'api-key-rejection-reported';
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (reader) cancelBody(reader);
    else cancelBody(response.body);
  }
}

function keyFormat(key) {
  if (key.startsWith('sb_secret_')) return 'opaque-secret';
  if (key.startsWith('sb_publishable_')) return 'opaque-publishable';
  const segments = key.split('.');
  return segments.length === 3 && segments.every(Boolean) ? 'jwt-shaped' : 'unrecognized';
}

export async function auditSupabaseSchema({
  url,
  key,
  fetchImpl = fetch,
  checks = SCHEMA_CHECKS,
  timeoutMs = 10_000,
}) {
  const baseUrl = new URL(url);
  if (!['https:', 'http:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error('Use an HTTP(S) Supabase API URL without embedded credentials.');
  }
  const results = new Array(checks.length);
  let cursor = 0;
  // Bound the load placed on the production database.
  await Promise.all(Array.from({ length: Math.min(4, checks.length) }, async () => {
    while (cursor < checks.length) {
      const index = cursor++;
      const [table, migration, columns = '*'] = checks[index];
      const endpoint = new URL(`/rest/v1/${table.split('.')[0]}`, baseUrl);
      endpoint.searchParams.set('select', columns);
      endpoint.searchParams.set('limit', '0');
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          // Opaque API keys authenticate through apikey; they are not JWTs.
          headers: key.startsWith('sb_secret_') || key.startsWith('sb_publishable_')
            ? { apikey: key }
            : { apikey: key, Authorization: `Bearer ${key}` },
          signal,
          // Never forward an API key to a redirected destination.
          redirect: 'error',
        });
        let diagnosis;
        if (response.ok) cancelBody(response.body);
        else diagnosis = await reportedFailure(response, signal);
        results[index] = {
          table, migration, status: response.status, ok: response.ok,
          ...(diagnosis ? { diagnosis } : {}),
        };
      } catch {
        // Exception messages and response bodies can contain private data.
        results[index] = {
          table, migration, status: 0, ok: false,
          error: signal.aborted ? 'Request timed out.' : 'Request failed.',
        };
      }
    }
  }));
  return results;
}

export async function runSchemaAuditCli() {
  nextEnv.loadEnvConfig(process.cwd());
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Server credentials cover private infrastructure tables. The public-key
  // fallbacks also support read-only diagnostics before those are configured.
  const selected = [
    ['SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY],
    ['SUPABASE_ANON_KEY', process.env.SUPABASE_ANON_KEY],
  ].find(([, value]) => Boolean(value));
  const key = selected?.[1];
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and a Supabase API key are required.');
    return 1;
  }
  let results;
  try {
    results = await auditSupabaseSchema({ url, key });
  } catch {
    console.error('Schema audit configuration is invalid. Check the Supabase API URL.');
    return 1;
  }
  const failures = results.filter((result) => !result.ok);
  if (failures.length) {
    console.error(`Schema audit credential selection: source=${selected[0]}, format=${keyFormat(key)} (format is not validity or privilege proof).`);
  }
  for (const result of results) {
    if (result.ok) {
      console.log(`OK      ${result.table}`);
    } else if (result.status === 404 || (result.table.includes('.') && result.status === 400)) {
      console.error(`MISSING ${result.table} (${result.migration})`);
    } else {
      console.error(`ERROR   ${result.table} (HTTP ${result.status || 'network'})${result.error ? `: ${result.error}` : ''}${result.diagnosis ? ` [${result.diagnosis}]` : ''}`);
    }
  }
  if (failures.length) {
    console.error(`\nSchema audit failed: ${failures.length} of ${results.length} required schema checks unavailable.`);
    return 1;
  }
  console.log(`\nSchema audit passed: ${results.length} required schema checks available.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runSchemaAuditCli();
}
