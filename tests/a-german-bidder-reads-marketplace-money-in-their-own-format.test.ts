// A German family reads the marketplace's money in their own format (I18N-003).
//
// THE DEFECT. Twelve marketplace sites wrote money as `$${(c / 100).toFixed(2)}`:
// the "$" is TEXT and `toFixed` has no locale at all, so a German bidder read
// "$2768.50" — no grouping, a "." decimal mark and the symbol on the American
// side — where they write "2.768,50 $". And most of those amounts sat inside
// ENGLISH sentences ("Your move — they're at $2768.50."), which localising the
// number alone would not have fixed.
//
// WHAT THIS PROVES, by running the real code as a de-DE reader and reading the
// string they would see: the auction box and the offer box (client components,
// under the same LocaleProvider the app mounts), the auctions / deals / offers
// pages (server components, with the request's locale), the minimum-bid error a
// bidder gets back from the server action, the price chips, the price coach, the
// price history, and the marketplace assistant's grounded reply. Each is paired
// with the same call for an en-US reader, which must still read "$2,768.50".
//
// And the one place the reader is NOT known, stated rather than hidden: the
// auction-close cron notifies two households who are not in the request, and no
// table stores a family's language, so it formats with Intl in an explicit en-US.
//
// THE WORDS AROUND THE AMOUNT ARE CHECKED TOO, against the REAL catalogues. The
// sentences this change adds reach lib/i18n/messages/*.json in the orchestrator's
// catalogue merge, and THIS FILE IS RED UNTIL THAT MERGE LANDS — deliberately: a
// key missing from the catalogue renders as the key itself ("auctionPanel.soldFor")
// to every reader, and an earlier draft of this test hid exactly that behind an
// inline English copy of the sentences. And a German reader must get GERMAN
// sentences: getMessages('de-DE') fills any key German lacks with the English
// one, so `own()` below insists a catalogue carries its OWN translation — five of
// these surfaces were German before this change ("Jetzt kaufen für",
// "Preisvorstellung", "Annehmen"), and an English-only merge would have turned
// them back into English around a German amount. Not only German: es-ES, fr-FR,
// it-IT, nl-NL and pt-PT each had their own words on those surfaces too
// ("Achetez-le pour", "Koop het nu voor"), so the last block holds the
// replacement keys in EVERY catalogue that is not a declared placeholder.
//
// The separators are written as ESCAPES, never typed: Intl puts U+00A0 between a
// German amount and its symbol and U+202F between French thousands, and a plain
// space in the expectation fails with two strings that look identical in a diff.
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, getRawMessages, PLACEHOLDER_LOCALES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { LOCALES, localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';

const h = vi.hoisted(() => ({
  locale: 'de-DE' as 'de-DE' | 'en-US' | 'fr-FR',
  tables: {} as Record<string, { data: unknown; error: unknown }>,
  rpc: { data: null as unknown, error: null as unknown },
  notify: vi.fn(async (_scope: unknown, _input: { title: string; body: string }) => ({ ok: true })),
}));

/** The reader's catalogue — the real one, merged down its fallback chain exactly
 *  as the app loads it. */
const messagesFor = (code: LocaleCode) => getMessages(code);
const tFor = (code: LocaleCode) => (key: string, params?: Record<string, string | number>) =>
  translate(messagesFor(code), key, params);

/** The English catalogue file as written — what every other one must differ from. */
const EN_OWN = getRawMessages('en-US');

/**
 * The sentence a reader of `code` must see for `key`: that catalogue's OWN
 * translation, read from the file as written, BEFORE the fallback fills its gaps.
 * A key the catalogue lacks would still resolve — to English, through getMessages
 * — and every amount assertion here would pass around an English sentence.
 */
function own(code: LocaleCode, key: string, params: Record<string, string | number>): string {
  const catalogue = getRawMessages(code);
  expect(catalogue[key], `${key} is missing from ${code}.json`).toBeDefined();
  expect(catalogue[key], `${key} is still the English sentence in ${code}.json`).not.toBe(EN_OWN[key]);
  return translate(catalogue, key, params);
}
const german = (key: string, params: Record<string, string | number>) => own('de-DE', key, params);

/** Every catalogue that claims to be a translation: the picker's locales minus
 *  English and minus the four lib/i18n/messages.ts declares empty on purpose. */
const TRANSLATED = LOCALES.map((l) => l.code).filter((code) => code !== 'en-US' && !PLACEHOLDER_LOCALES.includes(code));

/** The text a reader sees: static markup escapes quotes and ampersands. */
const visible = (html: string) => html
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A catalogue key rendered as itself — what every reader gets while one is missing. */
function expectNoRawKey(text: string) {
  expect(text).not.toMatch(
    /\b(?:listings|negotiation|negotiationPanel|auctionPanel|marketplaceAuctions|marketplaceDeals|marketplaceNegotiations|priceCoach|marketAssistant|closeAuctions)\.[a-z]\w*/,
  );
}

/** A Supabase query: every builder call returns the builder, and awaiting it
 *  resolves the rows planted for that table. */
function query(result: { data: unknown; error: unknown }): object {
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
}
const client = () => ({
  from: (table: string) => query(h.tables[table] ?? { data: [], error: null }),
  rpc: async () => h.rpc,
});

// The request's locale, as lib/i18n/server resolves it from the cookie — the one
// seam every server surface here reads (getFormat() reads it too).
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages } = await import('@/lib/i18n/messages');
  const { translate: lookup } = await import('@/lib/i18n/translate');
  const { localeOrDefault: resolve } = await import('@/lib/i18n/locales');
  const map = () => messages(h.locale);
  return {
    getLocaleContext: async () => ({ locale: resolve(h.locale), source: 'cookie', messages: map() }),
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => lookup(map(), key, params),
  };
});
// Only the I/O boundaries are replaced: auth, the database, the router and toasts.
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ active: { familyId: 'fam-1', role: 'parent', member: { id: 'm-self' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => client(), createServiceClient: () => client() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => client() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: async () => ({ familyId: 'x' }) }));
vi.mock('@/lib/services/notifications', () => ({ notify: h.notify }));

