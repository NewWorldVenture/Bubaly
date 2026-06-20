// lib/sync/capabilities.ts
//
// The honest, single source of truth for what each provider can ACTUALLY do via
// its public API. The UI reads this to show real "Supported / Not supported"
// states instead of pretending. The DB seed in 0018_sync_platform.sql mirrors
// this exactly. If you change one, change both.
//
// Ground rules encoded here (do not "upgrade" without a real, shipping API):
//   - Google Keep has NO public API           -> google.note = none
//   - Apple Notes has NO public API            -> apple.note  = none
//   - Amazon/Alexa has no general write API for calendars (only ICS subscribe)
//     and no public reminder-write API without a custom Alexa Skill
//   - Apple/Amazon use CalDAV / ICS, not OAuth2 token sync

export type SyncProvider = 'google' | 'microsoft' | 'apple' | 'amazon' | 'internal';
export type SyncItemKind = 'calendar' | 'reminder' | 'note';

/** How a capability is delivered, so the UI can explain *how* it works. */
export type CapabilityMechanism = 'api' | 'caldav' | 'ics' | 'export' | 'none';

export type Capability = {
  /** Can we pull data FROM the provider INTO theagoras? */
  read: boolean;
  /** Can we push data FROM theagoras TO the provider? */
  write: boolean;
  mechanism: CapabilityMechanism;
  /** Plain-language note shown in the UI when read/write is limited or off. */
  limitation?: string;
};

export type ProviderCapabilities = Record<SyncItemKind, Capability>;

const NONE = (limitation: string): Capability => ({
  read: false,
  write: false,
  mechanism: 'none',
  limitation,
});

export const CAPABILITIES: Record<SyncProvider, ProviderCapabilities> = {
  google: {
    calendar: { read: true, write: true, mechanism: 'api' },
    reminder: {
      read: true,
      write: true,
      mechanism: 'api',
      limitation: 'Syncs with Google Tasks. Reminder-specific fields map onto task due dates.',
    },
    note: NONE(
      'Google Keep has no public API. Notes stay internal to theagoras, with optional one-way export to a Google Doc.',
    ),
  },
  microsoft: {
    calendar: { read: true, write: true, mechanism: 'api' },
    reminder: { read: true, write: true, mechanism: 'api', limitation: 'Syncs with Microsoft To Do.' },
    note: {
      read: true,
      write: true,
      mechanism: 'api',
      limitation: 'Syncs with OneNote pages. Rich formatting is converted to/from HTML.',
    },
  },
  apple: {
    calendar: {
      read: true,
      write: true,
      mechanism: 'caldav',
      limitation: 'Requires an app-specific password for CalDAV. A public ICS feed is also available to subscribe.',
    },
    reminder: {
      read: true,
      write: true,
      mechanism: 'caldav',
      limitation: 'Apple Reminders sync over CalDAV (VTODO) using an app-specific password.',
    },
    note: NONE('Apple Notes has no public API. Notes stay internal to theagoras.'),
  },
  amazon: {
    calendar: {
      read: false,
      write: true,
      mechanism: 'ics',
      limitation: 'Alexa can subscribe to a published ICS feed (one-way, theagoras -> Alexa). There is no API to read an Amazon calendar back.',
    },
    reminder: NONE(
      'Amazon has no public reminder-write API. Writing Alexa reminders requires a custom Alexa Skill with account linking (not yet enabled).',
    ),
    note: NONE('Amazon has no notes product/API.'),
  },
  internal: {
    calendar: { read: true, write: true, mechanism: 'api' },
    reminder: { read: true, write: true, mechanism: 'api' },
    note: { read: true, write: true, mechanism: 'api' },
  },
};

export function getCapability(provider: SyncProvider, kind: SyncItemKind): Capability {
  return CAPABILITIES[provider][kind];
}

/** True only when a real two-way sync is possible for this provider + item kind. */
export function supportsTwoWay(provider: SyncProvider, kind: SyncItemKind): boolean {
  const c = getCapability(provider, kind);
  return c.read && c.write;
}

/** True when we can do anything at all (read OR write). */
export function isSupported(provider: SyncProvider, kind: SyncItemKind): boolean {
  const c = getCapability(provider, kind);
  return c.read || c.write;
}

/** Directions the UI may offer for a provider + item kind, given real capability. */
export function allowedDirections(
  provider: SyncProvider,
  kind: SyncItemKind,
): Array<'import' | 'export' | 'two_way' | 'manual' | 'disabled'> {
  const c = getCapability(provider, kind);
  const dirs: Array<'import' | 'export' | 'two_way' | 'manual' | 'disabled'> = ['disabled'];
  if (c.read) dirs.unshift('import');
  if (c.write) dirs.unshift('export');
  if (c.read && c.write) {
    dirs.unshift('manual');
    dirs.unshift('two_way');
  }
  return dirs;
}

export const PROVIDER_LABELS: Record<SyncProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft / Outlook',
  apple: 'Apple',
  amazon: 'Amazon / Alexa',
  internal: 'theagoras.com',
};
