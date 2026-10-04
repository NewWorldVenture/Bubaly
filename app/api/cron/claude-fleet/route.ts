import { NextResponse } from 'next/server';
import { parseClaudeFleetBindings } from '@/lib/claude-fleet/config';
import { verifyAnthropicOrganization } from '@/lib/claude-fleet/anthropic-identity';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { handleFleetManagerRequest } from '@/lib/claude-fleet/manager';
import { openFleetStore } from '@/lib/claude-fleet/repository';
import { FleetConfigurationError, fleetDailyBudget, fleetExecutionEnabled, fleetMaxConcurrency, fleetWorkerRegistrations } from '@/lib/claude-fleet/runtime-config';
import { runFleetTick } from '@/lib/claude-fleet/service';
import { vercelFleetSupervisor } from '@/lib/claude-fleet/supervisor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const enabled = (value: string | undefined) => value === 'true';

/**
 * Existing scheduler entry point: optional durable worker tick, otherwise an
 * organization-only preflight. Both paths fail closed until configured.
 */
export async function GET(req: Request) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (process.env.CLAUDE_FLEET_WORKERS_ENABLED === 'true') {
    if (!fleetExecutionEnabled()) {
      return NextResponse.json({ ok: true, enabled: false, status: 'paid_probes_not_approved' });
    }
    let handle: ReturnType<typeof openFleetStore> | undefined;
    try {
      const registrations = fleetWorkerRegistrations();
      handle = openFleetStore();
      const result = await runFleetTick(handle.store, registrations, fleetMaxConcurrency(), vercelFleetSupervisor, req.signal, fleetDailyBudget());
      return NextResponse.json({ ok: true, enabled: true, ...result });
    } catch (error) {
      return NextResponse.json({ ok: false, status: 'worker_unavailable',
        reason: error instanceof FleetConfigurationError ? error.code : 'fleet_operation_failed' }, { status: 503 });
    } finally { handle?.close(); }
  }

  if (!enabled(process.env.CLAUDE_FLEET_PROBES_ENABLED)) {
    return NextResponse.json({ ok: true, enabled: false, status: 'disabled' });
  }

  const parsed = parseClaudeFleetBindings(process.env.CLAUDE_FLEET_ACCOUNT_BINDINGS);
  if (!parsed.ok) {
    return NextResponse.json({
      ok: false,
      enabled: true,
      status: 'configuration_incomplete',
      reason: parsed.reason,
    }, { status: 503 });
  }

  // Run one key at a time to bound provider traffic and keep this short route
  // compatible with the shared cron dispatcher's invocation budget.
  const results = [];
  for (const binding of parsed.bindings) {
    const identity = await verifyAnthropicOrganization({
      apiKey: process.env[binding.adminApiKeyEnv],
      expectedOrganizationId: binding.expectedOrganizationId,
    });
    results.push({
      alias: binding.alias,
      status: identity.status,
      ...(identity.organizationId ? { organizationId: identity.organizationId } : {}),
      checkedAt: identity.checkedAt,
    });
  }

  const ok = results.every((result) => result.status === 'organization_verified');
  return NextResponse.json({
    ok,
    enabled: true,
    status: 'preflight_complete',
    workerConnection: 'not_checked',
    results,
  }, { status: ok ? 200 : 502 });
}

export async function POST(req: Request) {
  return handleFleetManagerRequest(req);
}
