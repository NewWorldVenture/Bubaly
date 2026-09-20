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

Exits non-zero if any table has a row whose cell count differs from its header,
naming the line. Defaults to finalaudit.md. This is a legibility check on the
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


def check(path: str) -> list[str]:
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
            if got != want:
                verb = 'dropped by the renderer' if got > want else 'left empty'
                problems.append(
                    f'{path}:{j + 1}: row has {got} cells, header declares {want} '
                    f'— {abs(got - want)} {verb}. '
                    f'An unescaped | inside a cell splits it; write \\| instead. '
                    f'First 90 chars: {lines[j][:90]}')
            j += 1
        i = j
    return problems


def main() -> int:
    paths = sys.argv[1:] or ['finalaudit.md']
    problems: list[str] = []
    for path in paths:
        problems.extend(check(path))
    for p in problems:
        print(p)
    print(f'\n{len(problems)} table row(s) would not render as written '
          f'across {len(paths)} file(s).')
    return 1 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
