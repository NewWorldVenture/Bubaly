#!/usr/bin/env python3
"""Build an index of every finding ID in finalaudit.md.

The document is ~29,000 lines and holds two ID schemes that do different jobs.
`UI-ROUTE-0001`-style ids in the Audit Summary enumerate the *target space* —
14,037 rows, nearly all NOT STARTED, and the denominator behind "Overall
Completion: 0.01%". The `AUTHZ-011`-style ids in sections 2 to 5 are the
*findings*: things somebody looked at and concluded something about.

There was no index of the second kind, so finding `AUTHZ-022` meant grepping.
This builds one from the document itself rather than by hand, because a
hand-written index of 90 ids goes stale the first time somebody adds the 91st.

    python3 docs/audit/finding-index.py            # print the markdown table
    python3 docs/audit/finding-index.py --write    # splice it into finalaudit.md

The status column is DERIVED from how each row's last cell opens, and it is a
label rather than a verdict: a row beginning "**Fixed by `0322`
(UNAPPLIED)**" is indexed FIXED, and whether that means fixed *in production*
is what the row itself says. Where the opening does not match a known shape the
status is left blank rather than guessed.
"""
import re
import sys

DOC = 'finalaudit.md'
BEGIN = '<!-- finding-index:begin -->'
END = '<!-- finding-index:end -->'

ID_ROW = re.compile(r'^\|\s*\*\*([A-Z][A-Z0-9-]{1,20}(?:\s*/\s*[A-Z0-9-]+)?)\*\*\s*\|')
CELLS = re.compile(r'(?<!\\)\|')

# Ordered: the first pattern that matches the opening of the last cell wins.
#
# Every pattern here READS a word the row already uses. None infers a verdict
# from evidence — a row that does not announce its own state is left blank
# rather than guessed, because an index that quietly upgrades "half fixed" to
# "fixed" is worse than one with gaps.
#
# PARTIAL and the unbolded OWNER'S shapes were added after the first run left
# 13 rows blank and each turned out to be a real phrasing the patterns missed:
# "**Half fixed** —", "**The `families` half FIXED in the repo (NOT applied)**",
# "app half fixed and live; the durable half is a migration waiting on F5",
# "a product decision —", "owner's tracked work."
STATUS = [
    ('REJECTED', re.compile(r'^\*{0,2}REJECTED', re.I)),
    ('PARTIAL',  re.compile(r'^\*{0,2}(Half fixed|The .{0,40}half FIXED|\w+ half fixed)', re.I)),
    ('PARTIAL',  re.compile(r'^\*{0,2}Fixed[^.]{0,60}\bhalf\b', re.I)),
    ('FIXED',    re.compile(r'^\*{0,2}(Fixed|Corrected|Repaired|Closed)\b', re.I)),
    ('OPEN',     re.compile(r'^\*{0,2}Open\b', re.I)),
    ('CHECKED',  re.compile(r'^\*{0,2}(Checked|Verified)\b', re.I)),
    # `Owner['’]?s`, both apostrophes, and that is not pedantry: this document is
    # written with typographic quotes, so a row opening "**Owner’s decision**" —
    # the natural way to type it here — fell through every pattern and indexed
    # BLANK. It did so silently, which is the failure that matters: a row whose
    # owner cannot act on it reads as one nobody has classified.
    ("OWNER'S",  re.compile(r"^\*{0,2}(Owner['’]?s|Deliberately NOT|a product decision|needs a|needs an|the naive fix)", re.I)),
    # BLOCKED and SUPERSEDED are the last two shapes, added once the six blank
    # rows were read one at a time rather than guessed at. Both READ a word the
    # row already uses, which is the rule the rest of this table follows:
    # F5/F-001's cell is literally "BLOCKED — operator" (a credentialed human
    # must run it; the guard is correct and must not be disabled), and F13's is
    # "SUPERSEDED — see below". Neither is OPEN and neither is FIXED, and
    # forcing either into one of those would have been the only way to reach
    # zero blanks by relabelling rather than by reading.
    ('BLOCKED',  re.compile(r'^\*{0,2}BLOCKED\b', re.I)),
    ('SUPERSEDED', re.compile(r'^\*{0,2}SUPERSEDED\b', re.I)),
]


def strip_md(text: str) -> str:
    text = re.sub(r'`([^`]*)`', r'\1', text)
    text = re.sub(r'\*\*([^*]*)\*\*', r'\1', text)
    text = re.sub(r'\*([^*]*)\*', r'\1', text)
    return re.sub(r'\s+', ' ', text).strip()


HEADING = re.compile(r'^#{1,2} +(.+?)\s*$')


