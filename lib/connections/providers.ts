// Family API â€” the orchestration hub (North Star pillar #9). Bubaly's long-term
// role is to CONNECT the services a family already uses (calendars, email,
// banking, grocery, smart home) rather than replace them. This module is the
// pure, tested provider registry + the logic that merges the catalog with a
// family's saved connections. DB-free; the route feeds it real rows.

export type ConnectionCategory = 'calendar' | 'email' | 'banking' | 'grocery' | 'smart_home';
export type ConnectionStatus = 'connected' | 'syncing' | 'error' | 'disconnected';

export type Provider = {
  id: string;
  name: string;
  category: ConnectionCategory;
  /** icon key resolved to a lucide icon in the UI layer. */
  icon: string;
  description: string;
  /** Live data sync needs an OAuth/provider key configured server-side. */
  needsKeys: boolean;
  /** Provider id for the real OAuth/sync surface, when one is implemented. */
  syncProvider?: 'google' | 'microsoft' | 'apple';
};

export const CATEGORY_LABELS: Record<ConnectionCategory, string> = {
  calendar: 'Calendars', email: 'Email', banking: 'Banking',
  grocery: 'Grocery & Delivery', smart_home: 'Smart Home',
};

export const CATEGORY_ORDER: ConnectionCategory[] = ['calendar', 'email', 'banking', 'grocery', 'smart_home'];

/** The connectable services, grouped by category. */
export const PROVIDERS: Provider[] = [
  { id: 'google_calendar',  name: 'Google Calendar', category: 'calendar', icon: 'calendar', description: 'Two-way sync of events and reminders.', needsKeys: true, syncProvider: 'google' },
  { id: 'apple_calendar',   name: 'Apple Calendar',  category: 'calendar', icon: 'calendar', description: 'Sync your iCloud calendars.', needsKeys: true, syncProvider: 'apple' },
  { id: 'outlook_calendar', name: 'Outlook Calendar',category: 'calendar', icon: 'calendar', description: 'Sync Microsoft 365 calendars.', needsKeys: true, syncProvider: 'microsoft' },
  { id: 'gmail',            name: 'Gmail',           category: 'email',    icon: 'mail',     description: 'Triage family email into the inbox.', needsKeys: true },
  { id: 'outlook_email',    name: 'Outlook',         category: 'email',    icon: 'mail',     description: 'Triage Outlook email.', needsKeys: true },
  { id: 'plaid',            name: 'Bank (Plaid)',    category: 'banking',  icon: 'bank',     description: 'Connect accounts for balances and bills.', needsKeys: true },
  { id: 'instacart',        name: 'Instacart',       category: 'grocery',  icon: 'cart',     description: 'Send the shopping list to checkout.', needsKeys: true },
  { id: 'amazon_fresh',     name: 'Amazon Fresh',    category: 'grocery',  icon: 'cart',     description: 'Order groceries for delivery.', needsKeys: true },
  { id: 'google_home',      name: 'Google Home',     category: 'smart_home', icon: 'home',   description: 'Speak family routines and reminders.', needsKeys: true },
  { id: 'alexa',            name: 'Amazon Alexa',    category: 'smart_home', icon: 'home',   description: 'Family skills and announcements.', needsKeys: true },
  { id: 'smartthings',      name: 'SmartThings',     category: 'smart_home', icon: 'home',   description: 'Automate lights, locks, and sensors.', needsKeys: true },
];

export const PROVIDERS_BY_ID: Record<string, Provider> = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

/** Providers with a real user-facing OAuth/setup route today. */
export const CONNECTABLE_PROVIDERS: Provider[] = PROVIDERS.filter((p) => p.syncProvider);

export const CONNECTION_STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected', syncing: 'Syncingâ€¦', error: 'Needs attention', disconnected: 'Not connected',
};

/** A saved connection row (subset the merge needs). */
export type ConnectionLike = {
  provider: string;
  status: string;
  account_label: string | null;
  last_synced_at: string | null;
};

export type ProviderState = Provider & {
  connected: boolean;
  status: ConnectionStatus;
  accountLabel: string | null;
  lastSyncedAt: string | null;
};

/** Merge the provider catalog with a family's saved connections. */
export function mergeConnections(rows: ConnectionLike[]): ProviderState[] {
  const byProvider = new Map<string, ConnectionLike>();
  for (const r of rows) {
    const prev = byProvider.get(r.provider);
    // A live connection wins over a disconnected record for the same provider.
    if (!prev || (prev.status === 'disconnected' && r.status !== 'disconnected')) byProvider.set(r.provider, r);
  }
  return CONNECTABLE_PROVIDERS.map((p) => {
    const row = byProvider.get(p.id);
    const status: ConnectionStatus = row && ['connected', 'syncing', 'error'].includes(row.status)
      ? (row.status as ConnectionStatus) : 'disconnected';
    return {
      ...p,
      connected: status === 'connected' || status === 'syncing',
      status,
      accountLabel: row?.account_label ?? null,
      lastSyncedAt: row?.last_synced_at ?? null,
    };
  });
}

/** Group merged provider states by category, in canonical order. */
export function groupByCategory(states: ProviderState[]): [ConnectionCategory, ProviderState[]][] {
  const m = new Map<ConnectionCategory, ProviderState[]>();
  for (const s of states) { const arr = m.get(s.category) ?? []; arr.push(s); m.set(s.category, arr); }
  return CATEGORY_ORDER.filter((c) => m.has(c)).map((c) => [c, m.get(c)!]);
}

/** How many providers are live-connected (for the hub header). */
export function connectedCount(states: ProviderState[]): number {
  return states.filter((s) => s.connected).length;
}
