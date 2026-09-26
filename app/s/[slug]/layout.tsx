// The public survey at /s/<slug> is the only page in the tree that had no
// layout of its own, so the root layout's ROOT_CHROME_SCOPE was all that
// reached it while `survey-form.tsx` asks for `surveyForm.*` and
// `sSurveyForm.*`. Those resolved through `translate`'s SOURCE_MESSAGES
// fallback — the one PERF-001 proposes to delete — on an unauthenticated page
// sent to people who are not customers. See lib/i18n/scopes.ts.
import { ScopedLocaleProvider } from '@/components/i18n/scoped-locale-provider';
import { SURVEY_SCOPE } from '@/lib/i18n/scopes';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <ScopedLocaleProvider namespaces={SURVEY_SCOPE}>{children}</ScopedLocaleProvider>;
}
