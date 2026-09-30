#!/usr/bin/env python3
"""Static module/import freshness, without executing any server action.

  python3 staleness.py <action-sweep.jsonl> <main checkout> <tested sha> <main sha> <out.json>
  python3 staleness.py <results.tsv> <main checkout> <from sha> <to sha> - --source-only

The second form uses published action identities only, prints JSON to stdout,
and compares source without the historical schema/neutral-change assumptions.
Its from SHA is a comparison baseline, not necessarily the measurement SHA.
The checkout must match the to SHA; no application or browser code is run.

An action's result is STALE when its module, or anything that module imports
(transitively, inside the repository), changed between the tested commit and
main; when that code names a database object a migration added since changed;
or when the export no longer exists. Imports are followed with a
regex over import/export-from/import()/require specifiers, resolving `@/` to the
repository root and relative paths, the way tsconfig does. Packages are not
followed. Package, schema and environment changes need separate review.
"""
import csv, hashlib, json, os, re, subprocess, sys
from collections import Counter, defaultdict

sweep, root, tested, main, out = sys.argv[1:6]
source_only = '--source-only' in sys.argv[6:]
root = os.path.realpath(root)
if source_only:
    target_sha = subprocess.run(['git', '-C', root, 'rev-parse', main],
                            capture_output=True, text=True, check=True).stdout.strip()
    baseline_sha = subprocess.run(['git', '-C', root, 'rev-parse', tested],
                                 capture_output=True, text=True, check=True).stdout.strip()
    head = subprocess.run(['git', '-C', root, 'rev-parse', 'HEAD'],
                          capture_output=True, text=True, check=True).stdout.strip()
    if head != target_sha:
        raise SystemExit('source-only comparison requires checkout HEAD to equal the target SHA')
if sweep.endswith('.tsv'):
    with open(sweep, encoding='utf-8', newline='') as fh:
        calls = [{'file': r['file'], 'name': r['export'], 'target': r['posted_to']}
                 for r in csv.DictReader(fh, delimiter='\t')]
else:
    with open(sweep, encoding='utf-8') as fh:
        calls = [json.loads(l) for l in fh]
changed = set(subprocess.run(['git', '-C', root, 'diff', '--name-only', tested, main],
                             capture_output=True, text=True, check=True).stdout.splitlines())
dirty = set(subprocess.run(['git', '-C', root, 'diff', '--name-only', main],
                           capture_output=True, text=True, check=True).stdout.splitlines()) if source_only else set()
tracked = set(subprocess.run(['git', '-C', root, 'ls-tree', '-r', '--name-only', main],
                             capture_output=True, text=True, check=True).stdout.splitlines()) if source_only else None

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
        relative = os.path.relpath(p, root).replace(os.sep, '/')
        if not relative.startswith('../') and os.path.isfile(p) and (tracked is None or relative in tracked):
            return relative
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
    if source_only and cl & dirty:
        raise SystemExit('source-only comparison refuses modified source in the import closure')
    touched = sorted(cl & changed)
    hit = touched if source_only else [x for x in touched if not neutral(x)] + schema_hits(cl)
    rows.append({'id': aid, 'file': f, 'export': name,
                 'stale': 'stale' if hit else 'current',
                 'why': hit, 'neutral_changes': [] if source_only else [x for x in touched if neutral(x)]})
payload = {
    'comparison_baseline': baseline_sha,
    'compared_source': target_sha,
    'scope': 'Static target module/import comparison; no actions, probes or database operations executed.',
    'measurement_note': 'Baseline is not a measurement claim. Preserve per-action fdcdb425/bc147c76 results in results.tsv.',
    'counts': dict(sorted(Counter(r['stale'] for r in rows).items())),
    'actions': rows,
} if source_only else rows
if out == '-':
    json.dump(payload, sys.stdout, indent=1)
    print()
    sys.exit(0)
with open(out, 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=1)
    fh.write('\n')
print(Counter(r['stale'] for r in rows))
print('files among changed that make results stale:',
      Counter(x for r in rows for x in r['why'] if r['stale'] == 'stale').most_common(15))
