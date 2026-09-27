#!/usr/bin/env python3
"""Check the public site's properties against a deployed origin.

The MAIN rows about the public site (sitemap, robots, titles, headings, blog,
unknown paths, the message catalogue) are retested here on the deployed site
rather than in a unit test: the finding was what production served, so the
retest is what production serves now.

    python3 docs/audit/production-public-site-check.py [origin] [out.json]

It fetches the live sitemap, then every URL in it once (12 at a time, with
retries), and prints each property with the URLs that break it. The exit code
is 0 when every property holds and 1 otherwise. It only reads.
"""
import concurrent.futures as cf
import html
import json
import random
import re
import subprocess
import sys
import time
from urllib.parse import urlparse

ORIGIN = (sys.argv[1] if len(sys.argv) > 1 else 'https://www.bubaly.com').rstrip('/')
OUT = sys.argv[2] if len(sys.argv) > 2 else None
# lib/marketing/sitemap-urls.ts DISALLOWED_PREFIXES
DISALLOWED = ['/account', '/admin', '/api', '/auth', '/capture', '/dashboard', '/display', '/economy',
              '/family', '/feedback', '/guardian', '/home', '/kids', '/library', '/marketplace', '/missions',
              '/money', '/onboarding', '/parent', '/pay', '/referrals', '/services', '/settings', '/wallet']
APP_ONLY_KEYS = ['childAccessManager.', 'concierge.', 'kidLogin.showPin']
SEED_SLUG = re.compile(r'seed-[a-z0-9_]+-\d+', re.I)


def get(url, headers=False, gzip=False):
    args = ['curl', '-sS', '--max-time', '40', '-o', '-', '-w', '\n__STATUS__%{http_code} %{redirect_url} %{size_download}']
    if headers:
        args += ['-D', '/dev/stderr']
    if gzip:
        args += ['--compressed', '-H', 'Accept-Encoding: gzip']
    for attempt in range(4):
        p = subprocess.run(args + [url], capture_output=True, text=True, errors='replace')
        m = re.search(r'\n__STATUS__(\d+) (\S*) (\d+)$', p.stdout)
        if m and m.group(1) != '000':
            return int(m.group(1)), p.stdout[:m.start()], p.stderr, m.group(2), int(m.group(3))
        time.sleep(2 * (attempt + 1))
    return 0, '', p.stderr, '', 0


def page(url):
    status, body, hdrs, _, _ = get(url, headers=True)
    canonical = (re.search(r'<link[^>]+rel="canonical"[^>]+href="([^"]+)"', body)
                 or re.search(r'<link[^>]+href="([^"]+)"[^>]+rel="canonical"', body))
    title = re.search(r'<title[^>]*>(.*?)</title>', body, re.S)
    return {
        'url': url,
        'status': status,
        'noindex': bool(re.search(r'<meta[^>]+name="robots"[^>]+content="[^"]*noindex', body, re.I))
        or any(l.lower().startswith('x-robots-tag') and 'noindex' in l.lower() for l in hdrs.splitlines()),
        'canonical': html.unescape(canonical.group(1)) if canonical else None,
        'title': html.unescape(title.group(1)).strip() if title else None,
        'h1': len(re.findall(r'<h1[\s>]', body)),
    }


