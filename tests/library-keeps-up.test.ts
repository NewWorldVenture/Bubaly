import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  claimPlayback, releasePlayback, playbackHolder, type Pausable,
} from '@/lib/library/progress';

vi.mock('@/lib/server/public-document-fetch', () => ({
  fetchPublicFeed: vi.fn(),
}));
const { fetchPublicFeed } = await import('@/lib/server/public-document-fetch');
const { ingestFeed, FEED_UNREADABLE, FEED_NOT_A_FEED } = await import('@/lib/library/ingest');

// Three things a library has to do that this one did not: play one thing at a
// time, gain new episodes without being asked, and say something when a row has
// nothing attached to it.

describe('one thing plays at a time', () => {
  const stub = (name: string, log: string[]): Pausable => ({ pause: () => log.push(name) });

  beforeEach(() => {
    // The registry is module state; leave it as we found it.
    const holder = playbackHolder();
    if (holder) releasePlayback(holder);
  });

  it('stops whatever was going when something else starts', () => {
    // Every row renders its own <audio>, so pressing Play on a second episode
    // gave you both at once — two voices, and two rows writing a position every
    // fifteen seconds.
    const log: string[] = [];
    const first = stub('first', log);
    const second = stub('second', log);
    claimPlayback(first);
    claimPlayback(second);
    expect(log).toEqual(['first']);
    expect(playbackHolder()).toBe(second);
  });

  it('does not pause the thing that already holds it', () => {
    const log: string[] = [];
    const only = stub('only', log);
    claimPlayback(only);
    claimPlayback(only);
    expect(log).toEqual([]);
  });

  it('releases only what is still yours', () => {
    // The guard that makes the whole thing work. Pausing the outgoing element
    // fires ITS pause event, which calls release — and an unconditional release
    // would clear the registry the incoming element was just written into, so
    // the next row to start would find nothing to stop and you would be back to
    // two at once.
    const log: string[] = [];
    const first = stub('first', log);
    const second = stub('second', log);
    claimPlayback(first);
    claimPlayback(second);
    releasePlayback(first); // the late pause event from the one just stopped
    expect(playbackHolder()).toBe(second);

    const third = stub('third', log);
    claimPlayback(third);
    expect(log).toEqual(['first', 'second']);
  });

  it('gives it up when the holder stops', () => {
    const log: string[] = [];
    const only = stub('only', log);
    claimPlayback(only);
    releasePlayback(only);
    expect(playbackHolder()).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const FEED = `<?xml version="1.0"?><rss><channel>
  <title>The Kitchen Table</title>
  <itunes:author>Bubaly</itunes:author>
  <item>
    <guid>ep-1</guid><title>Episode one</title>
    <enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg"/>
  </item>
  <item>
    <guid>ep-2</guid><title>Episode two</title>
    <link>https://example.com/2</link>
  </item>
  <item>
    <guid>ep-3</guid><title>Nothing to play or open</title>
  </item>
</channel></rss>`;

type Call = { table: string; op: string; payload: unknown; options?: unknown };

function fakeDb(calls: Call[]) {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {
      eq: () => chain,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      update: (payload: unknown) => { calls.push({ table, op: 'update', payload }); return chain; },
      upsert: (payload: unknown, options: unknown) => {
        calls.push({ table, op: 'upsert', payload, options });
        return chain;
      },
    };
    return chain;
  };
  return { from } as never;
}

describe('a subscription gains its new episodes', () => {
  beforeEach(() => { vi.mocked(fetchPublicFeed).mockReset(); });

  it('writes one row per playable entry, keyed so a refresh updates rather than duplicates', async () => {
    vi.mocked(fetchPublicFeed).mockResolvedValue({ url: 'https://example.com/f.xml', text: FEED });
    const calls: Call[] = [];
    const result = await ingestFeed(fakeDb(calls), 'fam-1', 'user-1', 'feed-1', 'https://example.com/f.xml');

    expect(result).toEqual({ added: 2 });
    const upsert = calls.find((c) => c.op === 'upsert');
    // `feed_key` (0285) rather than `feed_id`: an ON CONFLICT column list only
    // matches a plain, non-partial unique index, so naming the partial one
    // raised 42P10 at planning time and every ingest failed on its first row.
    expect(upsert?.options).toEqual({ onConflict: 'family_id,feed_key,guid' });
    const rows = upsert?.payload as Record<string, unknown>[];
    expect(rows.map((r) => r.guid)).toEqual(['ep-1', 'ep-2']);
    // The third entry has neither a file nor a page, so there is nothing a row
    // for it could ever do.
    expect(rows.every((r) => r.family_id === 'fam-1' && r.feed_id === 'feed-1')).toBe(true);
  });

  it('stamps the feed as fetched and clears the last error', async () => {
    vi.mocked(fetchPublicFeed).mockResolvedValue({ url: 'https://example.com/f.xml', text: FEED });
    const calls: Call[] = [];
    await ingestFeed(fakeDb(calls), 'fam-1', 'user-1', 'feed-1', 'https://example.com/f.xml');
    const update = calls.find((c) => c.table === 'library_feeds' && c.op === 'update');
    const payload = update?.payload as Record<string, unknown>;
    expect(payload.last_error).toBeNull();
    expect(typeof payload.last_fetched_at).toBe('string');
    expect(payload.title).toBe('The Kitchen Table');
  });

  it('reports a publisher that will not answer, rather than throwing', async () => {
    vi.mocked(fetchPublicFeed).mockRejectedValue(new Error('unavailable'));
    const calls: Call[] = [];
    await expect(ingestFeed(fakeDb(calls), 'fam-1', 'user-1', 'feed-1', 'https://example.com/f.xml'))
      .resolves.toEqual({ error: FEED_UNREADABLE });
    expect(calls).toEqual([]);
  });

  it('reports a page that is not a feed', async () => {
    vi.mocked(fetchPublicFeed).mockResolvedValue({ url: 'https://example.com/x', text: 'Not a feed at all' });
    const calls: Call[] = [];
    await expect(ingestFeed(fakeDb(calls), 'fam-1', 'user-1', 'feed-1', 'https://example.com/x'))
      .resolves.toEqual({ error: FEED_NOT_A_FEED });
  });
});

describe('the ingest is reachable from more than a button', () => {
  const actions = readFileSync('app/(app)/dashboard/library/actions.ts', 'utf8');
  const cron = readFileSync('app/api/cron/library-feeds/route.ts', 'utf8');

  it('the action and the cron run the same code', () => {
    // A 'use server' module may only export async functions, and every export
    // it has is callable from the browser — so the ingest could not stay in the
    // actions file and be shared. Both import it from lib/ now.
    for (const source of [actions, cron]) expect(source).toContain("from '@/lib/library/ingest'");
    expect(actions).not.toContain('async function ingestFeed');
  });

  it('the cron is gated, batched and ordered by what is stalest', () => {
    expect(cron).toContain('hasCronAuthorization(req)');
    expect(cron).toContain('nullsFirst: true');
    expect(cron).toContain('.limit(BATCH)');
    // A run that dies two thirds of the way through would otherwise refresh the
    // same two thirds every time.
    expect(cron).toContain('BUDGET_MS');
  });

  it('a feed that fails says why on its own row', () => {
    expect(cron).toContain('recordFeedError(supabase, feed.id, result.error)');
  });
});

describe('fetching on somebody else’s behalf is rate limited', () => {
  const actions = readFileSync('app/(app)/dashboard/library/actions.ts', 'utf8');
  const media = readFileSync('app/library/media/[itemId]/route.ts', 'utf8');

  it('refresh is limited per feed and per family', () => {
    // Per feed because a publisher's server is somebody else's; per family
    // because thirty subscriptions clicked down the list is our egress.
    expect(actions).toContain('library-refresh-feed:');
    expect(actions).toContain('library-refresh-family:');
  });

  it('the media proxy is limited per user, before it reads or fetches anything', () => {
    const limit = media.indexOf('rateLimit(`library-media:');
    const read = media.indexOf(".from('library_items')");
    const fetch = media.indexOf('openPublicMedia(');
    expect(limit).toBeGreaterThan(-1);
    expect(limit).toBeLessThan(read);
    expect(limit).toBeLessThan(fetch);
    expect(media).toContain('status: 429');
  });
});

describe('a row with nothing attached says so', () => {
  const player = readFileSync('app/(app)/dashboard/library/player.tsx', 'utf8');

  it('explains itself instead of rendering three missing buttons', () => {
    expect(player).toContain('!item.mediaUrl && !item.pageUrl');
    expect(player).toContain('Title only');
  });

  it('drives the play state from the element rather than the click', () => {
    // A row can stop for reasons the component never hears about — another row
    // claiming playback, a phone call, the OS media controls — and a button
    // that tracked only its own clicks showed Pause over silence.
    expect(player).toContain('onPlay={onPlay}');
    expect(player).toContain('onPause={onPause}');
    expect(player).toContain('claimPlayback(audio)');
  });
});
