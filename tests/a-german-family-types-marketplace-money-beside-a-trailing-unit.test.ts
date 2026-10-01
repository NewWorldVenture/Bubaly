// A German family types marketplace money beside a trailing unit (I18N-003).
//
// THE GAP THIS CLOSES. tests/a-german-bidder-reads-marketplace-money-in-their-
// own-format.test.ts renders the marketplace as a de-DE reader — but only what is
// on screen BEFORE a click. Three of the four money inputs, and Quick Post's price
// suggestion, are not: the offer box opens on "Make an offer", the counter box on
// "Counter", and Quick Post's whole draft (its price box and the suggestion) on
// "Draft it". So reverting components/marketplace/quick-post.tsx to its old
// `left-3` "$" and `{t('quickPost.aiSuggests')}{suggested / 100}` — which read
// "KI schlägt vor: $40" to a German family and "AI stelt $ voor40" to a Dutch one
// — left every test green, and so did reverting the two boxes in
// components/marketplace/negotiation-panel.tsx.
//
// HOW IT REACHES THE CLICK. There is no DOM here (the suite runs in node), so, as
// tests/health-localization.test.ts and tests/a-rebuilt-graph-is-on-screen-before-
// the-toast-says-so.test.ts do, React's hooks are replaced with a slot store and
// the components are called as functions: the tree is expanded, the button's
// onClick is invoked, and the tree is expanded again with the state kept.
// `renderToStaticMarkup` then gives the markup a reader would get, so the
// assertions are on the same HTML strings the first file checks.
//
// WHAT IS PROVED, for en-US and each of the six translated locales: the unit
// beside every box is the symbol the reader's own Intl prints for the marketplace
// currency, on the side Intl puts it — "$" trailing in de-DE, "$US" trailing in
// fr-FR, "US$" LEADING in nl-NL, "$" leading in en-US — with the input padded on
// that side; and the sentences around the boxes are that catalogue's OWN words
// with the amount inside them, never an English fragment or a symbol typed by
// hand. The oracle for the unit is the formatted amount itself, not the hook
// that positions it.
//
// RED UNTIL THE CATALOGUE MERGE LANDS, like the first file: the sentences it
// checks are in scratchpad/i18n-asks/marketplace.json and reach
// lib/i18n/messages/*.json in the orchestrator's merge, translated.
import { Fragment, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALES, type LocaleCode } from '@/lib/i18n/locales';
import { getMessages, getRawMessages, PLACEHOLDER_LOCALES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { formatCents, MARKETPLACE_CURRENCY } from '@/lib/marketplace/listings';
import { createFormat } from '@/lib/utils/format';

const h = vi.hoisted(() => {
  /** A Supabase query: every builder call returns the builder, and awaiting it
   *  resolves the rows planted for that table. */
  const query = (result: { data: unknown; error: unknown }): object => {
    const builder: object = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return () => builder;
      },
    });
    return builder;
  };
  return {
    locale: 'de-DE' as LocaleCode,
    cursor: 0,
    slots: [] as unknown[],
    effects: [] as (() => void | (() => void))[],
    cleanups: [] as (() => void)[],
    tables: {} as Record<string, { data: unknown; error: unknown }>,
    query,
  };
});

// Hooks become a slot store, so a component can be called as a function and
// called again after a click with its state intact. Only what these components
// reach is replaced; everything else is React's own.
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  const slot = (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return index;
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = slot(initial);
      return [h.slots[index], (next: unknown) => {
        h.slots[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(h.slots[index]) : next;
      }];
    },
    useRef: (initial: unknown) => h.slots[slot({ current: initial })],
    useMemo: (make: () => unknown) => make(),
    useCallback: (callback: unknown) => callback,
    // This fixture expands a server-rendered tree. Actual React hydration and
    // its browser snapshot transition are covered by format-hydration.spec.ts.
    useSyncExternalStore: (_subscribe: unknown, _getSnapshot: () => unknown, getServerSnapshot: () => unknown) => getServerSnapshot(),
    useEffect: (effect: () => void | (() => void)) => { h.effects.push(effect); },
    useTransition: () => [false, (work: () => unknown) => { void work(); }],
  };
});
// The reader: the provider's two hooks, over the REAL catalogues.
vi.mock('@/components/i18n/locale-provider', async () => {
  const { getMessages: messages } = await import('@/lib/i18n/messages');
  const { translate: lookup } = await import('@/lib/i18n/translate');
  const { localeOrDefault: resolve } = await import('@/lib/i18n/locales');
  return { useFamilyTimeZone: () => undefined,
    useLocale: () => resolve(h.locale),
    useTranslations: () => (key: string, params?: Record<string, string | number>) => lookup(messages(h.locale), key, params),
  };
});
// Only the I/O boundaries are replaced: the app shell, the database, the router
// and toasts. The server actions behind Send / Accept / Counter are never reached
// — the boxes are opened here, not submitted.
vi.mock('@/components/app/app-context', () => ({
  useApp: () => ({ familyId: 'fam-1', userId: 'u-1', selfMember: { id: 'm-self' } }),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ from: (table: string) => h.query(h.tables[table] ?? { data: [], error: null }) }),
}));
vi.mock('@/app/(app)/marketplace/negotiations/actions', () => ({ makeOfferAction: vi.fn(), respondToOfferAction: vi.fn() }));

