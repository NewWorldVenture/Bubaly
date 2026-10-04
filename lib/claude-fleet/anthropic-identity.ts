/**
 * Read-only Anthropic organization preflight for the Claude fleet.
 *
 * A match proves only that the supplied Anthropic API key resolves to the
 * configured organization. It does not prove a human identity or a running
 * Claude Code worker.
 */

const ANTHROPIC_ORGANIZATION_URL = 'https://api.anthropic.com/v1/organizations/me';
const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_IDENTITY_TIMEOUT_MS = 5_000;

export type AnthropicIdentityStatus =
  | 'organization_verified'
  | 'organization_mismatch'
  | 'identity_unconfigured'
  | 'auth_rejected'
  | 'rate_limited'
  | 'provider_error'
  | 'invalid_provider_response'
  | 'provider_unreachable';

export type AnthropicIdentityResult = {
  status: AnthropicIdentityStatus;
  organizationId?: string;
  checkedAt: string;
};

export type VerifyAnthropicIdentityOptions = {
  apiKey?: string;
  expectedOrganizationId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
};

export function isOrganizationId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Verify an API key against an owner-supplied organization UUID. This makes a
 * single GET to Anthropic's current-organization endpoint, with no retries and
 * no response-body or credential logging.
 */
export async function verifyAnthropicOrganization(
  options: VerifyAnthropicIdentityOptions,
): Promise<AnthropicIdentityResult> {
  const now = options.now ?? (() => new Date());
  const result = (status: AnthropicIdentityStatus, organizationId?: string): AnthropicIdentityResult => ({
    status,
    ...(organizationId ? { organizationId } : {}),
    checkedAt: now().toISOString(),
  });

  if (!options.apiKey?.trim() || !isOrganizationId(options.expectedOrganizationId)) {
    return result('identity_unconfigured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? ANTHROPIC_IDENTITY_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(ANTHROPIC_ORGANIZATION_URL, {
      method: 'GET',
      headers: {
        'x-api-key': options.apiKey.trim(),
        'anthropic-version': ANTHROPIC_VERSION,
        accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return result('auth_rejected');
      if (response.status === 429) return result('rate_limited');
      return result('provider_error');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return result('invalid_provider_response');
    }

    if (!body || typeof body !== 'object') return result('invalid_provider_response');
    const identity = body as { id?: unknown; type?: unknown };
    if (identity.type !== 'organization' || !isOrganizationId(identity.id)) {
      return result('invalid_provider_response');
    }

    const actual = identity.id.toLowerCase();
    const expected = options.expectedOrganizationId.toLowerCase();
    return result(actual === expected ? 'organization_verified' : 'organization_mismatch', actual);
  } catch {
    return result('provider_unreachable');
  } finally {
    clearTimeout(timeout);
  }
}
