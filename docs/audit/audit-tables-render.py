#!/usr/bin/env python3
"""Do the Markdown tables in finalaudit.md actually render every cell they hold?

A GFM table drops cells beyond the count its HEADER declares. So a table whose
header names three columns while its rows carry four does not show a truncated
fourth column — it shows nothing, silently, and the row reads as if that content
was never written.

That is what was happening in the "§3 High Priority" open-findings table: the
header was `| id | finding | why it is still open |` while 28 of its 35 rows
were `| id | finding | found in | why it is still open |`. The dropped column
was *why it is still open* — the single most load-bearing cell in an audit of
what remains open. The text was in the file and invisible in the render.

The second failure mode is a literal `|` inside a cell. A pipe splits a cell
even inside a code span, so `failures := failures || 'text'` silently became
three cells, and `(12 tests, 1 failed | 11 passed)` became two.

    python3 docs/audit/audit-tables-render.py [file ...]

Exits non-zero only for rows that LOSE content — more cells than the header
declares. A row with FEWER cells is reported too, but does not fail: GFM pads it
with blanks, so everything written still renders. Conflating the two would make
the check cry wolf over a table whose columns were merged but whose text is all
on the page. Defaults to finalaudit.md. This is a legibility check on the
DOCUMENT, deliberately not wired into CI: other agents edit this file too, and a
red build over someone's prose is not the point. Run it after editing a table.
"""
import re
import sys

SEP = re.compile(r'\|[\s:\-|]+\|')
UNESCAPED_PIPE = re.compile(r'(?<!\\)\|')


def cell_count(line: str) -> int:
    parts = UNESCAPED_PIPE.split(line)
    stripped = line.strip()
    if stripped.startswith('|') and stripped.endswith('|'):
        return len(parts) - 2
    return len(parts) - 1


def check(path: str, shortfall: list[str]) -> list[str]:
    """Return the rows that LOSE content; append merely-short rows to shortfall."""
    problems: list[str] = []
    lines = open(path, encoding='utf-8').read().split('\n')
    i = 0
    while i < len(lines):
        is_header = (
            lines[i].strip().startswith('|')
            and i + 1 < len(lines)
            and SEP.fullmatch(lines[i + 1].strip())
        )
        if not is_header:
            i += 1
            continue
        want = cell_count(lines[i])
        if cell_count(lines[i + 1]) != want:
            problems.append(
                f'{path}:{i + 2}: separator declares {cell_count(lines[i + 1])} columns, '
                f'header declares {want}')
        j = i + 2
        while j < len(lines) and lines[j].strip().startswith('|'):
            got = cell_count(lines[j])
            if got > want:
                # Content loss: GFM discards every cell past the header count.
                problems.append(
                    f'{path}:{j + 1}: LOSS — row has {got} cells, header declares '
                    f'{want}, so {got - want} cell(s) are DISCARDED by the renderer. '
                    f'A | inside a cell splits it even within a code span; write \\| '
                    f'instead. First 90 chars: {lines[j][:90]}')
            elif got < want:
                # Not content loss: GFM pads a short row with empty cells, so
                # everything written still renders. Reported because a column
                # that is empty on most rows usually means two columns were
                # merged when the row was written — but nothing is missing, and
                # splitting it again is a judgement about meaning that this
                # script has no business making.
                shortfall.append(
                    f'{path}:{j + 1}: short — row has {got} cells, header declares '
                    f'{want}; the renderer pads the missing {want - got} with blanks, '
                    f'so no text is lost. First 90 chars: {lines[j][:90]}')
            j += 1
        i = j
    return problems


def main() -> int:
    paths = sys.argv[1:] or ['finalaudit.md']
    problems: list[str] = []
    shortfall: list[str] = []
    for path in paths:
        problems.extend(check(path, shortfall))
    for p in problems:
        print(p)
    for s_ in shortfall:
        print(s_)
    print(f'\n{len(problems)} row(s) lose content; {len(shortfall)} row(s) are '
          f'short but lose none, across {len(paths)} file(s).')
    # Only content loss fails. A short row renders everything it holds.
    return 1 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
