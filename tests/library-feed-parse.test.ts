import { describe, it, expect } from 'vitest';
import {
  parseFeed, parseDuration, parseFeedDate, safeFeedUrl, decodeEntities, textContent,
  progressPercent, formatDuration, MAX_FEED_ITEMS,
} from '@/lib/library/feed-parse';

const NOW = new Date('2026-03-10T00:00:00Z');

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title><![CDATA[The Family Hour]]></title>
    <description>Weekly, with &amp; without the kids</description>
    <itunes:author>Ada Lovelace</itunes:author>
    <itunes:image href="https://cdn.test/cover.jpg"/>
    <item>
      <title>Episode 2 &amp; a half</title>
      <description><![CDATA[<p>Notes with <b>markup</b></p>]]></description>
      <enclosure length="12345" type="audio/mpeg" url="https://cdn.test/ep2.mp3"/>
      <guid isPermaLink="false">ep-2</guid>
      <pubDate>Mon, 02 Mar 2026 09:00:00 GMT</pubDate>
      <itunes:duration>45:11</itunes:duration>
      <link>https://show.test/ep2</link>
    </item>
    <item>
      <title>Episode 1</title>
      <enclosure url='https://cdn.test/ep1.mp3' type='audio/mpeg'/>
      <guid>ep-1</guid>
      <pubDate>Mon, 23 Feb 2026 09:00:00 GMT</pubDate>
      <itunes:duration>3600</itunes:duration>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Audiobook Chapters</title>
  <subtitle>Public domain readings</subtitle>
  <entry>
    <title>Chapter One</title>
    <id>urn:uuid:chapter-1</id>
    <updated>2026-02-01T10:00:00Z</updated>
    <summary>The opening</summary>
    <link rel="alternate" href="https://books.test/ch1"/>
    <link rel="enclosure" href="https://books.test/ch1.mp3" type="audio/mpeg"/>
  </entry>
