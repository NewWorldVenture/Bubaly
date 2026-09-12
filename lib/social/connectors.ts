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
import { publishX } from './providers/x';
import { getTranslations } from '@/lib/i18n/server';

export type ConnectorPublishInput = {
  platform: SocialPlatform;
  providerAccountId: string | null;
  body: string;
  link?: string | null;
  mediaUrls: string[];
  familyId?: string;
  accountId?: string;
  userId?: string | null;
  kind?: string;
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
 * Live per-platform publishers. Wiring a real implementation
 * here (one that performs the OAuth-authenticated API call and returns the
 * provider's post id + permalink) is the ONLY way a platform starts returning
 * confirmed 'published' results. Adding a key without a genuine API call would
 * break the project's core honesty guarantee — don't.
 */
type LiveImpl = (input: ConnectorPublishInput, creds: NodeJS.ProcessEnv) => Promise<ConnectorPublishOutput>;
const LIVE_IMPLS: Partial<Record<SocialPlatform, LiveImpl>> = {
  x: publishX,
};

function makeConnector(platform: SocialPlatform): Connector {
  return {
    platform,
    async publish(input) {
      if (!isProviderConfigured(platform)) {
        const t = platform === 'x' ? await getTranslations() : null;
        return {
          ok: false,
          status: 'skipped',
          errorCode: 'requires_setup',
          errorMessage:
            t ? t('socialX.setupRequired') : `${platform} is not configured: add this platform's app credentials to the environment to enable live publishing.`,
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
      } catch {
        // Even an unexpected exception can follow provider acceptance. Never
        // expose exception details (which may contain tokens) or invite a retry.
        const t = await getTranslations();
        return {
          ok: false,
          status: 'publishing',
          errorCode: 'confirmation_unknown',
          errorMessage: t('socialX.publishUnknown'),
        };
      }
    },
  };
}

export function getConnector(platform: SocialPlatform): Connector {
  return makeConnector(platform);
}
