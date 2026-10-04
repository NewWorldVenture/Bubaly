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
  | 'workspace_mismatch'
  | 'workspace_unavailable'
  | 'identity_unconfigured'
  | 'auth_rejected'
  | 'rate_limited'
  | 'provider_error'
  | 'invalid_provider_response'
  | 'provider_unreachable';

export type AnthropicIdentityResult = {
  status: AnthropicIdentityStatus;
  organizationId?: string;
  workspaceId?: string;
  checkedAt: string;
};

export type VerifyAnthropicIdentityOptions = {
  apiKey?: string;
  expectedOrganizationId?: string;
  /** Worker execution requires a separately verified active workspace. */
  workspaceId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
};

export function isOrganizationId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && /^wrkspc_[A-Za-z0-9]{1,100}$/.test(value);
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
  const result = (status: AnthropicIdentityStatus, organizationId?: string, workspaceId?: string): AnthropicIdentityResult => ({
    status,
    ...(organizationId ? { organizationId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    checkedAt: now().toISOString(),
  });

  if (!options.apiKey?.trim() || !isOrganizationId(options.expectedOrganizationId)
    || (options.workspaceId !== undefined && !isWorkspaceId(options.workspaceId))) {
    return result('identity_unconfigured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? ANTHROPIC_IDENTITY_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(ANTHROPIC_ORGANIZATION_URL, {
      method: 'GET',
      redirect: 'error',
      headers: {
        'x-api-key': options.apiKey.trim(),
        'anthropic-version': ANTHROPIC_VERSION,
        accept: 'application/json',
        ...(options.workspaceId ? { 'anthropic-workspace-id': options.workspaceId } : {}),
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
    if (actual !== expected) return result('organization_mismatch', actual);
    if (!options.workspaceId) return result('organization_verified', actual);
    // Verify access and active state with the same execution credential, under
    // the original shared deadline. Configured workspace text alone is not proof.
    const workspaceResponse = await fetchImpl(`https://api.anthropic.com/v1/organizations/workspaces/${options.workspaceId}`, {
      method: 'GET', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: {
        'x-api-key': options.apiKey.trim(), 'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-workspace-id': options.workspaceId, accept: 'application/json',
      },
    });
    if (!workspaceResponse.ok) {
      if (workspaceResponse.status === 401 || workspaceResponse.status === 403) return result('auth_rejected', actual);
      if (workspaceResponse.status === 429) return result('rate_limited', actual);
      return result('workspace_unavailable', actual);
    }
    let workspace: unknown;
    try { workspace = await workspaceResponse.json(); } catch { return result('invalid_provider_response', actual); }
    if (!workspace || typeof workspace !== 'object') return result('invalid_provider_response', actual);
    const target = workspace as { type?: unknown; id?: unknown; archived_at?: unknown };
    if (target.type !== 'workspace' || !isWorkspaceId(target.id)) return result('invalid_provider_response', actual);
    if (target.id !== options.workspaceId) return result('workspace_mismatch', actual);
    if (target.archived_at !== null) return result('workspace_unavailable', actual);
    return result('organization_verified', actual, target.id);
  } catch {
    return result('provider_unreachable');
  } finally {
    clearTimeout(timeout);
  }
}