def collect(path: str):
    """Rows outside the generated block, tagged with the section they live in.

    Two things this has to get right, both learned by getting them wrong:
    the generated table is itself full of `| **ID** |` rows, so a second run
    indexed the index and reported 182 rows; and a line number recorded before
    the block is spliced in is wrong by the height of the block afterwards.
    So the block is skipped on read, and the locator is the SECTION HEADING,
    which does not move when text is inserted above it.
    """
    out, seen, section, inside = [], {}, '(front matter)', False
    for line in open(path, encoding='utf-8').read().split('\n'):
        if line.startswith(BEGIN):
            inside = True
            continue
        if line.startswith(END):
            inside = False
            continue
        if inside:
            continue
        h = HEADING.match(line)
        if h:
            section = h.group(1).strip()
        m = ID_ROW.match(line)
        if not m:
            continue
        cells = CELLS.split(line)
        ident = re.sub(r'\s+', ' ', m.group(1)).strip()
        finding = cells[2].strip() if len(cells) > 2 else ''
        # A row `| a | b | c |` splits to ['', 'a', 'b', 'c', ''], so the last
        # MEANINGFUL cell is [-2]. Indexing a fixed [4] read the trailing empty
        # on every three-column table and left 21 statuses blank.
        last = cells[-2].strip() if len(cells) >= 3 else ''
        status = next((name for name, pat in STATUS if pat.match(last)), '')
        seen.setdefault(ident, 0)
        seen[ident] += 1
        out.append({'id': ident, 'section': section, 'finding': strip_md(finding),
                    'status': status, 'dup': seen[ident] > 1})
    return out


def table(rows) -> str:
    lines = ['| id | status | finding | in |', '|---|---|---|---|']
    for r in rows:
        headline = r['finding']
        headline = headline[:112].rstrip() + ('…' if len(headline) > 112 else '')
        headline = headline.replace('|', r'\|')
        note = ' *(restated)*' if r['dup'] else ''
        section = r['section'][:34].replace('|', r'\\|')
        lines.append(f"| **{r['id']}** | {r['status'] or '—'} | {headline}{note} | {section} |")
    return '\n'.join(lines)


def main() -> int:
    rows = collect(DOC)
    counts = {}
    for r in rows:
        counts[r['status'] or '—'] = counts.get(r['status'] or '—', 0) + 1
    header = (
        f'{len(rows)} finding rows, '
        f'{len({r["id"] for r in rows})} distinct ids. '
        + ' · '.join(f'{k} {v}' for k, v in sorted(counts.items()))
    )
    body = (f'{BEGIN}\n\n*Generated by `docs/audit/finding-index.py`. '
            f'{header}*\n\n{table(rows)}\n\n{END}')
    if '--write' not in sys.argv:
        print(body)
        return 0
    # A 29,000-line audit with no finding rows means the ID_ROW regex stopped
    # matching, not that the findings were all resolved. Writing an empty index
    # over a real one would destroy the thing this script exists to produce, and
    # it would do it while printing a success line.
    if not rows:
        print('REFUSING TO WRITE: no finding rows were parsed from '
              f'{DOC}. That is not a document with no findings — it is a '
              'document this parser can no longer read. Check ID_ROW against '
              'the table format before re-running.', file=sys.stderr)
        return 2

    doc = open(DOC, encoding='utf-8').read()
    if BEGIN in doc and END in doc:
        doc = doc[:doc.index(BEGIN)] + body + doc[doc.index(END) + len(END):]
    else:
        # `str.replace` returns the string UNCHANGED when the anchor is absent.
        # This branch used to do exactly that and then print "wrote the index",
        # so renaming the Release Gate heading would have frozen the index at
        # whatever it last held while every future run reported success —
        # and the prose-versus-generated cross-check would then compare prose
        # against a stale block and could agree while both were wrong.
        anchor = '## Release Gate'
        if anchor not in doc:
            print(f'REFUSING TO WRITE: {DOC} has neither the '
                  f'{BEGIN!r} / {END!r} markers nor the {anchor!r} heading to '
                  'insert them before, so there is nowhere to put the index. '
                  'Nothing was written. Restore one of them, or change `anchor` '
                  'to the heading that replaced it.', file=sys.stderr)
            return 2
        doc = doc.replace(anchor, f'## Finding index\n\n{body}\n\n{anchor}', 1)

    open(DOC, 'w', encoding='utf-8').write(doc)

    # Prove the write landed rather than trusting that it did — the whole class
    # of defect above is a success line printed over a no-op.
    written = open(DOC, encoding='utf-8').read()
    if BEGIN not in written or END not in written:
        print('WROTE, BUT THE BLOCK IS NOT THERE: the index was written to '
              f'{DOC} and reading it back finds no markers. Do not trust the '
              'line below.', file=sys.stderr)
        return 3

    print(f'wrote the index: {header}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
