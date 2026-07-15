// Gmail sync adapter (moat R9) — planned contract implementation.
// It remains explicitly unavailable until the real Gmail API wiring lands.

import type {
  SyncAdapter, AdapterContext, PullResult, NormalizedMessage,
} from '../adapter';

export const gmailAdapter: SyncAdapter = {
  providerId: 'gmail',
  category: 'email',
  isImplemented: false,
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
    return { items: [], cursor: null, errors: ['Gmail sync is not available yet.'] };
  },
};