def main():
    r = {}
    fail = {}
    _, body, _, _, _ = get(ORIGIN + '/api/build-info')
    r['revision'] = body.strip()
    status, smx, hdrs, _, _ = get(ORIGIN + '/sitemap.xml', headers=True)
    r['sitemap_cache_headers'] = [l for l in hdrs.splitlines() if re.match(r'(?i)(cache-control|x-vercel-cache):', l)]
    locs = re.findall(r'<loc>(.*?)</loc>', smx)
    lastmods = re.findall(r'<lastmod>(.*?)</lastmod>', smx)
    r['sitemap_urls'] = len(locs)
    fail['sitemap not 200 or empty'] = [] if status == 200 and locs else [status]
    fail['duplicate <loc>'] = sorted({u for u in locs if locs.count(u) > 1})
    fail['<loc> with ? or #'] = [u for u in locs if '?' in u or '#' in u]
    fail['homepage not listed exactly once'] = [] if len([u for u in locs if u.rstrip('/') == ORIGIN]) == 1 else ['homepage']
    fail['signed-in prefix in sitemap'] = [u for u in locs if any(urlparse(u).path == p or urlparse(u).path.startswith(p + '/') for p in DISALLOWED)]
    minute = time.strftime('%Y-%m-%dT%H:%M', time.gmtime())
    fail['<lastmod> is the fetch time'] = [m for m in lastmods if m.startswith(minute)]
    _, robots, _, _, _ = get(ORIGIN + '/robots.txt')
    disallow = set(re.findall(r'(?im)^Disallow:\s*(\S+)', robots))
    fail['robots.txt misses a signed-in prefix'] = [p for p in DISALLOWED if p not in disallow and p + '/' not in disallow]
    with cf.ThreadPoolExecutor(12) as ex:
        pages = list(ex.map(page, locs))
    fail['not 200'] = [(p['url'], p['status']) for p in pages if p['status'] != 200]
    fail['noindex'] = [p['url'] for p in pages if p['noindex']]
    fail['not its own canonical'] = [(p['url'], p['canonical']) for p in pages if not p['canonical'] or p['canonical'].rstrip('/') != p['url'].rstrip('/')]
    fail['title ends in the brand twice'] = [(p['url'], p['title']) for p in pages if p['title'] and re.search(r'Bubaly\s*[—–\-|·:]?\s*Bubaly\s*$', p['title'], re.I)]
    fail['not exactly one <h1>'] = [(p['url'], p['h1']) for p in pages if p['h1'] != 1]
    for path, want in [('/no-such-page-audit', 404), ('/zz-unknown/deeper', 404), ('/blog/no-such-post-audit', 404),
                       ('/case-studies/seed-family_story-1', 404), ('/dashboard', 307), ('/admin', 307)]:
        st, _, _, redirect, _ = get(ORIGIN + path)
        ok = st == want and (want != 307 or '/login' in redirect)
        fail[f'{path} is not {want}'] = [] if ok else [(st, redirect)]
    for path in ['/case-studies', '/reviews']:
        _, body, _, _, _ = get(ORIGIN + path)
        fail[f'{path} lists a seeded story'] = SEED_SLUG.findall(body)
    _, cookies, _, _, _ = get(ORIGIN + '/cookies')
    fail['/cookies carries app-only catalogue keys'] = [k for k in APP_ONLY_KEYS if k in cookies]
    r['cookies_gzipped_bytes'] = get(ORIGIN + '/cookies', gzip=True)[4]
    _, blog, _, _, _ = get(ORIGIN + '/blog')
    r['blog_gzipped_bytes'] = get(ORIGIN + '/blog', gzip=True)[4]
    st, index, _, _, _ = get(ORIGIN + '/api/blog/search-index')
    entries = json.loads(index) if st == 200 else []
    entries = entries if isinstance(entries, list) else []
    r['search_index_entries'] = len(entries)
    linked = set(re.findall(r'href="/blog/([^"?#]+)"', blog))
    unlinked = [e['slug'] for e in entries if isinstance(e, dict) and e.get('slug') and e['slug'] not in linked]
    random.seed(1)
    sample = random.sample(unlinked, min(20, len(unlinked)))
    fail['search index empty'] = [] if entries else [st]
    fail['/blog carries posts it does not link'] = [s for s in sample if s in blog]
    r['failures'] = {k: v for k, v in fail.items() if v}
    for k, v in fail.items():
        print(('FAIL ' if v else 'ok   ') + k + (f': {v[:5]}' if v else ''))
    print(json.dumps({k: v for k, v in r.items() if k != 'failures'}))
    if OUT:
        json.dump(r, open(OUT, 'w'), indent=1)
    sys.exit(1 if r['failures'] else 0)


if __name__ == '__main__':
    main()
