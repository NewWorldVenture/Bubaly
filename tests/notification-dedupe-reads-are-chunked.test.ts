import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

// MAIN-F-014. The notification dedupe read put every candidate's related_id in
// one `.in()` filter. Those ids are composite strings (`moment:<eventId>:<date>`,
// about 60 characters encoded), so a few hundred built a request line past the
// gateway limit. The read failed "URI too long", `seen` came back empty, and
// every run re-notified everyone. Both dedupe reads now go through readInChunks
// at 50 per batch; nothing pinned that.

const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
const FILES = ['lib/server/notifications.ts', 'lib/services/approvals/index.ts'];

function chunkedFilters(source: string) {
  const tree = ts.createSourceFile('dedupe.ts', source, ts.ScriptTarget.Latest, true);
  const filters: ts.CallExpression[] = [];
  const authorized = new Set<ts.CallExpression>();
  const visit = (node: ts.Node, action: (node: ts.Node) => void) => {
    action(node);
    node.forEachChild(child => visit(child, action));
  };
  const isFilter = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'in'
    && !!node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'related_id';
  visit(tree, node => {
    if (isFilter(node)) filters.push(node);
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'readInChunks') return;
    const callback = node.arguments[1], width = node.arguments[2];
    if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      || !width || !ts.isNumericLiteral(width) || Number(width.text) <= 0 || Number(width.text) > 50) return;
    const parameter = callback.parameters[0]?.name;
    if (!parameter || !ts.isIdentifier(parameter)) return;
    visit(callback.body, child => {
      if (isFilter(child) && child.arguments[1] && ts.isIdentifier(child.arguments[1])
        && child.arguments[1].text === parameter.text) authorized.add(child);
    });
  });
  return { count: filters.length, invalid: filters.filter(filter => !authorized.has(filter)).map(filter => filter.getText(tree)) };
}

describe('a dedupe read by related_id travels in batches', () => {
  it.each(FILES)('%s filters related_id only on a chunk, at most 50 wide', (f) => {
    const src = code(f);
    const result = chunkedFilters(src);
    expect(result.count, 'the dedupe read is gone; re-read MAIN-F-014 before removing this').toBeGreaterThan(0);
    // Counted paging can nest its query factory inside the chunk callback;
    // inspect the actual call structure rather than its final expression.
    expect(result.invalid).toEqual([]);
  });

  it('recognizes nested counted queries but refuses wide, unbound or missing batches', () => {
    const nested = "readInChunks(ids, async (chunk) => { const query = () => db.from('notifications').in('related_id', chunk).order('id'); return readCountedRows(() => query().limit(1000), (from,to) => query().range(from,to), 20000, 'dedupe'); }, 50)";
    expect(chunkedFilters(nested)).toEqual({ count: 1, invalid: [] });
    for (const unsafe of [nested.replace('}, 50)', '}, 51)'), nested.replace('}, 50)', '}, 0)'),
      nested.replace('}, 50)', '}, width)'), nested.replace("'related_id', chunk", "'related_id', ids"),
      "db.from('notifications').in('related_id', ids)"]) {
      expect(chunkedFilters(unsafe).invalid).toHaveLength(1);
    }
  });

  it('a failed dedupe read is logged, never silently treated as "nothing seen"', () => {
    expect(code('lib/server/notifications.ts')).toContain("console.error('[notifications] dedup read failed'");
    expect(code('lib/services/approvals/index.ts')).toContain("console.error('[service:approvals] reminder dedupe read failed'");
  });
});
