// The FAQ and the Trust Center say what the export leaves out, as the privacy
// policy now does (N5-S1, the sibling pages).
//
// The policy's "your rights" line was reworded (see
// tests/the-privacy-policy-says-what-the-export-leaves-out.test.ts), but two
// public pages still made the claim it dropped: /faq answered "can I download
// my family's data?" with a JSON export "of everything your role can see", and
// /security offered "a copy of your family's data". The export leaves health,
// journal, locations and the other modules in lib/privacy/export-coverage.ts
// out. Both now say what the policy says — the file covers the modules listed
// in Settings → Privacy and names the ones it does not include — in every base
// catalogue, and both pages' revision dates moved with their copy.
//
// The REAL /faq and /security pages are rendered, through the real request
// translator, in each language; only the request's locale cookie, the
// Knowledge Center and public-stats reads, and the sections that read the
// database on their own are stood in for.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import { PAGE_REVISED, staticRevision } from '@/lib/marketing/content-revisions';

const state = vi.hoisted(() => ({ locale: 'en-US' }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'bubaly-locale' ? { value: state.locale } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children) }));
vi.mock('@/lib/marketing/seo', () => ({ resolveMarketingMetadata: vi.fn() }));
// No Knowledge Center answers: the page renders its own core FAQ only.
vi.mock('@/lib/marketing/aeo', () => ({
  readPublishedAeoQuestionsCached: async () => ({ available: true, questions: [] }),
  localizeAeoQuestions: async () => [],
}));
vi.mock('@/lib/marketing/stats', () => ({
  getPublicStats: async () => ({ families: 0, members: 0, tasksCompleted: 0, handledCompleted: 0, handled30d: 0, familiesWithRuns: 0 }),
}));
vi.mock('@/components/marketing/marketing-aeo-section', () => ({ MarketingAeoSection: () => null }));
vi.mock('@/components/marketing/trust-ledger', () => ({ TrustLedger: () => null }));
vi.mock('@/components/marketing/cta', () => ({ CTASection: () => null }));

const { default: FAQPage } = await import('@/app/(marketing)/faq/page');
const { default: SecurityPage } = await import('@/app/(marketing)/security/page');

/** Await the async server components; leave the rest (client ones included) to the renderer. */
async function resolveServer(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((child) => resolveServer(child)));
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  const { type, props } = node as ReactElement<Record<string, unknown>>;
  if (typeof type === 'function' && type.constructor.name === 'AsyncFunction') {
    return resolveServer(await (type as (p: unknown) => Promise<ReactNode>)(props));
  }
  if (props.children === undefined) return node;
  return createElement(type as string, { ...props, key: node.key }, await resolveServer(props.children as ReactNode));
}

async function renderIn(locale: LocaleCode, page: () => Promise<ReactNode>): Promise<string> {
  state.locale = locale;
  const tree = await resolveServer(await page());
  return renderToStaticMarkup(createElement(LocaleProvider, {
    locale: localeOrDefault(locale), source: 'cookie', messages: getMessages(locale),
  } as Parameters<typeof LocaleProvider>[0], tree));
}

const plain = (html: string) => html.replace(/<[^>]+>/g, ' ')
  .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const escaped = (text: string) => renderToStaticMarkup(createElement('span', null, text)).replace(/^<span>|<\/span>$/g, '');

/** /faq's "Can I download or delete my family's data?" — as read on the page, and as told to search engines. */
async function faqAnswerIn(locale: LocaleCode): Promise<{ page: string; shown: string; schema: string }> {
  const html = await renderIn(locale, FAQPage);
  const details = html.match(/<details[^>]*id="export-or-delete"[^>]*>([\s\S]*?)<\/details>/);
  expect(details, `${locale} /faq export answer`).not.toBeNull();
  const question = translate(getMessages(locale), 'faq.exportDeleteQ');
  const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1]) as { '@type'?: string; mainEntity?: { name: string; acceptedAnswer: { text: string } }[] });
  const faq = schemas.find((s) => s['@type'] === 'FAQPage');
  const entry = faq?.mainEntity?.find((q) => q.name === question);
  expect(entry, `${locale} FAQPage entry`).toBeTruthy();
  return { page: plain(html), shown: plain(details![1]), schema: entry!.acceptedAnswer.text };
}

