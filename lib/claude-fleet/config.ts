import { isOrganizationId } from './anthropic-identity';

export const MAX_CLAUDE_FLEET_PROBE_ACCOUNTS = 8;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export type ClaudeFleetBinding = {
  alias: string;
  expectedOrganizationId: string;
  adminApiKeyEnv: string;
};

export type ParseBindingsResult =
  | { ok: true; bindings: ClaudeFleetBinding[] }
  | { ok: false; reason: 'missing' | 'invalid_json' | 'invalid_shape' | 'invalid_alias' | 'duplicate_alias' | 'invalid_organization_id' };

function asRecords(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value) || value.length > MAX_CLAUDE_FLEET_PROBE_ACCOUNTS) return null;
  if (value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) return null;
  return value as Array<Record<string, unknown>>;
}

/** Parse non-secret aliases and expected org UUIDs; secret names are derived. */
export function parseClaudeFleetBindings(raw: string | undefined): ParseBindingsResult {
  if (!raw?.trim()) return { ok: false, reason: 'missing' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  const records = asRecords(parsed);
  if (!records || records.length === 0) return { ok: false, reason: 'invalid_shape' };

  const seen = new Set<string>();
  const bindings: ClaudeFleetBinding[] = [];
  for (const record of records) {
    if (Object.keys(record).some((key) => key !== 'alias' && key !== 'expectedOrganizationId')) {
      return { ok: false, reason: 'invalid_shape' };
    }
    if (typeof record.alias !== 'string' || !ALIAS_PATTERN.test(record.alias)) {
      return { ok: false, reason: 'invalid_alias' };
    }
    const normalizedAlias = record.alias.toUpperCase().replaceAll('-', '_');
    if (seen.has(normalizedAlias)) return { ok: false, reason: 'duplicate_alias' };
    seen.add(normalizedAlias);

    if (!isOrganizationId(record.expectedOrganizationId)) {
      return { ok: false, reason: 'invalid_organization_id' };
    }
    bindings.push({
      alias: record.alias,
      expectedOrganizationId: record.expectedOrganizationId.toLowerCase(),
      adminApiKeyEnv: `ANTHROPIC_ADMIN_API_KEY__${normalizedAlias}`,
    });
  }

  return { ok: true, bindings };
}