import { AuctionPanel } from '@/components/marketplace/auction-panel';
import { NegotiationPanel } from '@/components/marketplace/negotiation-panel';
import AuctionsPage from '@/app/(app)/marketplace/auctions/page';
import DealsPage from '@/app/(app)/marketplace/deals/page';
import NegotiationsInboxPage from '@/app/(app)/marketplace/negotiations/page';
import { placeBidAction } from '@/app/(app)/marketplace/auctions/actions';
import { GET as closeAuctions } from '@/app/api/cron/close-auctions/route';
import { formatCents, priceLabel } from '@/lib/marketplace/listings';
import { roundLine, statusLine, validateOfferAmount } from '@/lib/marketplace/negotiation';
import { historyLine } from '@/lib/marketplace/price-history';
import { bandSummary } from '@/lib/marketplace/price-coach';
import { answerMarketQuestion, type MarketSnapshot } from '@/lib/marketplace/assistant';

const DE = '2.768,50 $';
const EN = '$2,768.50';

/** What a German reader must never see: the symbol leading, or no locale at all. */
function expectNoHandWrittenDollar(text: string) {
  expect(text).not.toMatch(/\$\s?\d/);     // "$2768.50", "$2,768.50", "$ 40"
  expect(text).not.toContain('2768.50');    // toFixed: no grouping, "." decimal
}

function renderAs(code: LocaleCode, node: ReactElement): string {
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { locale: localeOrDefault(code), source: 'cookie', messages: messagesFor(code) } as Parameters<typeof LocaleProvider>[0],
    node,
  ));
}

const HOUR = 3_600_000;
const auction = () => ({
  saleFormat: 'auction', status: 'available', startingBidCents: 100000, currentBidCents: 276850,
  bidCount: 3, hasReserve: false, reserveMet: true, buyNowCents: 350000,
  auctionStartsAt: new Date(Date.now() - 24 * HOUR).toISOString(),
  auctionEndsAt: new Date(Date.now() + 48 * HOUR).toISOString(),
  highestBidderFamilyId: 'fam-other',
});

beforeEach(() => {
  h.locale = 'de-DE';
  h.tables = {};
  h.rpc = { data: null, error: null };
  h.notify.mockClear();
});