import { NegotiationPanel, type Thread } from '@/components/marketplace/negotiation-panel';
import { QuickPost } from '@/components/marketplace/quick-post';

type Node = ReactElement<Record<string, unknown>>;

/** Every component expanded in place — the tree a reader's screen is built from. */
function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  if (typeof node.type === 'function') return expand((node.type as (props: unknown) => ReactNode)(node.props));
  const children = node.props.children as ReactNode;
  return createElement(node.type, { ...node.props, key: node.key }, ...(Array.isArray(children) ? children.map(expand) : [expand(children)]));
}
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
/** One render: the tree, then its effects — after the last render's cleanups,
 *  as React would, so Quick Post's stopwatch interval does not pile up. */
function render(element: ReactElement): ReactNode {
  h.cursor = 0;
  h.cleanups.splice(0).forEach((cleanup) => cleanup());
  const tree = expand(element);
  for (const effect of h.effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === 'function') h.cleanups.push(cleanup);
  }
  return tree;
}
const html = (tree: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, tree));
/** The text a reader sees: static markup escapes quotes and ampersands. */
const visible = (markup: string) => markup
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** Let an effect's awaited read resolve. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function button(tree: ReactNode, label: string): Node {
  const found = nodes(tree).find((node) => node.type === 'button' && text(node).trim() === label);
  if (!found) throw new Error(`No button reads "${label}"`);
  return found;
}
const click = (node: Node) => (node.props.onClick as () => void)();

/** The current reader's catalogue, as the provider hands it to the components. */
const t = (key: string, params?: Record<string, string | number>) => translate(getMessages(h.locale), key, params);
const EN_OWN = getRawMessages('en-US');
/**
 * The sentence a reader of `code` must see for `key`: that catalogue's OWN
 * translation, from the file as written. A key the catalogue lacks would still
 * resolve — to English, through getMessages — and a key English lacks renders as
 * itself; either way an assertion built from the same lookup would pass around
 * the wrong words, so the presence is checked here first.
 */
function own(code: LocaleCode, key: string, params: Record<string, string | number>): string {
  const catalogue = getRawMessages(code);
  expect(catalogue[key], `${key} is missing from ${code}.json`).toBeDefined();
  if (code !== 'en-US') expect(catalogue[key], `${key} is still the English sentence in ${code}.json`).not.toBe(EN_OWN[key]);
  return translate(catalogue, key, params);
}
/** An offer, to the cent, as the panel prints it. */
const money = (cents: number, code: LocaleCode) => createFormat(code).fmtMoney(cents, MARKETPLACE_CURRENCY);
/** A catalogue key rendered as itself — what every reader gets while one is missing. */
function expectNoRawKey(markup: string) {
  expect(markup).not.toMatch(/\b(?:negotiation|negotiationPanel|quickPost|listings)\.[a-z]\w*/);
}

/** Every money box on screen: the unit beside it, its side, and the input's padding. */
function boxes(markup: string): { symbol: string; side: string; padLeft: number; padRight: number }[] {
  const box = /<span class="pointer-events-none[^"]*\b(left-3|right-3)\b[^"]*">([^<]+)<\/span><input[^>]*class="[^"]*\bpl-(\d+)\b[^"]*\bpr-(\d+)\b[^"]*"/g;
  return [...markup.matchAll(box)].map(([, side, symbol, pl, pr]) => ({ side, symbol, padLeft: Number(pl), padRight: Number(pr) }));
}
/**
 * The unit must be the symbol the reader's Intl prints, on the side Intl prints
 * it, with the input's room on that side. The oracle is the formatted AMOUNT —
 * "40 $", "US$ 40", "40 $US", "$40" — not the hook that positions the span, so a
 * box that disagreed with the price printed above it would fail here.
 */
