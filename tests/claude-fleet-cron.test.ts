import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Claude fleet cron identity preflight', () => {
  it('rejects an unauthorized caller before reading bindings or contacting Anthropic', async () => {
    vi.stubEnv('CRON_SECRET', 'synthetic-cron-secret');
    vi.stubEnv('CLAUDE_FLEET_PROBES_ENABLED', 'true');
    vi.stubGlobal('fetch', vi.fn());
    const { GET } = await import('@/app/api/cron/claude-fleet/route');

    const response = await GET(new Request('https://example.test/api/cron/claude-fleet'));

    expect(response.status).toBe(401);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('stays disabled by default and never contacts Anthropic', async () => {
    vi.stubEnv('CRON_SECRET', 'synthetic-cron-secret');
    vi.stubGlobal('fetch', vi.fn());
    const { GET } = await import('@/app/api/cron/claude-fleet/route');

    const response = await GET(new Request('https://example.test/api/cron/claude-fleet', {
      headers: { authorization: 'Bearer synthetic-cron-secret' },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, enabled: false, status: 'disabled' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('requires an expected identity binding before making a provider call', async () => {
    vi.stubEnv('CRON_SECRET', 'synthetic-cron-secret');
    vi.stubEnv('CLAUDE_FLEET_PROBES_ENABLED', 'true');
    vi.stubEnv('CLAUDE_FLEET_ACCOUNT_BINDINGS', '[]');
    vi.stubGlobal('fetch', vi.fn());
    const { GET } = await import('@/app/api/cron/claude-fleet/route');

    const response = await GET(new Request('https://example.test/api/cron/claude-fleet', {
      headers: { authorization: 'Bearer synthetic-cron-secret' },
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ enabled: true, status: 'configuration_incomplete' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('reports an organization match without claiming a Claude Code worker is connected', async () => {
    const apiKey = 'synthetic-anthropic-admin-key';
    vi.stubEnv('CRON_SECRET', 'synthetic-cron-secret');
    vi.stubEnv('CLAUDE_FLEET_PROBES_ENABLED', 'true');
    vi.stubEnv('CLAUDE_FLEET_ACCOUNT_BINDINGS', JSON.stringify([
      { alias: 'SyntheticAccount', expectedOrganizationId: '12345678-1234-1234-1234-123456789abc' },
    ]));
    vi.stubEnv('ANTHROPIC_ADMIN_API_KEY__SYNTHETICACCOUNT', apiKey);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: '12345678-1234-1234-1234-123456789abc',
      name: 'Synthetic org',
      type: 'organization',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/cron/claude-fleet/route');

    const response = await GET(new Request('https://example.test/api/cron/claude-fleet', {
      headers: { authorization: 'Bearer synthetic-cron-secret' },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      enabled: true,
      status: 'preflight_complete',
      workerConnection: 'not_checked',
      results: [{ alias: 'SyntheticAccount', status: 'organization_verified' }],
    });
    expect(JSON.stringify(body)).not.toContain(apiKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