describe('the auction box a bidder watches', () => {
  const panel = () => createElement(AuctionPanel, {
    listingId: 'l1', isOwner: false, myFamilyId: 'fam-1', initial: auction(),
    initialBids: [{ id: 'b1', bidder_family_id: 'fam-other', amount_cents: 276850, status: 'winning', created_at: '2026-09-01T10:00:00Z', is_auto: false }],
  });
  // Buy-It-Now closes at the first bid, so the button is read on an auction
  // nobody has bid on yet.
  const unbidPanel = () => createElement(AuctionPanel, {
    listingId: 'l1', isOwner: false, myFamilyId: 'fam-1', initial: { ...auction(), bidCount: 0 }, initialBids: [],
  });

  it('reads the current bid, Buy-It-Now and the bid history in German notation', () => {
    const html = renderAs('de-DE', panel());
    expect(html).toContain(DE);                  // current bid and the history row
    // Buy it now: German's own sentence around the German amount.
    expect(visible(renderAs('de-DE', unbidPanel()))).toContain(german('auctionPanel.buyItNowForAmount', { amount: '3.500,00\u00a0$' }));
    expectNoHandWrittenDollar(html);
    expectNoRawKey(visible(html));
  });

  it('puts the max-bid box’s unit where the reader writes it, not a "$" pinned to the left', () => {
    // German: "2.768,50 $" — the unit trails, so the box's does too.
    expect(renderAs('de-DE', panel())).toMatch(/<span class="[^"]*\bright-3\b[^"]*">\$<\/span>/);
    expect(renderAs('fr-FR', panel())).toMatch(/<span class="[^"]*\bright-3\b[^"]*">\$US<\/span>/);
    expect(renderAs('en-US', panel())).toMatch(/<span class="[^"]*\bleft-3\b[^"]*">\$<\/span>/);
  });

  it('still reads "$2,768.50" to an American bidder', () => {
    const html = renderAs('en-US', panel());
    expect(html).toContain(EN);
    expect(renderAs('en-US', unbidPanel())).toContain('Buy it now for $3,500.00');
  });

  it('puts the amount inside the sentence, not after an English fragment', () => {
    const ended = createElement(AuctionPanel, {
      listingId: 'l1', isOwner: false, myFamilyId: 'fam-1',
      initial: { ...auction(), auctionEndsAt: new Date(Date.now() - HOUR).toISOString(), hasReserve: true, reserveMet: false },
      initialBids: [],
    });
    // Ended below the reserve: the whole sentence is one catalogue key.
    const html = renderAs('de-DE', ended);
    expect(visible(html)).toContain(german('auctionPanel.endedAtReserveNotMet', { amount: DE }));
    expect(html).not.toContain('Ended at $');
    expect(visible(renderAs('en-US', ended))).toContain(`Ended at ${EN} — reserve not met.`);
  });
});

describe('the offer box a seller answers', () => {
  const panel = () => createElement(NegotiationPanel, {
    listingId: 'l1', askCents: 276800, isOwner: true, canOffer: false,
    threads: [{
      id: 'n1', buyerName: 'Ana', status: 'open', currentAmountCents: 250000, lastActor: 'buyer' as const,
      agreedAmountCents: null,
      rounds: [{ id: 'r1', actorRole: 'buyer' as const, kind: 'offer' as const, amountCents: 250000, message: null, createdAt: '2026-09-01T10:00:00Z' }],
    }],
  });

  it('reads the ask, the status line, the timeline and the Accept button in German notation', () => {
    const html = renderAs('de-DE', panel());
    expect(html).toContain('2.768,00 $');                    // asking
    expect(html.split('2.500,00 $').length - 1).toBe(3);     // status line, timeline, Accept
    expectNoHandWrittenDollar(html);
    // …inside German sentences, not English ones around a German amount.
    const text = visible(html);
    expect(text).toContain(german('negotiationPanel.askingAmount', { amount: '2.768,00\u00a0$' }));
    expect(text).toContain(german('negotiation.yourMoveTheyreAt', { amount: '2.500,00\u00a0$' }));
    expect(text).toContain(german('negotiation.buyerOfferedAmount', { amount: '2.500,00\u00a0$' }));
    expect(text).toContain(german('negotiationPanel.acceptAmount', { amount: '2.500,00\u00a0$' }));
    expectNoRawKey(text);
  });

  it('still reads dollars-first to an American seller', () => {
    const html = renderAs('en-US', panel());
    expect(html).toContain('$2,768.00');
    expect(html).toContain('$2,500.00');
  });
});

