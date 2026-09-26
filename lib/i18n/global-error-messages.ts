// lib/i18n/global-error-messages.ts — the four strings app/global-error.tsx can
// still render when nothing else on the page worked.
//
// `global-error.tsx` is the boundary for an error thrown in the ROOT LAYOUT.
// Next.js replaces the whole document with it, which means `app/layout.tsx` —
// the only thing that mounts a LocaleProvider — never ran. So that component
// has never had a provider, in any locale, and its `t()` calls were resolving
// through `translate`'s English fallback: already English-only for every
// visitor, always, and nobody could have noticed.
//
// `lib/i18n/translate.ts` removes that fallback so the catalogue stops shipping
// to the browser. The honest consequence is that the last-resort error page
// would render `globalError.somethingWentWrong` at a person whose session has
// just broken, so it gets an explicit source of its own — four keys, copied
// from en-US.json, and nothing else.
//
// Copied, therefore drift-prone, therefore pinned: tests/global-error-copy-
// matches-the-catalogue.test.ts requires every value here to equal en-US's,
// and fails naming the key if a copy edit reaches one and not the other.
//
// It is deliberately NOT localised. The alternative is shipping a catalogue to
// the one page that exists because the app is already broken, which is the cost
// this whole change exists to remove. A reader whose session has failed gets
// English and a working "Try again"; that is the trade, and it is written down
// rather than left to be inferred.
import type { Messages } from '@/lib/i18n/translate';

export const GLOBAL_ERROR_MESSAGES: Messages = {
  'globalError.somethingWentWrong': 'Something went wrong',
  'globalError.bubalyHitAnUnexpectedErrorYour':
    'Bubaly hit an unexpected error. Your data is safe. Try again, or reload the app.',
  'globalError.tryAgain': 'Try again',
  'globalError.reloadBubaly': 'Reload Bubaly',
};
