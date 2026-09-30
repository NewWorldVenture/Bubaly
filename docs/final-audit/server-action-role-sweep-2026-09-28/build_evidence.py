#!/usr/bin/env python3
"""Turn raw server-action sweep output into the sanitized evidence table.

  python3 build_evidence.py <tested.jsonl> <rerun.jsonl> <stale.json> <finalaudit.md> <out.tsv>

Raw sweep lines (scripts/action-audit/sweep.mjs) carry what an action returned,
which can name a local test family, its ids and seeded content. None of that is
copied. Each call is reduced to its verdict under
scripts/action-audit/summarize.mjs's rules and a detail drawn from a fixed
vocabulary; a redirect keeps its path and drops its query.
"""
import hashlib, json, re, sys
from collections import Counter, defaultdict

tested_file, rerun_file, stale_file, audit_file, out = sys.argv[1:6]
CALLERS = ('anon', 'child', 'parent', 'admin')
ADMIN_FILE = re.compile(r'app/\(app\)/admin/|app/admin/|lib/marketing/')
REFUSAL = re.compile(r'"ok":false|"error":|"reason":|"refused"|not authori[sz]ed|forbidden', re.I)
GATE = re.compile(r'/login|/plan|/kid-login|/onboarding')


def path_only(url):
    m = re.match(r'^(?:https?://[^/]+)?(/[^?#]*)', url or '')
    return m.group(1) if m else ''


def verdict(c):
    """summarize.mjs's verdict, plus a detail that holds no returned value."""
    if c.get('skipped'):
        return 'SKIPPED', c['skipped']
    st = c.get('status', 0)
    if st == 0:
        return 'FAIL', 'no answer'
    loc = (c.get('location') or '') + (c.get('actionRedirect') or '')
    if st in (302, 303, 307):
        p = path_only(c.get('location') or c.get('actionRedirect'))
        return ('BLOCKED' if GATE.search(loc) else 'RETURNED'), f'{st} to {p}'
    if c.get('actionRedirect') and GATE.search(c['actionRedirect']):
        return 'BLOCKED', f'redirect to {path_only(c["actionRedirect"])}'
    r = c.get('result') or {'kind': 'no-result'}
    if r['kind'] == 'threw':
        digest = re.search(r'"digest":"([A-Za-z_]+:[A-Za-z]+)"', r.get('raw', ''))
        return 'REFUSED', f'threw {digest.group(1)}' if digest else 'threw'
    if r['kind'] == 'no-result':
        return ('FAIL', f'{st}, no result') if st >= 500 else ('REFUSED', f'{st}, no result')
    raw = r.get('raw', '')
    if REFUSAL.search(raw):
        return 'REFUSED', 'refusal in result'
    detail = 'nothing' if raw == '"$undefined"' else 'a value'
    if ADMIN_FILE.search(c['file']) and c['caller'] in ('child', 'parent'):
        return 'FAIL', f'admin action returned {detail} to a non-admin'
    return 'RETURNED', detail


def load(path):
    per = defaultdict(dict)
    for line in open(path):
        c = json.loads(line)
        per[(c['file'], c['name'])][c['caller']] = (verdict(c), c.get('target', ''))
    return per


def cell(v):
    (kind, detail), _ = v
    return f'{kind} ({detail})'


tested = load(tested_file)
rerun = load(rerun_file) if rerun_file != '-' else {}
stale = {(r['file'], r['export']): r for r in json.load(open(stale_file))}
register = {}
for line in open(audit_file, encoding='utf-8'):
    m = re.match(r'^\| (ACTION-[0-9A-F]{12}) \| ACTION \| (\S+) \| ([^|]+) \|', line)
    if m:
        register[m.group(1)] = m.group(3).strip()

cols = ['action_id', 'register_row_on_main', 'file', 'export', 'posted_to'] \
    + [f'fdcdb425_{c}' for c in CALLERS] + ['staleness', 'stale_because'] \
    + [f'bc147c76_{c}' for c in CALLERS] + ['rerun_changed']
lines = ['\t'.join(cols)]
tally = Counter()
for (f, name) in sorted(tested):
    aid = 'ACTION-' + hashlib.sha256(f'{f}:{name}'.encode()).hexdigest()[:12].upper()
    t = tested[(f, name)]
    s = stale[(f, name)]
    row = [aid, register.get(aid, 'no row (action postdates the register)'), f, name,
           next(iter(t.values()))[1]]
    row += [cell(t[c]) for c in CALLERS]
    row += [s['stale'], '; '.join(s['why'])]
    r = rerun.get((f, name))
    if s['stale'] == 'stale' and r:
        row += [cell(r[c]) if c in r else 'not run' for c in CALLERS]
        same = all(c in r and r[c][0][0] == t[c][0][0] for c in CALLERS)
        row.append('no' if same else 'yes')
        tally['rerun same' if same else 'rerun changed'] += 1
    else:
        row += ['', '', '', '', '']
    tally[s['stale']] += 1
    lines.append('\t'.join(x.replace('\t', ' ') for x in row))
open(out, 'w').write('\n'.join(lines) + '\n')
print(dict(tally), len(lines) - 1, 'rows')
