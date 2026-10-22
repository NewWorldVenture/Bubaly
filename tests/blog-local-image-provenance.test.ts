import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import assets from '@/lib/blog/local-image-assets.json';

// Actual blog reader + installed Supabase SDK, with only a sealed synthetic
// read transport. Actual article and JSON-LD render; unrelated widgets/data
// are stubbed. Native Next optimization has its separate local HTTP witness.
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => key,
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('@/lib/marketing/aeo', () => ({
  readAeoQuestionsForPathCached: async () => ({ questions: [] }),
  readAeoQuestionsForCategoryCached: async () => ({ questions: [] }),
  localizeAeoQuestions: async () => [],
}));
vi.mock('@/lib/marketing/seo', () => ({ resolveMarketingMetadata: async (_path: string, fallback: unknown) => fallback }));
vi.mock('@/lib/server/social-links', () => ({ getCachedSocialLinks: async () => ({}) }));
vi.mock('@/components/blog/heart-button', () => ({ HeartButton: () => null }));
vi.mock('@/components/blog/subscribe-form', () => ({ SubscribeForm: () => null }));
vi.mock('@/app/(marketing)/blog/[slug]/reading-progress', () => ({ ReadingProgress: () => null }));
vi.mock('@/app/(marketing)/blog/[slug]/share-buttons', () => ({ ShareButtons: () => null }));
vi.mock('@/app/(marketing)/blog/[slug]/table-of-contents', () => ({ TableOfContents: () => null }));

vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog-canonical.invalid');
const { freeLicensedImage, getPost, readAllPosts } = await import('@/lib/blog/posts');
const { default: Article, generateMetadata } = await import('@/app/(marketing)/blog/[slug]/page');
const { BlogPostStructuredData, FaqStructuredData } = await import('@/components/marketing/structured-data');
const asset = assets.assets[0];
const ORIGINAL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/51/Harvested_carrot.jpg/1920px-Harvested_carrot.jpg';
const LOCAL = '/blog/harvested-carrot.jpg';
const CANONICAL = `https://blog-canonical.invalid${LOCAL}`;
const SLUG = 'how-to-handle-the-low-waste-family-kitchen-and-actually-enjoy-it';
type Row = Database['public']['Tables']['blog_posts']['Row'];
const originalRow: Row = {
  id: '00000000-0000-4000-8000-000000000021', slug: SLUG, title: 'The low-waste family kitchen',
  excerpt: 'Existing article excerpt', author: 'Existing author', published_at: '2026-06-25',
  reading_minutes: 3, tags: ['family'], category: 'Recipes & Food', featured: false,
  accent_color: '#f97316', hero_image_url: ORIGINAL, hero_image_alt: 'Harvested carrot',
  hero_image_credit: 'Harvested carrot — Hajia Hijjah (CC BY-SA 4.0)',
  hero_image_source_url: ORIGINAL, hero_image_license: 'cc-by-sa-4.0',
  hero_image_attribution: 'Harvested carrot — Hajia Hijjah (CC BY-SA 4.0)', hero_image_source_hash: 'synthetic-source-hash',
  body: [{ type: 'p', text: 'Keep this article body exactly as supplied.' }], published: true,
  created_at: '2026-06-25T00:00:00Z', updated_at: '2026-06-25T00:00:00Z',
};
let row: Row;
let requests: URL[];
let violations: string[];

