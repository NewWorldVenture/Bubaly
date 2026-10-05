import { describe, expect, it, vi } from 'vitest';
import { MAX_CLAUDE_FLEET_PROBE_ACCOUNTS, parseClaudeFleetBindings } from '@/lib/claude-fleet/config';
import { ANTHROPIC_IDENTITY_TIMEOUT_MS, verifyAnthropicOrganization } from '@/lib/claude-fleet/anthropic-identity';

const EXPECTED_ORG = '12345678-1234-1234-1234-123456789abc';
const OTHER_ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHECKED_AT = '2026-10-04T19:00:00.000Z';

function okResponse(id = EXPECTED_ORG) {
  return new Response(JSON.stringify({ id, name: 'Synthetic org', type: 'organization' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Anthropic organization identity preflight', () => {
  it('makes one bounded read-only request and returns only the expected org identity', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse());
    const result = await verifyAnthropicOrganization({
      apiKey: 'synthetic-admin-key',
      expectedOrganizationId: EXPECTED_ORG,
      fetchImpl,
      now: () => new Date(CHECKED_AT),
    });

    expect(result).toEqual({
      status: 'organization_verified',
      organizationId: EXPECTED_ORG,
      checkedAt: CHECKED_AT,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/organizations/me');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-admin-key');
    expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
  });

  it('fails closed for a key bound to a different organization', async () => {
    const result = await verifyAnthropicOrganization({
      apiKey: 'synthetic-admin-key',
      expectedOrganizationId: EXPECTED_ORG,
      fetchImpl: async () => okResponse(OTHER_ORG),
      now: () => new Date(CHECKED_AT),
    });

    expect(result).toEqual({ status: 'organization_mismatch', organizationId: OTHER_ORG, checkedAt: CHECKED_AT });
  });

  it('verifies the exact active workspace using the same execution key and confined headers', async () => {
    const workspaceId = 'wrkspc_synthetic';
    const fetchImpl = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/me') ? okResponse()
      : Response.json({ type: 'workspace', id: workspaceId, archived_at: null }));
    expect(await verifyAnthropicOrganization({ apiKey: 'synthetic-execution-key', expectedOrganizationId: EXPECTED_ORG,
      workspaceId, fetchImpl, now: () => new Date(CHECKED_AT) })).toEqual({
      status: 'organization_verified', organizationId: EXPECTED_ORG, workspaceId, checkedAt: CHECKED_AT,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(`https://api.anthropic.com/v1/organizations/workspaces/${workspaceId}`);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-execution-key');
      expect(new Headers(init?.headers).get('anthropic-workspace-id')).toBe(workspaceId);
      expect(init?.signal).toBe(fetchImpl.mock.calls[0][1]?.signal);
    }
  });

  it.each([
    [{ type: 'workspace', id: 'wrkspc_other', archived_at: null }, 'workspace_mismatch'],
    [{ type: 'workspace', id: 'wrkspc_synthetic', archived_at: CHECKED_AT }, 'workspace_unavailable'],
    [{ type: 'workspace', id: 'wrkspc_synthetic' }, 'workspace_unavailable'],
    [{ type: 'organization', id: EXPECTED_ORG }, 'invalid_provider_response'],
  ] as const)('rejects mismatched/archived/invalid workspace proof', async (body, status) => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/me') ? okResponse() : Response.json(body));
    const result = await verifyAnthropicOrganization({ apiKey: 'synthetic-execution-key', expectedOrganizationId: EXPECTED_ORG,
      workspaceId: 'wrkspc_synthetic', fetchImpl });
    expect(result.status).toBe(status);
    expect(result.workspaceId).toBeUndefined();
  });

  it('does not probe an invalid workspace or continue after an organization mismatch', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(OTHER_ORG));
    expect((await verifyAnthropicOrganization({ apiKey: 'synthetic-execution-key', expectedOrganizationId: EXPECTED_ORG,
      workspaceId: 'wrkspc_../outside', fetchImpl })).status).toBe('identity_unconfigured');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await verifyAnthropicOrganization({ apiKey: 'synthetic-execution-key', expectedOrganizationId: EXPECTED_ORG,
      workspaceId: 'wrkspc_synthetic', fetchImpl })).status).toBe('organization_mismatch');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed when workspace access is denied without exposing provider diagnostics', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/me') ? okResponse()
      : new Response('synthetic-private-provider-diagnostic', { status: 404 }));
    const result = await verifyAnthropicOrganization({ apiKey: 'synthetic-execution-key', expectedOrganizationId: EXPECTED_ORG,
      workspaceId: 'wrkspc_synthetic', fetchImpl });
    expect(result.status).toBe('workspace_unavailable');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-provider-diagnostic');
  });

  it('does not call Anthropic if either the API key or expected organization is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const withoutKey = await verifyAnthropicOrganization({ apiKey: '', expectedOrganizationId: EXPECTED_ORG, fetchImpl });
    const withoutExpectedOrg = await verifyAnthropicOrganization({ apiKey: 'synthetic-admin-key', expectedOrganizationId: '', fetchImpl });

    expect(withoutKey.status).toBe('identity_unconfigured');
    expect(withoutExpectedOrg.status).toBe('identity_unconfigured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'auth_rejected'],
    [403, 'auth_rejected'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
  ] as const)('sanitizes provider HTTP %i without returning its body', async (status, expectedStatus) => {
    const secretText = 'synthetic-provider-error-with-secret';
    const result = await verifyAnthropicOrganization({
      apiKey: 'synthetic-admin-key',
      expectedOrganizationId: EXPECTED_ORG,
      fetchImpl: async () => new Response(secretText, { status }),
      now: () => new Date(CHECKED_AT),
    });

    expect(result.status).toBe(expectedStatus);
    expect(JSON.stringify(result)).not.toContain(secretText);
  });

  it('rejects malformed identity responses and bounds a stalled request', async () => {
    const malformed = await verifyAnthropicOrganization({
      apiKey: 'synthetic-admin-key',
      expectedOrganizationId: EXPECTED_ORG,
      fetchImpl: async () => new Response(JSON.stringify({ id: EXPECTED_ORG, type: 'user' }), { status: 200 }),
    });
    const stalled = await verifyAnthropicOrganization({
      apiKey: 'synthetic-admin-key',
      expectedOrganizationId: EXPECTED_ORG,
      timeoutMs: 1,
      fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    });

    expect(malformed.status).toBe('invalid_provider_response');
    expect(stalled.status).toBe('provider_unreachable');
  });
});

