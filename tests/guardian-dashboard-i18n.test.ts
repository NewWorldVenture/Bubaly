import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault } from '@/lib/i18n/locales';

// I18N-002. The Guardian dashboard drew its status contexts ("Do Not
// Disturb"), its call statuses ("Escalated"), its stat tiles ("Scams
// Stopped") and its "{name}'s Status" heading from English constants, and
// built two toasts from English templates, so a family reading German saw a
// German page with an English control panel in the middle of it.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/app/(app)/guardian/actions', () => ({
  updateContextAction: vi.fn(), reviewSuggestionAction: vi.fn(),
  acknowledgeEscalationAction: vi.fn(), generateGuardianSuggestionsAction: vi.fn(),
}));

const { GuardianDashboard } = await import('@/components/guardian/guardian-dashboard');

const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;

const ENGLISH_LABELS = ['Do Not Disturb', 'In a Meeting', 'Calls Today', 'Scams Stopped', 'AI Screened', 'Escalated', '’s Status', "'s Status"];

function render(locale: string, comms: unknown[] = []) {
  return renderToStaticMarkup(createElement(LocaleProvider, {
    locale: localeOrDefault(locale), source: 'cookie', messages: getMessages(locale as never),
  } as Parameters<typeof LocaleProvider>[0], createElement(GuardianDashboard, {
    recentComms: comms as never, suggestions: [], escalations: [],
    memberProfiles: [{ id: 'p1', member_id: 'm1', ai_persona_name: 'Ada', current_context: 'normal' }] as never,
    stats: { totalCalls: 3, blockedToday: 1, scamsBlocked: 1, screened: 2 },
    isTwilioConfigured: true,
  })));
}

describe('the Guardian dashboard speaks the family\'s language', () => {
  it('renders every context, stat and heading from the German catalogue', () => {
    const html = render('de-DE');
    const de = (key: string, params?: Record<string, string>) =>
      renderToStaticMarkup(createElement('b', null, translate(getMessages('de-DE'), key, params))).replace(/^<b>|<\/b>$/g, '');
    for (const key of ['contextDoNotDisturb', 'contextMeeting', 'statCallsToday', 'statScamsStopped', 'statAiScreened']) {
      expect(html).toContain(de(`guardianDashboard.${key}`));
    }
    expect(html).toContain(de('guardianDashboard.personaStatus', { name: 'Ada' }));
    for (const english of ENGLISH_LABELS) expect(html, english).not.toContain(english);
  });

  it.each(LOCALES.filter((l) => l !== 'en-US'))('leaves no English label or raw key in %s', (locale) => {
    const html = render(locale);
    for (const english of ['Do Not Disturb', 'Calls Today', 'Scams Stopped']) expect(html, english).not.toContain(english);
    expect(html).not.toMatch(/guardianDashboard\.[a-zA-Z]+/);
  });
});