function expectUnit(box: ReturnType<typeof boxes>[number] | undefined, code: LocaleCode) {
  const amount = formatCents(4000, code);
  const symbol = amount.replace(/[\d.,\s]/g, '');
  const leads = amount.startsWith(symbol);
  expect(box, 'a money box with its unit beside it').toBeDefined();
  expect(box!.symbol).toBe(symbol);
  expect(box!.side).toBe(leads ? 'left-3' : 'right-3');
  if (leads) expect(box!.padLeft).toBeGreaterThan(box!.padRight);
  else expect(box!.padRight).toBeGreaterThan(box!.padLeft);
}

/** Every catalogue that claims to be a translation, and English. */
const TRANSLATED = LOCALES.map((l) => l.code).filter((code) => code !== 'en-US' && !PLACEHOLDER_LOCALES.includes(code));
const READERS: LocaleCode[] = ['en-US', ...TRANSLATED];

const ASK = 276800;
const OFFER = 250000;
const openThread = (): Thread => ({
  id: 'n1', buyerName: 'Ana', status: 'open', currentAmountCents: OFFER, lastActor: 'buyer', agreedAmountCents: null,
  rounds: [{ id: 'r1', actorRole: 'buyer', kind: 'offer', amountCents: OFFER, message: null, createdAt: '2026-09-01T10:00:00Z' }],
});
const agreedThread = (): Thread => ({
  ...openThread(), status: 'agreed', lastActor: 'seller', agreedAmountCents: OFFER,
  rounds: [...openThread().rounds, { id: 'r2', actorRole: 'seller', kind: 'accept', amountCents: OFFER, message: null, createdAt: '2026-09-01T11:00:00Z' }],
});
const asBuyer = () => createElement(NegotiationPanel, { listingId: 'l1', askCents: ASK, isOwner: false, canOffer: true, threads: [] });
const asSeller = (thread: Thread) => createElement(NegotiationPanel, { listingId: 'l1', askCents: ASK, isOwner: true, canOffer: false, threads: [thread] });

beforeEach(() => {
  h.locale = 'de-DE'; h.cursor = 0; h.slots = []; h.effects = []; h.tables = {};
});
afterEach(() => { h.cleanups.splice(0).forEach((cleanup) => cleanup()); });

describe('the offer box a buyer opens', () => {
  it('holds every catalogue the picker offers as a translation', () => {
    expect(TRANSLATED).toEqual(['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']);
  });

  it.each(READERS)('%s: the unit sits where the reader writes it, under a hint in their own words', (code) => {
    h.locale = code;
    let tree = render(asBuyer());
    expect(boxes(html(tree))).toEqual([]);                 // nothing to type into before the click
    click(button(tree, t('negotiation.makeAnOffer')));
    tree = render(asBuyer());
    const markup = html(tree);
    const [offer, ...more] = boxes(markup);
    expect(more).toEqual([]);
    expectUnit(offer, code);
    // The hint under the box is ONE sentence of the reader's own, the ask inside
    // it — it used to be tr('negotiation.offersBelowThe') + money + tr('…CanAccept').
    expect(visible(markup)).toContain(own(code, 'negotiationPanel.offersBelowTheAsking', { amount: money(ASK, code) }));
    expectNoRawKey(visible(markup));
  });

  it('reads "2.768,00 $" after the German words and "$2,768.00" after the English ones', () => {
    click(button(render(asBuyer()), t('negotiation.makeAnOffer')));
    const de = visible(html(render(asBuyer())));
    expect(de).toContain('2.768,00 $');
    expect(de).not.toMatch(/\$\s?\d/);
    expect(de).toMatch(/<span class="[^"]*\bright-3\b[^"]*">\$<\/span>/);

    h.locale = 'en-US'; h.slots = [];
    click(button(render(asBuyer()), 'Make an Offer'));
    const en = visible(html(render(asBuyer())));
    expect(en).toContain('Offers below the $2,768.00 asking price. The seller can accept or counter.');
    expect(en).toMatch(/<span class="[^"]*\bleft-3\b[^"]*">\$<\/span>/);
  });
});