beforeEach(() => {
  row = structuredClone(originalRow); requests = []; violations = [];
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://blog-data.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.origin !== 'https://blog-data.invalid' || url.pathname !== '/rest/v1/blog_posts' || method !== 'GET') {
      violations.push(`${method} ${url.origin}${url.pathname}`);
      throw new Error('This fixture forbids external or mutating requests');
    }
    requests.push(url);
    const p = url.searchParams;
    const excluded = p.get('slug') === `neq.${SLUG}` || Number(p.get('offset') ?? '0') > 0
      || /^(?:lt|gt)\./.test(p.get('published_at') ?? '');
    return new Response(JSON.stringify(excluded ? [] : [row]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => {
  expect(violations).toEqual([]);
  expect(requests.every((url) => url.searchParams.get('published') === 'eq.true')).toBe(true);
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

// Resolve only the actual async JSON-LD children before React's synchronous
// renderer. The article and next/image implementations are not replaced.
async function resolveStructuredChildren(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveStructuredChildren));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === BlogPostStructuredData) {
    return BlogPostStructuredData((node as ReactElement<Parameters<typeof BlogPostStructuredData>[0]>).props);
  }
  if (node.type === FaqStructuredData) {
    return FaqStructuredData((node as ReactElement<Parameters<typeof FaqStructuredData>[0]>).props);
  }
  if (node.props.children === undefined) return node;
  const children = await resolveStructuredChildren(node.props.children);
  return Array.isArray(children) ? cloneElement(node, {}, ...children) : cloneElement(node, {}, children);
}
async function articleHtml() {
  return renderToStaticMarkup(await resolveStructuredChildren(await Article({ params: Promise.resolve({ slug: SLUG }) })));
}
function caption(html: string) { return /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/.exec(html)?.[1] ?? ''; }

describe('one reviewed existing blog image is served locally', () => {
  it('maps the exact stored thumbnail URL to the same licensed local photo', () => {
    expect(freeLicensedImage(ORIGINAL)).toBe(LOCAL);
  });

  it.each([
    'https://upload.wikimedia.org/wikipedia/commons/thumb/5/51/Dads_beach_kites_on_beach_nice.jpg/1920px-Dads_beach_kites_on_beach_nice.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/5/51/Jubilee_Campus_MMB_%C2%AB54_Melton_Hall.jpg/1920px-Jubilee_Campus_MMB_%C2%AB54_Melton_Hall.jpg',
    `${ORIGINAL}?v=2`, `${ORIGINAL}#different`, ORIGINAL.replace('1920px-', '1200px-'),
    ORIGINAL.replace('Harvested_carrot', 'harvested_carrot'),
    'https://owned.supabase.co/storage/v1/object/public/blog/a.jpg', LOCAL,
  ])('leaves an unmapped or already-local URL unchanged: %s', (url) => {
    expect(freeLicensedImage(url)).toBe(url);
  });

  it.each([null, undefined, '', 'https://loremflickr.com/1600/900/family', 'https://picsum.photos/id/624/1600/900'])(
    'preserves the existing fallback for %s', (url) => { expect(freeLicensedImage(url)).toBeUndefined(); },
  );

  it('adapts an actual SDK article read without changing content, alt or stored credit', async () => {
    const post = await getPost(SLUG);
    expect(post).toMatchObject({ slug: SLUG, title: row.title, author: row.author, body: row.body,
      heroImageUrl: LOCAL, heroImageAlt: row.hero_image_alt, heroImageCredit: row.hero_image_credit,
      heroImageAttribution: { title: asset.title, creator: asset.creator, sourceUrl: asset.sourceUrl,
        license: asset.license, licenseUrl: asset.licenseUrl } });
    expect(row).toEqual(originalRow);
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get('slug')).toBe(`eq.${SLUG}`);
  });

  it('adapts the actual paged list through the same mapping without fetching the image', async () => {
    const result = await readAllPosts();
    expect(result).toMatchObject({ ok: true, posts: [{ slug: SLUG, heroImageUrl: LOCAL }] });
    expect(requests).toHaveLength(2);
  });

  it('keeps unrelated owned image metadata and content unchanged', async () => {
    row.hero_image_url = 'https://owned.supabase.co/storage/v1/object/public/blog/a.jpg';
    const post = await getPost(SLUG);
    expect(post).toMatchObject({ heroImageUrl: row.hero_image_url, heroImageCredit: row.hero_image_credit, body: row.body });
    expect(post).not.toHaveProperty('heroImageAttribution');
  });
});

