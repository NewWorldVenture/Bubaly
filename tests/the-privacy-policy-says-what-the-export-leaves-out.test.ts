// The privacy policy says what the export covers and what it leaves out (N5-S1).
//
// The export file carries `notIncluded` and the Privacy Center says so under
// the button, but the policy's "your rights" list still promised "a copy of
// your family's data" — the line the finding quoted — although the file leaves
// health, journal, locations and the other modules in lib/privacy/export-
// coverage.ts out. The policy now says the export covers the modules listed in
// Settings → Privacy and that the file names the ones it does not include, in
// every base catalogue.
//
// The REAL privacy page is rendered, through the real request translator, in
// each language; only the request's locale cookie, the sitemap's structured-
// data block and the closing call to action are stood in for.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ locale: 'en-US' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'bubaly-locale' ? { value: state.locale } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children) }));
vi.mock('@/components/marketing/marketing-aeo-section', () => ({ MarketingAeoSection: () => null }));
vi.mock('@/components/marketing/cta', () => ({ CTASection: () => null }));

const { default: PrivacyPage } = await import('@/app/(marketing)/privacy/page');

/** Call the server components down to plain elements. */
async function resolveServer(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((child) => resolveServer(child)));
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  const { type, props } = node as ReactElement<Record<string, unknown>>;
  if (typeof type === 'function') return resolveServer(await (type as (p: unknown) => ReactNode | Promise<ReactNode>)(props));
  const { children, ...rest } = props;
  if (children === undefined) return node;
  return createElement(type as string, rest, await resolveServer(children as ReactNode));
}

const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();

/** The rendered policy, and its "your rights" line about the export. */
async function policyIn(locale: string): Promise<{ policy: string; exportLine: string }> {
  state.locale = locale;
  const html = renderToStaticMarkup(createElement('div', null, await resolveServer(await PrivacyPage())));
  const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => plain(m[1]));
  const exportLines = items.filter((item) => /^E[xs]port/.test(item));
  expect(exportLines, locale).toHaveLength(1);
  return { policy: plain(html), exportLine: exportLines[0] };
}

// What each catalogue's "your rights" line said before: a copy of the family's data, full stop.
const OLD_PROMISE: Record<string, string> = {
  'en-US': "download a copy of your family's data from Settings → Privacy.",
  'de-DE': 'eine Kopie der Daten Ihrer Familie unter Einstellungen → Datenschutz herunterladen.',
  'es-ES': 'descargar una copia de los datos de tu familia desde Ajustes → Privacidad.',
  'fr-FR': 'télécharger une copie des données de votre famille depuis Réglages → Confidentialité.',
  'it-IT': 'scaricare una copia dei dati della tua famiglia da Impostazioni → Privacy.',
  'nl-NL': 'een kopie van de gegevens van je gezin downloaden via Instellingen → Privacy.',
  'pt-PT': 'transferir uma cópia dos dados da sua família em Definições → Privacidade.',
};

// The words for "health" and "journal", which the line must now name as left out.
const LEFT_OUT: Record<string, [string, string]> = {
  'en-US': ['health', 'journal'],
  'de-DE': ['Gesundheit', 'Tagebuch'],
  'es-ES': ['salud', 'diario'],
  'fr-FR': ['santé', 'journal'],
  'it-IT': ['salute', 'diario'],
  'nl-NL': ['gezondheid', 'dagboek'],
  'pt-PT': ['saúde', 'diário'],
};

describe('/privacy, "your rights"', () => {
  it('in English, says the export covers the listed modules and the file names what it leaves out', async () => {
    const { policy, exportLine } = await policyIn('en-US');
    expect(exportLine).toBe('Export — download a file of your family\'s data from Settings → Privacy. It covers the modules listed there, '
      + 'and the file itself names the ones it does not include yet, such as health, journal and locations.');
    expect(policy).not.toContain("a copy of your family's data");
  });

  it.each(Object.keys(OLD_PROMISE))('in %s, no longer promises a plain copy, and names what is left out', async (locale) => {
    const { policy, exportLine } = await policyIn(locale);
    expect(policy).not.toContain(OLD_PROMISE[locale]);
    for (const word of LEFT_OUT[locale]) expect(exportLine).toContain(word);
  });
});