describe('the marketplace pages, rendered for the request’s reader', () => {
  const soon = new Date(Date.now() + 2 * HOUR).toISOString();

  it('Live Auctions: the bid and Buy now', async () => {
    h.tables.marketplace_listings = { error: null, data: [{
      id: 'l1', title: 'Road bike', photo_url: null, category: 'sports', sale_format: 'auction', status: 'available',
      starting_bid_cents: 100000, current_bid_cents: 276850, bid_count: 2, reserve_cents: null, buy_now_cents: 350000,
      auction_starts_at: null, auction_ends_at: soon,
    }] };
    const de = renderToStaticMarkup(await AuctionsPage());
    expect(de).toContain(DE);
    expect(visible(de)).toContain(german('marketplaceAuctions.buyNowAmount', { amount: '3.500,00\u00a0$' }));
    expectNoHandWrittenDollar(de);
    expectNoRawKey(visible(de));

    h.locale = 'en-US';
    const en = renderToStaticMarkup(await AuctionsPage());
    expect(en).toContain(EN);
    expect(en).toContain('Buy now $3,500.00');
  });

  it('Deals: the price and the comparable range', async () => {
    h.tables.marketplace_listings = { error: null, data: [276850, 300000, 400000, 500000, 600000].map((price_cents, i) => ({
      id: `l${i}`, title: `Bike ${i}`, photo_url: null, category: 'sports', condition: 'good', price_cents,
    })) };
    const de = renderToStaticMarkup(await DealsPage());
    expect(de).toContain(DE);
    // The band's edges (25th and 75th percentile) are whole dollars, and now the
    // reader's too — "Similar: $3000–$5000" was two symbols typed by hand.
    expect(visible(de)).toContain(german('marketplaceDeals.similarRange', { low: '3.000\u00a0$', high: '5.000\u00a0$' }));
    expectNoHandWrittenDollar(de);
    expectNoRawKey(visible(de));

    h.locale = 'en-US';
    const en = renderToStaticMarkup(await DealsPage());
    expect(en).toContain(EN);
    expect(en).toContain('Similar: $3,000–$5,000');
  });

  it('Offers inbox: the ask inside its sentence, the status line and the offer', async () => {
    h.tables.marketplace_negotiations = { error: null, data: [{
      id: 'n1', listing_id: 'l1', family_id: 'fam-2', buyer_member_id: 'm-self', buyer_family_id: 'fam-1',
      status: 'open', current_amount_cents: 250000, last_actor: 'buyer', agreed_amount_cents: null, updated_at: soon,
    }] };
    h.tables.marketplace_listings = { error: null, data: [{ id: 'l1', title: 'Road bike', member_id: 'm-ana', price_cents: 276800 }] };
    h.tables.family_members = { error: null, data: [{ id: 'm-ana', display_name: 'Ana' }] };

    const de = renderToStaticMarkup(await NegotiationsInboxPage());
    expect(de).toContain('2.768,00 $');                   // asking, inside the sentence
    expect(de.split('2.500,00 $').length - 1).toBe(2);    // status line and the offer
    expect(visible(de)).toContain(german('marketplaceNegotiations.yourOfferToAsking', { name: 'Ana', amount: '2.768,00\u00a0$' }));
    expect(visible(de)).toContain(german('negotiation.waitingOnTheSellerYoureAt', { amount: '2.500,00\u00a0$' }));
    expectNoHandWrittenDollar(de);
    expectNoRawKey(visible(de));

    h.locale = 'en-US';
    const en = renderToStaticMarkup(await NegotiationsInboxPage());
    expect(visible(en)).toContain('Your offer to Ana · asking $2,768.00');
    expect(visible(en)).toContain('Waiting on the seller — you’re at $2,500.00.');
  });
});

describe('the minimum-bid error the server action hands back', () => {
  it('names the minimum in the bidder’s notation', async () => {
    h.rpc = { data: { ok: false, reason: 'too_low', min_cents: 276850 }, error: null };
    const de = await placeBidAction({ listingId: 'l1', maxCents: 100 });
    expect(de.ok).toBe(false);
    if (de.ok) return;
    expect(de.error).toContain(DE);
    expectNoHandWrittenDollar(de.error);

    h.locale = 'en-US';
    const en = await placeBidAction({ listingId: 'l1', maxCents: 100 });
    expect(en.ok ? '' : en.error).toBe(`Minimum bid is ${EN}.`);
  });
});