/** /security's "Export anytime, delete on request" control. */
async function securityControlIn(locale: LocaleCode): Promise<{ page: string; body: string }> {
  const html = await renderIn(locale, SecurityPage);
  const title = escaped(translate(getMessages(locale), 'security.controlExportTitle'));
  const at = html.indexOf(`>${title}</h3>`);
  expect(at, `${locale} /security export control`).toBeGreaterThan(-1);
  const body = html.slice(at).match(/<p[^>]*>([\s\S]*?)<\/p>/);
  return { page: plain(html), body: plain(body![1]) };
}

// What each catalogue said before.
const OLD_FAQ: Record<string, string> = {
  'en-US': 'everything your role can see',
  'de-DE': 'mit allem herunter, was Ihre Rolle sehen kann',
  'es-ES': 'de todo lo que tu rol puede ver',
  'fr-FR': 'de tout ce que votre rôle peut voir',
  'it-IT': 'di tutto ciò che il tuo ruolo può vedere',
  'nl-NL': 'van alles wat jouw rol kan zien',
  'pt-PT': 'de tudo o que o seu papel pode ver',
};
const OLD_SECURITY: Record<string, string> = {
  'en-US': "a copy of your family's data",
  'de-DE': 'eine Kopie der Daten Ihrer Familie',
  'es-ES': 'una copia de los datos de tu familia',
  'fr-FR': 'une copie des données de votre famille',
  'it-IT': 'una copia dei dati della tua famiglia',
  'nl-NL': 'een kopie van de gegevens van je gezin',
  'pt-PT': 'uma cópia dos dados da sua família',
};
// The words for "health" and "journal", which both pages must now name as left out.
const LEFT_OUT: Record<string, [string, string]> = {
  'en-US': ['health', 'journal'],
  'de-DE': ['Gesundheit', 'Tagebuch'],
  'es-ES': ['salud', 'diario'],
  'fr-FR': ['santé', 'journal'],
  'it-IT': ['salute', 'diario'],
  'nl-NL': ['gezondheid', 'dagboek'],
  'pt-PT': ['saúde', 'diário'],
};
const LOCALES = Object.keys(OLD_FAQ) as LocaleCode[];
const COVERAGE_EN = 'It covers the modules listed there, and the file itself names the ones it does not include yet, such as health, journal and locations.';

describe('/faq, "Can I download or delete my family\'s data?"', () => {
  it('in English, says the file covers the listed modules and names what it leaves out', async () => {
    const { page, shown, schema } = await faqAnswerIn('en-US');
    expect(schema).toBe("Yes. In Settings → Privacy you can download a JSON file of your family's data whenever you like. " + COVERAGE_EN
      + " Individual items and a member's profile can be deleted in the app. To delete the whole account, tell us — a person confirms"
      + ' with you before anything is removed, and Bubaly never deletes a family silently.');
    expect(shown).toContain(schema);
    expect(page).not.toContain(OLD_FAQ['en-US']);
  });

  it.each(LOCALES)('in %s, no longer promises everything, and names what is left out — on the page and in its FAQPage data', async (locale) => {
    const { page, shown, schema } = await faqAnswerIn(locale);
    expect(page).not.toContain(OLD_FAQ[locale]);
    for (const text of [shown, schema]) {
      expect(text).not.toContain(OLD_FAQ[locale]);
      for (const word of LEFT_OUT[locale]) expect(text, `${locale} ${word}`).toContain(word);
    }
  });
});

describe('/security, "Export anytime, delete on request"', () => {
  it('in English, says the file covers the listed modules and names what it leaves out', async () => {
    const { page, body } = await securityControlIn('en-US');
    expect(body).toBe("Download a file of your family's data from Settings → Privacy whenever you like. " + COVERAGE_EN
      + " Delete individual items or a member's profile in the app, or ask us to delete your whole account.");
    expect(page).not.toContain("Download a copy of your family's data");
  });

  it.each(LOCALES)('in %s, no longer promises a plain copy, and names what is left out', async (locale) => {
    const { page, body } = await securityControlIn(locale);
    expect(page).not.toContain(OLD_SECURITY[locale]);
    for (const word of LEFT_OUT[locale]) expect(body, `${locale} ${word}`).toContain(word);
  });
});

describe('the two pages\' revision dates', () => {
  // content-revisions.ts: editing a page's copy means editing its date there,
  // so the sitemap's lastmod does not claim the old wording is current.
  it.each(['/faq', '/security'] as const)('%s is dated no earlier than this copy change', (path) => {
    expect(PAGE_REVISED[path] >= '2026-10-23', `${path} is dated ${PAGE_REVISED[path]}`).toBe(true);
    expect(staticRevision(path)!.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-10-23T00:00:00.000Z'));
  });
});