describe('the counter box a seller opens', () => {
  it.each(READERS)('%s: the unit sits where the reader writes it', (code) => {
    h.locale = code;
    let tree = render(asSeller(openThread()));
    expect(boxes(html(tree))).toEqual([]);
    // Before the click, the Accept button already carries the offer in one sentence.
    expect(visible(html(tree))).toContain(own(code, 'negotiationPanel.acceptAmount', { amount: money(OFFER, code) }));
    click(button(tree, t('negotiation.counter')));
    tree = render(asSeller(openThread()));
    const markup = html(tree);
    const [counter, ...more] = boxes(markup);
    expect(more).toEqual([]);
    expectUnit(counter, code);
    expectNoRawKey(visible(markup));
  });
});

describe('the agreed line a seller reads', () => {
  it.each(READERS)('%s: one sentence, the agreed amount inside it', (code) => {
    h.locale = code;
    const markup = visible(html(render(asSeller(agreedThread()))));
    expect(markup).toContain(own(code, 'negotiationPanel.agreedAtAmount', { amount: money(OFFER, code) }));
    expect(markup).toContain(own(code, 'negotiation.dealAgreedAt', { amount: money(OFFER, code) }));   // the status line
    expectNoRawKey(markup);
  });

  it('reads "2.500,00 $" to a German seller and "Agreed at $2,500.00" to an American one', () => {
    expect(visible(html(render(asSeller(agreedThread()))))).toContain('2.500,00 $');
    h.locale = 'en-US'; h.slots = [];
    expect(visible(html(render(asSeller(agreedThread()))))).toContain('Agreed at $2,500.00');
  });
});

describe('Quick Post, once a sentence has been drafted', () => {
  // A good-condition toy at $30, with two comparable toys the family sold at $40:
  // the engine suggests $40 (the median, at the same condition), which differs
  // from the typed price, so the suggestion is on screen.
  const SENTENCE = "Selling Emma's balance bike in good condition, $30, pickup in the garage";
  const comparables = () => ({ error: null, data: [4000, 4000].map((price_cents) => ({ category: 'toys', condition: 'good', price_cents, kind: 'sell' })) });

  /** Type the sentence, press Draft it, and let the comparables read resolve. */
  async function drafted(): Promise<ReactNode> {
    h.tables.marketplace_listings = comparables();
    const post = () => createElement(QuickPost, {});
    let tree = render(post());
    const composer = nodes(tree).find((node) => node.type === 'input' && node.props.maxLength === 300);
    if (!composer) throw new Error('No composer input');
    (composer.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: SENTENCE } });
    tree = render(post());
    const form = nodes(tree).find((node) => node.type === 'form');
    if (!form) throw new Error('No composer form');
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined });
    render(post());          // the draft; its effect reads the comparables
    await settled();         // …and the read resolves into state
    return render(post());   // the suggestion is on screen
  }

  it.each(READERS)('%s: the price box’s unit and the suggestion follow the reader', async (code) => {
    h.locale = code;
    const tree = await drafted();
    const markup = html(tree);
    const [price, ...more] = boxes(markup);
    expect(more).toEqual([]);
    expectUnit(price, code);
    // The suggestion is ONE sentence with the amount inside it — the whole button
    // reads exactly that, so nothing is glued on after the catalogue value the
    // way `{t('quickPost.aiSuggests')}{suggested / 100}` glued "40" onto "…$".
    const sentence = own(code, 'quickPost.aiSuggestsFromComparables', { amount: formatCents(4000, code) });
    const suggestion = nodes(tree).find((node) => node.type === 'button' && text(node).trim() === sentence);
    expect(suggestion, `no button reads exactly "${sentence}"`).toBeDefined();
    expectNoRawKey(visible(markup));
  });

  it('reads "40 $" to a German seller, "US$ 40" to a Dutch one and "$40" to an American one', async () => {
    const de = visible(html(await drafted()));
    expect(de).toContain('40 $');
    expect(de).not.toMatch(/\$\s?\d/);                          // "KI schlägt vor: $40"
    expect(de).toMatch(/<span class="[^"]*\bright-3\b[^"]*">\$<\/span>/);

    h.locale = 'nl-NL'; h.slots = [];
    const nl = visible(html(await drafted()));
    expect(nl).toContain('US$ 40');
    expect(nl).not.toMatch(/voor\s?\d/);                        // "AI stelt $ voor40"
    expect(nl).toMatch(/<span class="[^"]*\bleft-3\b[^"]*">US\$<\/span>/);

    h.locale = 'en-US'; h.slots = [];
    const en = visible(html(await drafted()));
    expect(en).toContain('AI suggests $40 from your family’s comparable listings');
    expect(en).toMatch(/<span class="[^"]*\bleft-3\b[^"]*">\$<\/span>/);
  });
});
