import { NextRequest, NextResponse } from 'next/server';
import { getAllPosts } from '@/lib/blog/posts';
import { clientIp, rateLimit } from '@/lib/server/rate-limit';

// The typeahead index for /blog, fetched on first interaction rather than
// shipped with the page.
//
// The blog index used to pass all 1,048 published posts to the client search
// component as a prop, which React serialises into the page: 446 KB of the
// 597 KB /blog response was a dataset needed only by the minority of visitors
// who type in the search box, while the page itself renders 25 cards.
//
// Same fields as before — title, excerpt and category are what the component
// matches on — but now behind one request, cached at the edge, shared by every
// visitor who does search.
export const runtime = 'nodejs';

/** How long a CDN may serve this index, and how long it may serve a stale copy
 *  while refetching. A new post appearing in search a few minutes late is not a
 *  defect worth an origin hit per search. */
const CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600';

export async function GET(req: NextRequest) {
  // Generous: this is public, cacheable, and a person who clears the box and
  // retypes should never be refused. It exists to bound a scripted hammer.
  const limit = rateLimit(`blog-search-index:${clientIp(req.headers)}`, { limit: 60, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json([], { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } });
  }

  // getAllPosts degrades to [] on any error, so a database hiccup costs the
  // typeahead and nothing else.
  const posts = await getAllPosts();
  return NextResponse.json(
    posts.map((p) => ({
      slug: p.slug,
      title: p.title,
      // The same 90-character clip the page used to send; the component
      // matches against it, it is never displayed.
      excerpt: p.excerpt.slice(0, 90),
      category: p.category,
    })),
    { headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}
