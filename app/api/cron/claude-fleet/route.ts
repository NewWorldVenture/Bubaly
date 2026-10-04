import { NextResponse } from 'next/server';
import { parseClaudeFleetBindings } from '@/lib/claude-fleet/config';
import { verifyAnthropicOrganization } from '@/lib/claude-fleet/anthropic-identity';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const enabled = (value: string | undefined) => value === 'true';

/**
 * Scheduled, read-only account preflight. This is deliberately not a worker
 * connection check; only the later isolated Claude Code probe can establish
 * that a worker is connected.
 */
export async function GET(req: Request) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
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
