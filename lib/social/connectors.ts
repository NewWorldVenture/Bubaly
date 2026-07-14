// lib/social/connectors.ts
// The publish boundary. A connector turns a validated variant into a real call to
// a platform's API. This file is deliberately HONEST: a connector only ever
// returns status 'published' when a provider API actually confirms the post.
//
// Until a platform has BOTH (a) configured app credentials in the environment and
// (b) a live API implementation wired here, its connector returns a truthful
// non-success outcome:
//   - 'requires_setup'  → app credentials are missing (most common in dev)
//   - 'not_implemented' → credentials exist but the live call isn't wired yet
// The publish pipeline records these exactly as returned; nothing is marked
// published on a guess. Real per-platform implementations slot into LIVE_IMPLS.
import 'server-only';
import {
  isProviderConfigured, type SocialPlatform,
} from './capabilities';
import type { TargetStatus } from './content';

export type ConnectorPublishInput = {
  platform: SocialPlatform;
  providerAccountId: string | null;
  body: string;
  link?: string | null;
  mediaUrls: string[];
};

export type ConnectorPublishOutput = {
  /** Whether the provider CONFIRMED the post. Only true for a real success. */
  ok: boolean;
  status: TargetStatus;
  providerObjectId?: string | null;
  permalinkUrl?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  /** Raw provider payload, for the publish-result audit row. */
  raw?: Record<string, unknown>;
};

export type Connector = {
  platform: SocialPlatform;
  publish: (input: ConnectorPublishInput) => Promise<ConnectorPublishOutput>;
};

/**
 * Live per-platform publishers. EMPTY by default — wiring a real implementation
 * here (one that performs the OAuth-authenticated API call and returns the
 * provider's post id + permalink) is the ONLY way a platform starts returning
 * confirmed 'published' results. Adding a key without a genuine API call would
 * break the project's core honesty guarantee — don't.
 */
type LiveImpl = (input: ConnectorPublishInput, creds: NodeJS.ProcessEnv) => Promise<ConnectorPublishOutput>;
const LIVE_IMPLS: Partial<Record<SocialPlatform, LiveImpl>> = {
  // e.g. reddit: async (input, env) => { ...real submit, return confirmed id... }
};

function makeConnector(platform: SocialPlatform): Connector {
  return {
    platform,
    async publish(input) {
      if (!isProviderConfigured(platform)) {
        return {
          ok: false,
          status: 'skipped',
          errorCode: 'requires_setup',
          errorMessage:
            `${platform} is not configured: add this platform's app credentials to the environment to enable live publishing.`,
        };
      }
      const impl = LIVE_IMPLS[platform];
      if (!impl) {
        return {
          ok: false,
          status: 'failed',
          errorCode: 'not_implemented',
          errorMessage:
            `${platform} credentials are present but the live publishing call is not yet wired. No post was created.`,
        };
      }
      try {
        return await impl(input, process.env);
      } catch (err) {
        console.error(`[social-publish] ${platform} connector failed`, err);
        return {
          ok: false,
          status: 'failed',
          errorCode: 'provider_error',
          errorMessage: 'The provider could not confirm this post. Review the result and try again later.',
        };
      }
    },
  };
}

export function getConnector(platform: SocialPlatform): Connector {
  return makeConnector(platform);
}