</feed>`;

describe('RSS, as publishers actually write it', () => {
  const feed = parseFeed(RSS, NOW)!;

  it('reads the channel, not the first episode', () => {
    // The header is split off before parsing, or a channel <title> would be
    // taken from whichever <item> matched first.
    expect(feed.title).toBe('The Family Hour');
    expect(feed.description).toBe('Weekly, with & without the kids');
    expect(feed.author).toBe('Ada Lovelace');
    expect(feed.imageUrl).toBe('https://cdn.test/cover.jpg');
  });

  it('unwraps CDATA and decodes entities in titles', () => {
    expect(feed.items[0].title).toBe('Episode 2 & a half');
  });

  it('strips the markup publishers put inside a description', () => {
    expect(feed.items[0].description).toBe('Notes with markup');
  });

  it('finds the enclosure whatever order the attributes are in', () => {
    // url last on one, first on the other, and different quote characters.
    expect(feed.items[0].mediaUrl).toBe('https://cdn.test/ep2.mp3');
    expect(feed.items[1].mediaUrl).toBe('https://cdn.test/ep1.mp3');
  });

  it('keeps the page link separate from the audio file', () => {
    expect(feed.items[0].pageUrl).toBe('https://show.test/ep2');
    expect(feed.items[0].pageUrl).not.toBe(feed.items[0].mediaUrl);
  });

  it('reads a namespaced duration in either notation', () => {
    expect(feed.items[0].durationSeconds).toBe(45 * 60 + 11);
    expect(feed.items[1].durationSeconds).toBe(3600);
  });

  it('normalises the publication date', () => {
    expect(feed.items[0].publishedAt).toBe('2026-03-02T09:00:00.000Z');
  });
});

describe('Atom, which names everything differently', () => {
  const feed = parseFeed(ATOM, NOW)!;

  it('reads the feed and its entries', () => {
    expect(feed.title).toBe('Audiobook Chapters');
    expect(feed.description).toBe('Public domain readings');
    expect(feed.items).toHaveLength(1);
  });

  it('takes the id as the guid and the enclosure link as the media', () => {
    expect(feed.items[0].guid).toBe('urn:uuid:chapter-1');
    expect(feed.items[0].mediaUrl).toBe('https://books.test/ch1.mp3');
    expect(feed.items[0].pageUrl).toBe('https://books.test/ch1');
  });

  it('falls back through published, updated for the date', () => {
    expect(feed.items[0].publishedAt).toBe('2026-02-01T10:00:00.000Z');
  });
});

describe('a feed is untrusted input', () => {
  it('refuses a URL scheme that is not http(s)', () => {
    // A feed offering javascript: or data: is offering an attack, and these
    // URLs end up in href and src attributes.
    expect(safeFeedUrl('javascript:alert(1)')).toBeNull();
    expect(safeFeedUrl('data:text/html,<script>')).toBeNull();
    expect(safeFeedUrl('file:///etc/passwd')).toBeNull();
    expect(safeFeedUrl('https://ok.test/a.mp3')).toBe('https://ok.test/a.mp3');
    expect(safeFeedUrl('not a url')).toBeNull();
    expect(safeFeedUrl(null)).toBeNull();
  });

  it('drops a javascript enclosure rather than storing it', () => {
    const hostile = `<rss><channel><title>x</title><item><title>t</title>
      <enclosure url="javascript:alert(1)" type="audio/mpeg"/></item></channel></rss>`;
    expect(parseFeed(hostile, NOW)!.items[0].mediaUrl).toBeNull();
  });

  it('does not let a script tag survive as text', () => {
    const hostile = `<rss><channel><title><![CDATA[<script>alert(1)</script>Show]]></title>
      <item><title>t</title></item></channel></rss>`;
    expect(parseFeed(hostile, NOW)!.title).toBe('alert(1) Show');
  });

  it('refuses a document that is not markup at all', () => {
    expect(parseFeed('not xml', NOW)).toBeNull();
    expect(parseFeed('', NOW)).toBeNull();
  });

  it('refuses markup with neither a title nor an entry', () => {
    expect(parseFeed('<html><body>hi</body></html>', NOW)).toBeNull();
  });

  it('caps how many entries it will take', () => {
    const many = `<rss><channel><title>Big</title>${'<item><title>x</title></item>'.repeat(MAX_FEED_ITEMS + 50)}</channel></rss>`;
    expect(parseFeed(many, NOW)!.items).toHaveLength(MAX_FEED_ITEMS);
  });

  it('gives an untitled entry a name rather than an empty row', () => {
    const feed = parseFeed('<rss><channel><title>x</title><item><guid>g</guid></item></channel></rss>', NOW)!;
    expect(feed.items[0].title).toBe('Untitled');
  });
});

describe('durations and dates publishers get wrong', () => {
  it('takes all three legal duration forms', () => {
    expect(parseDuration('3600')).toBe(3600);
    expect(parseDuration('45:11')).toBe(2711);
    expect(parseDuration('1:02:03')).toBe(3723);
  });

  it('returns null, never zero, for junk', () => {
    // Zero reads as "instant" in a player, which is worse than unknown.
    expect(parseDuration('about an hour')).toBeNull();
    expect(parseDuration('0')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration('1:2:3:4')).toBeNull();
  });

  it('rejects a date far in the future instead of letting it pin the list', () => {
    expect(parseFeedDate('Mon, 02 Mar 3026 09:00:00 GMT', NOW)).toBeNull();
    expect(parseFeedDate('1970-01-01T00:00:00Z', NOW)).toBeNull();
    expect(parseFeedDate('nonsense', NOW)).toBeNull();
    expect(parseFeedDate('2026-03-02T09:00:00Z', NOW)).toBe('2026-03-02T09:00:00.000Z');
  });
});

describe('small helpers the UI leans on', () => {
  it('decodes the entities feeds use', () => {
    expect(decodeEntities('Tom &amp; Jerry &lt;3 &#39;quoted&#39; &#x27;too&#x27;')).toBe("Tom & Jerry <3 'quoted' 'too'");
  });

  it('leaves an unknown entity alone rather than mangling it', () => {
    expect(decodeEntities('&bogus;')).toBe('&bogus;');
  });

  it('collapses the whitespace XML indentation leaves behind', () => {
    expect(textContent('  <b>a</b>\n   <i>b</i>  ')).toBe('a b');
  });

  it('clamps progress to a real percentage', () => {
    expect(progressPercent(30, 60)).toBe(50);
    expect(progressPercent(90, 60)).toBe(100);
    expect(progressPercent(-5, 60)).toBe(0);
    expect(progressPercent(30, null)).toBe(0);
    expect(progressPercent(30, 0)).toBe(0);
  });

  it('says lengths the way a listener thinks about them', () => {
    expect(formatDuration(2711)).toBe('45 min');
    expect(formatDuration(3600)).toBe('1 hr');
    expect(formatDuration(3723)).toBe('1 hr 2 min');
    expect(formatDuration(20)).toBe('1 min');
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(0)).toBe('');
  });
});
