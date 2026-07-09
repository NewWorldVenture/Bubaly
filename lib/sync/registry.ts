// lib/sync/registry.ts — the provider adapter registry (R9).
//
// One place the sync engine, OAuth routes, and Connections hub look up a provider
// adapter by its `sync_provider` enum value. Adding a provider = implement the
// SyncProviderAdapter contract + register it here; nothing else in the engine
// changes. `configuredAdapters()` returns only the providers whose OAuth keys are
// actually set, so the UI can show "Connect" only where it will work.
//
// SERVER ONLY (adapters import server-only provider clients).

import type { SyncProviderEnum } from '@/lib/database.types';
import type { SyncProviderAdapter } from '@/lib/sync/adapter';
import { googleAdapter } from '@/lib/sync/providers/google-adapter';
import { microsoftAdapter } from '@/lib/sync/providers/microsoft';

const ADAPTERS: Partial<Record<SyncProviderEnum, SyncProviderAdapter>> = {
  google: googleAdapter,
  microsoft: microsoftAdapter,
};

/** All registered adapters (regardless of whether their keys are configured). */
export function listAdapters(): SyncProviderAdapter[] {
  return Object.values(ADAPTERS).filter((a): a is SyncProviderAdapter => !!a);
}

/** The adapter for a provider, or null if none is registered. */
export function getAdapter(provider: SyncProviderEnum): SyncProviderAdapter | null {
  return ADAPTERS[provider] ?? null;
}

/** Only the adapters whose OAuth client keys are configured server-side. */
export function configuredAdapters(): SyncProviderAdapter[] {
  return listAdapters().filter((a) => a.isConfigured());
}

/** True when a provider has a registered adapter with its keys configured. */
export function isProviderConfigured(provider: SyncProviderEnum): boolean {
  return getAdapter(provider)?.isConfigured() ?? false;
}
