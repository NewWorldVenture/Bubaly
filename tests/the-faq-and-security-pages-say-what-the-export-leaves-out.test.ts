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
// N5-S1-sibling-ledger: /security said it twice more. Its trust ledger row
// (trustCenter.rowExport, rendered by <TrustLedger />) offered "Export your
// family's data anytime", and its "We give you control" commitment
// (security.commitControlDetail) had the data "exported ... on request",
// though export is self-serve and only account deletion is on request
// (lib/marketing/trust-ledger.ts). Both now name what the export covers — the
// modules listed in Settings → Privacy — and put "on request" on deletion only.
//
// The REAL /faq and /security pages are rendered, the real trust ledger
// included, through the real request translator, in each language; only the
// request's locale cookie, the Knowledge Center and public-stats reads, and the
// sections that read the database on their own are stood in for.
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

/** /security's trust ledger row for export and deletion, and its "We give you control" commitment. */
async function securityLedgerIn(locale: LocaleCode): Promise<{ row: string; commitment: string }> {
  const html = await renderIn(locale, SecurityPage);
  const row = html.match(/<li[^>]*id="ledger-export_delete"[^>]*>([\s\S]*?)<\/li>/);
  expect(row, `${locale} /security ledger row`).not.toBeNull();
  const heading = escaped(translate(getMessages(locale), 'security.commitControl'));
  const at = html.indexOf(`>${heading}</p>`);
  expect(at, `${locale} /security control commitment`).toBeGreaterThan(-1);
  const detail = html.slice(at + heading.length + 5).match(/<p[^>]*>([\s\S]*?)<\/p>/);
  return { row: plain(row![1]), commitment: plain(detail![1]) };
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
// The ledger row and the commitment, as each catalogue had them.
const OLD_LEDGER_ROW: Record<string, string> = {
  'en-US': "Export your family's data anytime",
  'de-DE': 'Daten Ihrer Familie jederzeit exportieren',
  'es-ES': 'Exporta los datos de tu familia cuando quieras',
  'fr-FR': 'Exporter les données de votre famille à tout moment',
  'it-IT': 'Esporta i dati della tua famiglia quando vuoi',
  'nl-NL': 'De gegevens van je gezin altijd exporteren',
  'pt-PT': 'Exporte os dados da sua família quando quiser',
};
const OLD_COMMITMENT: Record<string, string> = {
  'en-US': 'your data exported or deleted on request',
  'de-DE': 'Ihre Daten auf Anfrage exportiert oder gelöscht',
  'es-ES': 'tus datos exportados o eliminados a petición',
  'fr-FR': 'vos données exportées ou supprimées sur demande',
  'it-IT': 'i tuoi dati esportati o eliminati su richiesta',
  'nl-NL': 'je gegevens op verzoek geëxporteerd of verwijderd',
  'pt-PT': 'os seus dados exportados ou eliminados a pedido',
};
// Where the export's coverage is listed, as each catalogue names the screen
// (the same words its security.controlExportBody uses).
const COVERAGE_SCREEN: Record<string, string> = {
  'en-US': 'Settings → Privacy',
  'de-DE': 'Einstellungen → Datenschutz',
  'es-ES': 'Ajustes → Privacidad',
  'fr-FR': 'Réglages → Confidentialité',
  'it-IT': 'Impostazioni → Privacy',
  'nl-NL': 'Instellingen → Privacy',
  'pt-PT': 'Definições → Privacidade',
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

describe('/security, the trust ledger\'s export row and the "We give you control" commitment', () => {
  it('in English, say the export covers the modules listed in Settings → Privacy, and only deletion is on request', async () => {
    const { row, commitment } = await securityLedgerIn('en-US');
    expect(row).toContain('Export the modules listed in Settings → Privacy anytime; delete your account on request');
    expect(commitment).toBe('Roles per member, a download of the modules listed in Settings → Privacy whenever you like, and account deletion on request.');
  });

  it.each(LOCALES)('in %s, no longer offer the family\'s data unqualified, and name where the coverage is listed', async (locale) => {
    const { row, commitment } = await securityLedgerIn(locale);
    expect(row, `${locale} ledger row`).not.toContain(OLD_LEDGER_ROW[locale]);
    expect(commitment, `${locale} commitment`).not.toContain(OLD_COMMITMENT[locale]);
    for (const text of [row, commitment]) expect(text, locale).toContain(COVERAGE_SCREEN[locale]);
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