describe('the pure helpers every surface above goes through', () => {
  const de = tFor('de-DE');
  const en = tFor('en-US');

  it('price chips: whole dollars stay whole, and the rent unit is a sentence', () => {
    expect(formatCents(276850, 'de-DE')).toBe(DE);
    expect(formatCents(276850, 'en-US')).toBe(EN);
    expect(formatCents(276850, 'fr-FR')).toBe('2 768,50 $US');
    expect(priceLabel('sell', 1500, null, 'de-DE', de)).toBe('15 $');
    expect(priceLabel('rent', 500, 'day', 'de-DE', de)).toBe(german('listings.pricePerDay', { amount: '5\u00a0$' }));
    expect(priceLabel('free', 0, null, 'de-DE', de)).toBe(german('listings.free', {}));
    expect(priceLabel('rent', 500, 'day', 'en-US', en)).toBe('$5/day');
  });

  it('negotiation lines carry the amount in the reader’s notation', () => {
    const open = { status: 'open' as const, currentAmountCents: 276850, lastActor: 'buyer' as const };
    expect(statusLine(open, 'seller', 'de-DE', de)).toBe(german('negotiation.yourMoveTheyreAt', { amount: DE }));
    expect(statusLine(open, 'seller', 'en-US', en)).toBe(`Your move — they’re at ${EN}.`);
    expect(roundLine({ actorRole: 'buyer', kind: 'offer', amountCents: 276850, createdAt: 'x' }, 'de-DE', de))
      .toBe(german('negotiation.buyerOfferedAmount', { amount: DE }));
    expect(validateOfferAmount(300000, 276850, 'de-DE', de)).toBe(german('negotiation.atOrAboveTheAskingPrice', { ask: DE }));
    for (const line of [statusLine(open, 'buyer', 'de-DE', de), validateOfferAmount(300000, 276850, 'de-DE', de) ?? '']) {
      expectNoHandWrittenDollar(line);
    }
  });

  it('price history and the price coach', () => {
    expect(historyLine({ oldCents: 300000, newCents: 276850, changedAt: 'x' }, 'de-DE')).toBe(`3.000,00 $ → ${DE} ↓`);
    expect(historyLine({ oldCents: 300000, newCents: 276850, changedAt: 'x' }, 'en-US')).toBe(`$3,000.00 → ${EN} ↓`);
    const band = { lowCents: 200000, medianCents: 300000, highCents: 450000, sampleSize: 5 };
    const coach = bandSummary(band, 'de-DE', de) ?? '';
    expect(coach).toBe(german('priceCoach.similarItemsRange', { low: '2.000\u00a0$', high: '4.500\u00a0$' }));
    expectNoHandWrittenDollar(coach);
    expect(bandSummary(band, 'en-US', en)).toBe('Similar items: $2,000–$4,500');
  });

  it('the marketplace assistant’s grounded reply — the text a family reads when no model answers', () => {
    const snap: MarketSnapshot = {
      selfMemberId: 'm-self', offers: [],
      listings: [2500, 4000, 6000].map((price_cents, i) => ({
        id: `b${i}`, title: `Kids bike ${i}`, kind: 'sell', category: 'sports', condition: 'good',
        price_cents, status: 'available', member_id: 'm-other',
      })),
    };
    const price = answerMarketQuestion('What should I charge for a kids bike in good condition?', snap, 'de-DE', de);
    // Three sports comps at 25/40/60 $ → the median, 40 $, for a "good" one.
    expect(price.reply).toBe(german('marketAssistant.askAroundForCondition', {
      count: 3, category: 'sports', amount: '40\u00a0$', condition: 'good',
    }));
    expectNoHandWrittenDollar(price.reply);
    const found = answerMarketQuestion('find a bike under $50', snap, 'de-DE', de);
    // German's own sentence up to where the listings go (their order is the ranker's).
    const [foundHead] = german('marketAssistant.foundOnTheBoard', { count: 2, listings: '\u0000' }).split('\u0000');
    expect(found.reply.startsWith(foundHead)).toBe(true);
    expect(found.reply).toContain('25 $');
    expect(found.reply).toContain('40 $');
    expectNoHandWrittenDollar(found.reply);
    expect(answerMarketQuestion('find a bike under $50', snap, 'en-US', en).reply).toContain('$25');
  });
});

