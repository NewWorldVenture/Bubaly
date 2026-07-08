// Google Calendar sync adapter (moat R9) — reference implementation of the
// SyncAdapter contract. Declares two-way event sync; stays inert until the
// GOOGLE_OAUTH_CLIENT_ID / _SECRET keys are configured (owner-gated). No network
// calls happen here — the real Calendar API wiring lands with the keys.

import type {
  SyncAdapter, AdapterContext, PullResult, PushResult, NormalizedEvent,
} from '../adapter';

export const googleCalendarAdapter: SyncAdapter = {
  providerId: 'google_calendar',
  category: 'calendar',
  capabilities: [{ resource: 'events', direction: 'two_way' }],

  isConfigured(env = process.env) {
    return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
  },

  async pullEvents(ctx: AdapterContext): Promise<PullResult<NormalizedEvent>> {
    if (!ctx.credentials) {
      return { items: [], cursor: null, errors: ['Google Calendar is not connected yet.'] };
    }
    // TODO(keys): call the Calendar API with ctx.credentials, ctx.since as the
    // syncToken/updatedMin, and map each event → NormalizedEvent.
    return { items: [], cursor: ctx.since ?? null, errors: [] };
  },

  async pushEvents(ctx: AdapterContext, events: NormalizedEvent[]): Promise<PushResult> {
    if (!ctx.credentials) {
      return { pushed: 0, errors: ['Google Calendar is not connected yet.'] };
    }
    // TODO(keys): upsert each NormalizedEvent into the connected calendar.
    void events;
    return { pushed: 0, errors: [] };
  },
};