describe('Claude fleet probe bindings', () => {
  it('derives a namespaced server-side admin-key reference from a valid alias', () => {
    expect(parseClaudeFleetBindings(JSON.stringify([
      { alias: 'NewWorldVenture', expectedOrganizationId: EXPECTED_ORG },
    ]))).toEqual({
      ok: true,
      bindings: [{
        alias: 'NewWorldVenture',
        expectedOrganizationId: EXPECTED_ORG,
        adminApiKeyEnv: 'ANTHROPIC_ADMIN_API_KEY__NEWWORLDVENTURE',
      }],
    });
  });

  it('rejects empty, malformed, over-sized, or ambiguous account configurations', () => {
    expect(parseClaudeFleetBindings(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(parseClaudeFleetBindings('{')).toEqual({ ok: false, reason: 'invalid_json' });
    expect(parseClaudeFleetBindings('[]')).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseClaudeFleetBindings(JSON.stringify([
      { alias: 'alice-one', expectedOrganizationId: EXPECTED_ORG },
      { alias: 'alice_one', expectedOrganizationId: OTHER_ORG },
    ]))).toEqual({ ok: false, reason: 'duplicate_alias' });
    expect(parseClaudeFleetBindings(JSON.stringify([
      { alias: 'alice', expectedOrganizationId: 'not-an-org' },
    ]))).toEqual({ ok: false, reason: 'invalid_organization_id' });
    expect(parseClaudeFleetBindings(JSON.stringify([
      { alias: '../secrets', expectedOrganizationId: EXPECTED_ORG },
    ]))).toEqual({ ok: false, reason: 'invalid_alias' });
    expect(parseClaudeFleetBindings(JSON.stringify([
      { alias: 'alice', expectedOrganizationId: EXPECTED_ORG, apiKey: 'must-not-be-configured-here' },
    ]))).toEqual({ ok: false, reason: 'invalid_shape' });
    const tooManyAccounts = Array.from({ length: MAX_CLAUDE_FLEET_PROBE_ACCOUNTS + 1 }, (_, i) => ({
      alias: `account${i}`,
      expectedOrganizationId: EXPECTED_ORG,
    }));
    expect(parseClaudeFleetBindings(JSON.stringify(tooManyAccounts))).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('bounds sequential probe time below the cron route runtime cap', () => {
    expect(MAX_CLAUDE_FLEET_PROBE_ACCOUNTS * ANTHROPIC_IDENTITY_TIMEOUT_MS).toBeLessThan(60_000);
  });
});