describe('the auction-close notice, whose reader the cron cannot know', () => {
  it('is formatted by Intl in an explicit en-US — grouped, never `toFixed` — whatever the request says', async () => {
    h.tables.marketplace_listings = { error: null, data: [{ id: 'l1' }] };
    h.rpc = { error: null, data: {
      ok: true, reason: 'closed', sold: true, had_bids: true, title: 'Road bike',
      seller_family_id: 'fam-seller', winner_family_id: 'fam-winner', current_bid_cents: 276850, order_id: 'o1',
    } };
    // The cron's own request resolves to German; the two households it writes to
    // are not in that request, and no column stores their language.
    h.locale = 'de-DE';
    const res = await closeAuctions(new NextRequest('http://localhost/api/cron/close-auctions'));
    expect(res.status).toBe(200);
    const notices = h.notify.mock.calls.map(([, input]) => ({ title: input.title, body: input.body }));
    // Every word is a catalogue sentence now, read through the cron's one explicit
    // source-locale reader — so the German household still reads English, which
    // only a stored recipient locale (I18N-001) can change, and when one exists
    // that reader is the single line that has to learn it.
    expect(notices).toEqual([
      { title: 'You won "Road bike"', body: `Final price ${EN}. Open your orders to arrange pickup.` },
      { title: 'Auction sold: "Road bike"', body: `Sold for ${EN}. Confirm pickup in your orders.` },
    ]);
  });

  it('says the reserve was not met from the catalogue too', async () => {
    h.tables.marketplace_listings = { error: null, data: [{ id: 'l1' }] };
    h.rpc = { error: null, data: {
      ok: true, reason: 'closed', sold: false, had_bids: true, title: 'Road bike', seller_family_id: 'fam-seller',
    } };
    const res = await closeAuctions(new NextRequest('http://localhost/api/cron/close-auctions'));
    expect(res.status).toBe(200);
    expect(h.notify.mock.calls.map(([, input]) => ({ title: input.title, body: input.body }))).toEqual([{
      title: 'Auction ended: "Road bike"',
      body: 'The reserve was not met, so it did not sell. Relist it or lower the reserve.',
    }]);
  });
});

describe('the sentences that were translated before this change', () => {
  // Five surfaces used to render already-translated keys around the amount —
  // auction.buyItNowFor "Jetzt kaufen für" / "Achetez-le pour" / "Koop het nu voor",
  // negotiation.asking "Preisvorstellung" / "Prix demandé" / "Vraagprijs",
  // negotiation.offersBelowThe + askingPriceTheSellerCanAccept, negotiation.agreedAt,
  // negotiation.accept "Annehmen" / "Accepter" / "Accetta" — and so did Quick Post's
  // quickPost.aiSuggests, in all six translated catalogues. Their whole-sentence
  // replacements must carry each catalogue's OWN words, or those readers go from
  // their language to English the day this ships. The placeholder test
  // (tests/an-empty-locale-says-it-is-a-placeholder.test.ts) only checks that a
  // key is PRESENT, so a merge that copied English into five catalogues would
  // pass it; this is what catches that. (The clicked-open offer box, the counter
  // box, the agreed line and Quick Post are rendered in
  // tests/a-german-family-types-marketplace-money-beside-a-trailing-unit.test.ts.)
  const KEYS = [
    ['auctionPanel.buyItNowForAmount', 350000],
    ['negotiationPanel.askingAmount', 276800],
    ['negotiationPanel.offersBelowTheAsking', 276800],
    ['negotiationPanel.agreedAtAmount', 250000],
    ['negotiationPanel.acceptAmount', 250000],
    ['quickPost.aiSuggestsFromComparables', 4000],
  ] as const;

  it('holds every catalogue the picker offers as a translation', () => {
    expect(TRANSLATED).toEqual(['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']);
  });

  describe.each(TRANSLATED)('%s', (code) => {
    it.each(KEYS)('%s', (key, cents) => {
      // The amount as THIS reader's Intl writes it: "3.500,00 $", "US$ 3.500,00",
      // "3 500,00 $US" — the symbol's side and spelling differ, so the check that
      // no symbol was typed by hand strips the real amount first and then looks
      // for any "$" left in the words (the retired quickPost.aiSuggests ended in
      // one: "KI schlägt vor: $", "AI stelt $ voor").
      const amount = formatCents(cents, code);
      const sentence = own(code, key, { amount });
      expect(sentence).toContain(amount);
      expect(sentence.replace(amount, '')).not.toContain('$');
    });
  });
});
