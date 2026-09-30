#!/usr/bin/env python3
"""Which 2026-09-28 action-sweep results are stale on current main.

  python3 stale_actions.py <action-sweep.jsonl> <main checkout> <tested sha> <main sha> <out.json>

An action's result is STALE when its module, or anything that module imports
(transitively, inside the repository), changed between the tested commit and
main; when that code names a database object a migration added since changed;
or when the export no longer exists. Imports are followed with a
regex over import/export-from/import()/require specifiers, resolving `@/` to the
repository root and relative paths, the way tsconfig does. Packages are not
followed (package.json and package-lock.json are unchanged between the two).
"""
import hashlib, json, os, re, subprocess, sys
from collections import defaultdict

sweep, root, tested, main, out = sys.argv[1:6]
calls = [json.loads(l) for l in open(sweep)]
changed = set(subprocess.run(['git', '-C', root, 'diff', '--name-only', tested, main],
                             capture_output=True, text=True, check=True).stdout.split())

SPEC = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]""", re.M)
EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '.jsx', '/index.ts', '/index.tsx', '/index.js']

def resolve(spec, frm):
    if spec.startswith('@/'):
        base = os.path.join(root, spec[2:])
    elif spec.startswith('.'):
        base = os.path.normpath(os.path.join(root, os.path.dirname(frm), spec))
    else:
        return None
    for e in EXTS:
        p = base + e
        if os.path.isfile(p):
            return os.path.relpath(p, root)
    return None

# Changes that cannot alter what an action does at runtime, each checked by
# reading its diff: a generated type file (erased at build), the translation
# catalogues (copy only; a verdict reads the result's shape, not its words), and
# three modules whose only change is new top-level exports nothing old calls.
NEUTRAL = {
    'lib/database.types.ts': 'types only (erased at build)',
    'lib/constants/roles.ts': 'new exports only (ROLE_LABEL_KEYS, ROLE_DESCRIPTION_KEYS, roleLabel)',
    'lib/stripe.ts': 'new export only (constructWebhookEvent)',
    'lib/auth/mfa.ts': 'new export only (settleMfaCall)',
}
def neutral(f):
    return f in NEUTRAL or re.fullmatch(r'lib/i18n/messages/[a-z]{2}-[A-Z]{2}\.json', f) is not None

# Database objects changed by the migrations main added after the tested
# commit (0460-0464; the tested database stopped at 0459), each read from its
# migration. 0464 is recorded but does not make a result stale: its trigger
# refuses a caller whose role is `guest`, and none of the sweep's four callers
# is one, so for them it passes by construction.
SCHEMA = {
    '0460': ['subscriptions_tracked'],
    '0461': ['family_stress_predictions', 'vacation_activity_logs', 'vacation_activity_tickets',
             'vacation_audit_logs', 'vacation_checklists', 'vacation_destinations', 'vacation_notifications'],
    '0462': ['marketplace_bids', 'marketplace_buy_now', 'marketplace_collection_items',
             'marketplace_listing_shares', 'marketplace_listing_visible_to', 'marketplace_listings',
             'marketplace_negotiation_offer', 'marketplace_negotiation_rounds', 'marketplace_negotiations',
             'marketplace_offers', 'marketplace_orders', 'marketplace_place_bid', 'marketplace_questions',
             'marketplace_saves'],
    '0463': ['family_messages', 'family_message_receipts_are_the_callers'],
}
SCHEMA_NEUTRAL = {'0464': ['calendar_events', 'chore_assignments', 'chores', 'documents',
                           'grocery_items', 'meals', 'notes', 'reminders']}
OBJ = {t: m for m, ts in SCHEMA.items() for t in ts}
OBJ_RX = re.compile(r"""['"`](%s)['"`]""" % '|'.join(sorted(OBJ, key=len, reverse=True)))

def schema_hits(files):
    hits = set()
    for f in files:
        try:
            hits |= set(OBJ_RX.findall(open(os.path.join(root, f), encoding='utf-8').read()))
        except OSError:
            pass
    return sorted(f'{OBJ[t]} {t}' for t in hits)

deps_cache = {}
def deps(f):
    if f not in deps_cache:
        try:
            src = open(os.path.join(root, f), encoding='utf-8').read()
        except OSError:
            src = ''
        deps_cache[f] = {r for s in SPEC.findall(src) if (r := resolve(s, f))}
    return deps_cache[f]

def closure(f):
    seen, stack = set(), [f]
    while stack:
        x = stack.pop()
        if x in seen:
            continue
        seen.add(x)
        stack.extend(deps(x) - seen)
    return seen

def exported(f, name):
    try:
        src = open(os.path.join(root, f), encoding='utf-8').read()
    except OSError:
        return False
    return re.search(rf'export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+){re.escape(name)}\b', src) is not None \
        or re.search(rf'export\s*\{{[^}}]*\b{re.escape(name)}\b', src) is not None

actions = {}
for c in calls:
    actions[(c['file'], c['name'])] = c['target']
rows = []
for (f, name), target in sorted(actions.items()):
    aid = 'ACTION-' + hashlib.sha256(f'{f}:{name}'.encode()).hexdigest()[:12].upper()
    if not os.path.isfile(os.path.join(root, f)):
        rows.append({'id': aid, 'file': f, 'export': name, 'stale': 'removed', 'why': ['module removed on main']})
        continue
    # `$$RSC_SERVER_ACTION_<n>` is an inline `'use server'` function inside a
    # page; the compiler names it, so there is no export to look for.
    if not name.startswith('$$RSC_SERVER_ACTION_') and not exported(f, name):
        rows.append({'id': aid, 'file': f, 'export': name, 'stale': 'removed', 'why': ['export no longer found']})
        continue
    cl = closure(f)
    touched = sorted(cl & changed)
    hit = [x for x in touched if not neutral(x)] + schema_hits(cl)
    rows.append({'id': aid, 'file': f, 'export': name,
                 'stale': 'stale' if hit else 'current',
                 'why': hit, 'neutral_changes': [x for x in touched if neutral(x)]})
json.dump(rows, open(out, 'w'), indent=1)
from collections import Counter
print(Counter(r['stale'] for r in rows))
print('files among changed that make results stale:',
      Counter(x for r in rows for x in r['why'] if r['stale'] == 'stale').most_common(15))
