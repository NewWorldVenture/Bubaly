#!/usr/bin/env python3
"""Summarise a page-audit crawl: python3 scripts/page-audit/summarize.py out.jsonl [issues|summary]

`issues` (default) lists every route with a finding, per viewport; `summary`
counts findings by kind. An expected 404 (a dynamic route opened with an id
that matches nothing) is still listed, so read those lines as "the not-found
path answered", not as a defect."""
import json, sys, collections
recs=[json.loads(l) for l in open(sys.argv[1])]
by=collections.defaultdict(dict)
for r in recs: by[r['path']][r['vp']]=r
def issues(r):
    out=[]
    if r.get('error'): out.append('NAV-ERROR '+r['error'][:120])
    st=r.get('status')
    if st and st>=400: out.append(f'HTTP {st}')
    if r.get('pageErrors'): out.append('pageerror: '+' | '.join(r['pageErrors'])[:200])
    if r.get('consoleErrors'): out.append('console: '+' | '.join(r['consoleErrors'])[:200])
    if r.get('badResponses'): out.append('4xx/5xx: '+' | '.join(r['badResponses'])[:200])
    if r.get('failed'): out.append('reqfailed: '+' | '.join(r['failed'])[:200])
    if r.get('overflow'): out.append(f"overflow {r.get('scrollWidth')}>{r.get('innerWidth')}: "+'; '.join(r['overflow']))
    for a in r.get('axe') or []: out.append(f"axe {a['id']}({a['impact']}) x{a['n']} {a.get('sample','')[:60]}")
    if r.get('errorText'): out.append('error-text: '+r['errorText'][:100].replace('\n',' '))
    if r.get('rawKeys'): out.append('raw-keys? '+','.join(r['rawKeys'][:5]))
    if r.get('networkidleTimeout'): out.append('networkidle-timeout')
    return out
mode=sys.argv[2] if len(sys.argv)>2 else 'issues'
if mode=='issues':
    for p in sorted(by):
        rows=[]
        for vp in ('phone','desktop'):
            r=by[p].get(vp)
            if not r: continue
            iss=issues(r)
            if iss: rows.append(f"  [{vp}] final={r.get('final')} status={r.get('status')}\n    - "+'\n    - '.join(iss))
        if rows: print(p); print('\n'.join(rows))
elif mode=='summary':
    c=collections.Counter()
    for p in by:
        for vp,r in by[p].items():
            for i in issues(r): c[i.split(' ')[0].split(':')[0] + (' '+i.split(' ')[1] if i.startswith('axe') else '')]+=1
    for k,v in c.most_common(): print(v,k)
    finals=collections.Counter()
    for p in by:
        r=by[p].get('desktop') or by[p].get('phone')
        f=r.get('final','') or ''
        finals['login-redirect' if f.startswith('/login') else ('same' if f.split('?')[0]==p else 'other:'+f.split('?')[0])]+=1
    print(finals.most_common(30))
