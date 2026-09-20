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
    ("OWNER'S",  re.compile(r"^\*{0,2}(Owner'?s|Deliberately NOT|a product decision|needs a|needs an|the naive fix)", re.I)),
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
    doc = open(DOC, encoding='utf-8').read()
    if BEGIN in doc and END in doc:
        doc = doc[:doc.index(BEGIN)] + body + doc[doc.index(END) + len(END):]
    else:
        anchor = '## Release Gate'
        doc = doc.replace(anchor, f'## Finding index\n\n{body}\n\n{anchor}', 1)
    open(DOC, 'w', encoding='utf-8').write(doc)
    print(f'wrote the index: {header}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
