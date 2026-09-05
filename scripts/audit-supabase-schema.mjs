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
  ['family_automation_runs.runtime_columns', '0250_ai_runtime_core.sql', 'request_id,plan_id,requested_by_member_id,state,current_step_id,run_after,lease_owner,lease_expires_at,attempt,max_attempts,idempotency_key,cancel_requested_at,paused_at'],
  ['ai_conversations.runtime_columns', '0250_ai_runtime_core.sql', 'state,prompt_version'],
  ['ai_messages.runtime_columns', '0250_ai_runtime_core.sql', 'structured_content,model,usage,request_id,sender_member_id'],
  ['approval_requests.runtime_columns', '0251_ai_trust_hardening.sql', 'request_id,run_id,plan_step_id,plan_step_ids,consequences,evidence,edited_payload,payload_kind,reviewed_by,review_note'],
];

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
          headers: { apikey: key, Authorization: `Bearer ${key}` },
          signal,
          // Never forward an API key to a redirected destination.
          redirect: 'error',
        });
        await response.body?.cancel();
        results[index] = { table, migration, status: response.status, ok: response.ok };
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
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || process.env.SUPABASE_ANON_KEY;
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
  for (const result of results) {
    if (result.ok) {
      console.log(`OK      ${result.table}`);
    } else if (result.status === 404 || (result.table.includes('.') && result.status === 400)) {
      console.error(`MISSING ${result.table} (${result.migration})`);
    } else {
      console.error(`ERROR   ${result.table} (HTTP ${result.status || 'network'})${result.error ? `: ${result.error}` : ''}`);
    }
  }
  const failures = results.filter((result) => !result.ok);
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
