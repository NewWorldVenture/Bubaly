import { createHash } from 'node:crypto';

type StableValue = null | boolean | number | string | StableValue[] | { [key: string]: StableValue };

function stableValue(value: unknown): StableValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return String(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

/**
 * A replay of the same authenticated wizard payload must address the same
 * rows. The user id is part of the digest so a copied payload cannot collide
 * with another account's onboarding records.
 */
export function onboardingRunKey(userId: string, payload: unknown): string {
  return digest({ version: 1, userId, payload });
}

/** Return a deterministic key for one row within a wizard submission. */
export function onboardingItemKey(runKey: string, kind: string, index: number, value: unknown): string {
  return digest({ version: 1, runKey, kind, index, value });
}

