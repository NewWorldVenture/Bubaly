// Every app/**/page.tsx as a URL path, one per line — the page audit's route
// list. Route groups `(x)` are dropped; a dynamic segment gets a value that
// matches nothing (an all-zero UUID for an id, `no-such-page` otherwise), so
// what a crawl of it checks is the page's not-found path.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../app', import.meta.url));
const NO_SUCH_ID = '00000000-0000-4000-8000-000000000000';
const out = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (entry === 'page.tsx') {
      const segments = relative(root, dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s));
      out.push('/' + segments.map((s) => {
        const param = /^\[(.+)\]$/.exec(s)?.[1];
        if (!param) return s;
        if (param === 'provider') return 'google';
        return /id$/i.test(param) ? NO_SUCH_ID : 'no-such-page';
      }).join('/'));
    }
  }
})(root);
console.log(out.sort().join('\n'));
