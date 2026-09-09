'use client';

// components/display/ask-tile.tsx — "Ask Bubaly" on the kitchen wall.
//
// This tile deliberately adds NO new request path. It mounts the same
// <AskBubaly> component Home and the dashboard mount, which posts to
// /api/ai/requests and lands the person on the run page — so a request spoken
// at the counter goes through the identical intake, the identical planner and
// the identical approval spine as one typed on a phone. Nothing the wall says
// is auto-executed, because the wall has no way to execute anything: it files a
// request like every other surface.
//
// The mic is the shared one too (MicButton → useSpeechRecognition, inside
// AskBubaly), which is what makes the display hands-free without a second
// speech implementation to keep honest.

import { AskBubaly } from '@/components/concierge/ask-bubaly';
import { useTranslations } from '@/components/i18n/locale-provider';

export function AskTile() {
  const t = useTranslations();
  return (
    <div className="flex h-full min-h-0 flex-col justify-center">
      {/* `compact` is the single-row form: input, mic, submit. The hero form's
          heading and prompt chips do not fit a tile and would push the input
          off a small one. */}
      <AskBubaly variant="compact" className="display-ask" />
      <p className="mt-2 text-[11px] text-white/40">{t('displayAsk.everythingIsPreviewed')}</p>
    </div>
  );
}
