// Gmail sync adapter (moat R9) — reference implementation of the SyncAdapter
// contract. Declares pull-only message sync (Bubaly triages family email into the
// inbox; it does not send). Inert until GOOGLE_OAUTH_CLIENT_ID / _SECRET are
// configured (owner-gated). No network calls here.

import type {
  SyncAdapter, AdapterContext, PullResult, NormalizedMessage,
} from '../adapter';

export const gmailAdapter: SyncAdapter = {
  providerId: 'gmail',
  category: 'email',
  capabilities: [{ resource: 'messages', direction: 'pull' }],

  isConfigured(env = process.env) {
    return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
  },

  async pullMessages(ctx: AdapterContext): Promise<PullResult<NormalizedMessage>> {
    if (!ctx.credentials) {
      return { items: [], cursor: null, errors: ['Gmail is not connected yet.'] };
    }
    // TODO(keys): list messages after ctx.since via the Gmail API, map each
    // → NormalizedMessage (from/subject/snippet/receivedAt), classify category.
    return { items: [], cursor: ctx.since ?? null, errors: [] };
  },
};