describe('the displayed photo retains attribution and canonical metadata', () => {
  it.each([originalRow.hero_image_credit, null, '', '   '])('renders known creator/source/license even with stored credit %j', async (credit) => {
    row.hero_image_credit = credit;
    const html = await articleHtml();
    const photoCaption = caption(html);
    expect(photoCaption).toContain('Harvested carrot');
    expect(photoCaption).toContain('Hajia Hijjah');
    expect(photoCaption).toContain(`href="${asset.sourceUrl}"`);
    expect(photoCaption).toContain(`href="${asset.licenseUrl}"`);
    expect(photoCaption).toContain('CC BY-SA 4.0');
    expect(html).toContain(`url=${encodeURIComponent(LOCAL)}`);
    expect(html).not.toContain('url=https%3A%2F%2Fupload.wikimedia.org');
  });

  it('preserves additional supplied credit as escaped text alongside verified attribution', async () => {
    row.hero_image_credit = 'Existing caption <strong>kept</strong>';
    const photoCaption = caption(await articleHtml());
    expect(photoCaption).toContain('Existing caption &lt;strong&gt;kept&lt;/strong&gt;');
    expect(photoCaption).toContain('Hajia Hijjah');
    expect(photoCaption).not.toContain('<strong>kept</strong>');
  });

  it('attributes the known already-local image without relying on a mutable credit', async () => {
    row.hero_image_url = LOCAL; row.hero_image_credit = null;
    const photoCaption = caption(await articleHtml());
    expect(photoCaption).toContain('Hajia Hijjah');
    expect(photoCaption).toContain(`href="${asset.licenseUrl}"`);
  });

  it('passes the canonical absolute local URL into actual BlogPosting JSON-LD', async () => {
    const html = await articleHtml();
    const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]) as { '@type': string; image?: string[] });
    expect(scripts.find((s) => s['@type'] === 'BlogPosting')?.image).toEqual([CANONICAL]);
  });

  it('uses the same absolute local asset for OG and Twitter metadata', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: SLUG }) });
    expect(metadata.openGraph).toMatchObject({ images: [{ url: CANONICAL, alt: 'Harvested carrot' }] });
    expect(metadata.twitter).toMatchObject({ images: [CANONICAL] });
  });

  it('preserves the ordinary remote photo caption and unaltered absolute social URL', async () => {
    row.hero_image_url = 'https://owned.supabase.co/storage/v1/object/public/blog/a.jpg';
    row.hero_image_credit = 'Existing owned photo credit';
    expect(caption(await articleHtml())).toBe('Photo: Existing owned photo credit');
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: SLUG }) });
    expect(metadata.twitter).toMatchObject({ images: [row.hero_image_url] });
  });

  it('retains generated cover fallback without falsely attributing the mirrored image', async () => {
    row.hero_image_url = null; row.hero_image_credit = null;
    const html = await articleHtml();
    expect(caption(html)).toBe('');
    expect(html).not.toContain(asset.sourceUrl);
    expect(html).not.toContain(`url=${encodeURIComponent(LOCAL)}`);
  });
});

describe('shipped provenance binds the original licensed bytes', () => {
  it('matches the verified original JPEG dimensions, media type, size and hashes', async () => {
    expect(assets.assets).toHaveLength(1);
    expect(asset).toMatchObject({ originalHeroUrl: ORIGINAL, localPath: LOCAL, title: 'Harvested carrot',
      creator: 'Hajia Hijjah', license: 'CC BY-SA 4.0', originalSha1: '361bf32508462dcd81a3f1bf96dae00ebb9c18dd',
      sha256: '8aa9da8e302421be001d8a01a44fb020ea3bb6bef903188cab20b40a36b91c23', bytes: 2329664 });
    const bytes = readFileSync(join(process.cwd(), 'public', LOCAL));
    expect(bytes.length).toBe(asset.bytes);
    expect(createHash('sha1').update(bytes).digest('hex')).toBe(asset.originalSha1);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
    expect(await sharp(bytes).metadata()).toMatchObject({ format: 'jpeg', width: 2992, height: 2992 });
    expect(asset.processing).toContain('unchanged');
    expect(asset.processing).toContain('CC BY-SA 4.0');
  });

  it('does not ship a duplicate raster or allow a remote mapping target', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const file = join(dir, name); return statSync(file).isDirectory() ? walk(file) : [file];
    });
    const matching = walk('public').filter((file) => /\.(?:png|jpe?g|webp|gif|avif)$/i.test(file))
      .filter((file) => createHash('sha256').update(readFileSync(file)).digest('hex') === asset.sha256);
    expect(matching).toEqual(['public/blog/harvested-carrot.jpg']);
    expect(asset.localPath).toMatch(/^\/blog\/[a-z0-9-]+\.jpg$/);
    expect(new URL(asset.sourceUrl).origin).toBe('https://commons.wikimedia.org');
    expect(new URL(asset.licenseUrl).origin).toBe('https://creativecommons.org');
  });
});
