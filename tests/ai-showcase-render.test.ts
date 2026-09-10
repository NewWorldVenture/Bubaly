import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiActionDemo } from '@/components/marketing/ai-showcase';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault } from '@/lib/i18n/locales';

const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const PROMPTS = [
  'aiShowcase.addSoccerPracticeEveryTuesday', 'aiShowcase.planDinnersForThisWeek',
  'aiShowcase.buildAGroceryListFrom', 'aiShowcase.giveTheKidsAgeAppropriate',
  'aiShowcase.remindUsToChangeThe', 'aiShowcase.howAreWeDoingOn',
];

describe('the public assistant demo renders readable prompts', () => {
  it.each(LOCALES)('translates every prompt and the active message in %s', (locale) => {
    const messages = getMessages(locale);
    const html = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: localeOrDefault(locale), source: 'cookie', messages,
    } as Parameters<typeof LocaleProvider>[0], createElement(AiActionDemo)));
    const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(match => match[1]);
    expect(buttons).toHaveLength(6);
    PROMPTS.forEach((key, index) => {
      const message = translate(messages, key);
      expect(message).not.toBe(key);
      const escaped = renderToStaticMarkup(createElement('span', null, message)).replace(/^<span>|<\/span>$/g, '');
      expect(buttons[index]).toContain(escaped);
      // The selected first prompt appears again as the user's chat message.
      expect(html.split(escaped).length - 1).toBe(index === 0 ? 2 : 1);
    });
    expect(html).not.toContain('aiShowcase.');
  });
});
