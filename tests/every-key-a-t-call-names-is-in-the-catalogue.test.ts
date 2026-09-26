// Every key a t() call names is in the catalogue.
//
// THE GAP. lib/i18n/translate.ts resolves a key as `messages[key] ?? key`, so a
// key that is in NO catalogue does not throw, does not log and does not fall back
// to English: it renders ITSELF. A family gets a toast reading
// "captureShortcuts.layoutUnavailable" and nothing anywhere goes red.
//
// Nothing else asks this question:
//   • scripts/i18n-gate.mjs hunts hardcoded ENGLISH. A key is not English.
//   • tests/i18n-catalogue-integrity.test.ts compares the other locales against
//     en-US. A key missing from en-US is missing from all eleven, consistently.
//   • tests/i18n-client-scope.test.ts asks whether a scoped surface's slice
//     covers the keys its client components use — and filters to `key in
//     messages` first, so a key in no catalogue is dropped before it is judged.
//   • Unit tests that stub the translator as `(k) => messages[k] ?? k` resolve
//     a missing key to itself exactly as production does, and pass.
//
// So this reads every translator call in app/, components/, lib/ and shared/
// with the TypeScript parser — not a regex, so comments, strings that merely
// contain "t('…')", JSX and regex literals cannot fool it — and requires every
// LITERAL key to be in lib/i18n/messages/en-US.json, the catalogue every other
// locale is merged over.
//
// THE TRANSLATOR, AS THIS TREE ACTUALLY CALLS IT. Read before scanning, because
// a scanner that misreads the shape reports thousands of false misses or none:
//
//   • `useTranslations()` (components/i18n/locale-provider.tsx) and
//     `await getTranslations()` (lib/i18n/server.ts) take NO argument. There is
//     no namespaced translator here — no `useTranslations('ns')` that prefixes
//     keys — so the string at the call IS the whole catalogue key. That is an
//     assumption the scanner depends on, so it is asserted below, not trusted.
//   • `await getAIRequestTranslations(req)` (lib/server/ai-request-context.ts)
//     returns the same `(key, params) => string`, for native clients.
//   • They are bound as `t`, `tr` or `i18nT`; the same three names carry a
//     translator passed in as a parameter (`t: Translate`), a local
//     `const t = (key) => translate(messages, key)`, and one destructured from
//     a hook (`const { t } = useDecision(…)`).
//   • Inline, unbound: `(await getTranslations())('completeSetupCopy.title')`.
//   • As a member: `d.t('needsYouActions…')`, `input.t('contactTimeline…')`.
//   • Through a same-file wrapper that forwards a parameter straight to one of
//     the above: `word('todos.noDueDate', 'No due date')` in lib/chores/
//     dashboard.ts, `calendarNotice('homeCalendar.todayUnavailable')`. The key
//     is literal at the WRAPPER's call site, so it is checked there.
//
// A key that is not a literal at the call — `t(\`trustRole.${r}\`)`,
// `t(item.labelKey)`, `t(REASON[code] ?? 'actions.x')` — cannot be judged from
// source. Those calls are COUNTED and printed, never silently skipped and never
// failed on; any literal branch of a `?:`, `??` or `||` inside them is still
// checked.
//
// WHAT WAS ALREADY MISSING. Three keys were in no catalogue when this landed.
// They are pinned, by name, as MISSING_AT_HEAD below — the shrink-only idiom of
// tests/the-currency-symbol-is-not-a-literal.test.ts, but by identity rather
// than by count, so fixing one forces its removal here and a new one fails
// even if another is fixed in the same commit.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import enUS from '@/lib/i18n/messages/en-US.json';

const ROOT = process.cwd();
const CATALOGUE: ReadonlySet<string> = new Set(Object.keys(enUS as Record<string, string>));

/** Where the app's source lives. tests/ is excluded on purpose, and so is mobile/:
 *  it is a separate Expo app with its own catalogue. */
const SOURCE_ROOTS = ['app', 'components', 'lib', 'shared'];
const SKIP = new Set(['node_modules', '.next', '.git']);

/** The names a translator is bound to. Asserted complete below. */
const TRANSLATOR_NAMES: ReadonlySet<string> = new Set(['t', 'tr', 'i18nT']);
/** The calls that return a translator. */
const FACTORIES: ReadonlySet<string> = new Set(['useTranslations', 'getTranslations', 'getAIRequestTranslations']);
/** The two that would take a namespace, if this codebase ever grew one. */
const MUST_TAKE_NO_ARGUMENT: ReadonlySet<string> = new Set(['useTranslations', 'getTranslations']);
/** Type names a translator parameter or property is declared with. */
const TRANSLATOR_TYPE = /^(?:[A-Z]\w*)?(?:Translate|Translator)$|^ReturnType<typeof useTranslations>$|^Awaited<ReturnType<typeof getTranslations>>$/;

type LiteralSite = { file: string; line: number; key: string; shape: string };
type DynamicSite = { file: string; line: number; shape: string; expression: string };
type Scan = {
  literal: LiteralSite[];
  dynamic: DynamicSite[];
  /** A translator bound to, and called by, a name the scanner does not read — it is blind there. */
  unscannedBindings: string[];
  /** `useTranslations('ns')` — a namespace the scanner does not prefix. */
  namespaced: string[];
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)
    || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n)
  ) n = n.expression;
  return n;
}

const isFactoryCall = (node: ts.Expression): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && FACTORIES.has(node.expression.text);

/** The shape of translator a callee is — `t`, `.t`, `(await getTranslations())` — or null. */
function translatorShape(callee: ts.Expression): string | null {
  const c = unwrap(callee);
  if (ts.isIdentifier(c)) return TRANSLATOR_NAMES.has(c.text) ? c.text : null;
  if (ts.isPropertyAccessExpression(c)) return TRANSLATOR_NAMES.has(c.name.text) ? `.${c.name.text}` : null;
  if (ts.isAwaitExpression(c)) {
    const inner = unwrap(c.expression);
    return isFactoryCall(inner) ? `(await ${(inner.expression as ts.Identifier).text}())` : null;
  }
  return isFactoryCall(c) ? `${(c.expression as ts.Identifier).text}()` : null;
}

/** The expressions that can end up as the key: through `?:`, `??` and `||`. */
function keyLeaves(node: ts.Expression): ts.Expression[] {
  const n = unwrap(node);
  if (ts.isConditionalExpression(n)) return [...keyLeaves(n.whenTrue), ...keyLeaves(n.whenFalse)];
  if (ts.isBinaryExpression(n) && (
    n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken
  )) return [...keyLeaves(n.left), ...keyLeaves(n.right)];
  return [n];
}

const isLiteral = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

/** The name of a function-like node, if it has one a same-file caller can use. */
function functionName(fn: ts.SignatureDeclaration): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
    && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return null;
}

/** If `id` is a parameter of an enclosing NAMED function, that function and the index. */
function forwardedParameter(id: ts.Identifier): { name: string; index: number } | null {
  for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
    if (!ts.isFunctionLike(p)) continue;
    const index = p.parameters.findIndex((param) => ts.isIdentifier(param.name) && param.name.text === id.text);
    if (index < 0) continue;
    const name = functionName(p);
    return name ? { name, index } : null;
  }
  return null;
}

/** Scan one module's source. Pure: it reads nothing but the string it is given. */
function scanSource(file: string, source: string): Scan {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const scan: Scan = { literal: [], dynamic: [], unscannedBindings: [], namespaced: [] };
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const where = (n: ts.Node) => `${file}:${lineOf(n)}`;
  const wrappers = new Map<string, number>(); // same-file function → index of the key it forwards
  const otherBindings: { name: string; at: string }[] = [];
  const calledNames = new Set<string>();

  const judge = (arg: ts.Expression | undefined, call: ts.CallExpression, shape: string) => {
    if (!arg) { scan.dynamic.push({ file, line: lineOf(call), shape, expression: '(no argument)' }); return; }
    let dynamic = false;
    for (const leaf of keyLeaves(arg)) {
      if (isLiteral(leaf)) scan.literal.push({ file, line: lineOf(leaf), key: leaf.text, shape });
      else dynamic = true;
    }
    if (dynamic) scan.dynamic.push({ file, line: lineOf(call), shape, expression: arg.getText(sf).replace(/\s+/g, ' ') });
  };

  const checkBindingName = (name: ts.BindingName | ts.PropertyName, at: ts.Node, what: string) => {
    const text = ts.isIdentifier(name) ? name.text : name.getText(sf);
    if (!TRANSLATOR_NAMES.has(text)) otherBindings.push({ name: text, at: `${where(at)} ${what} bound to \`${text}\`` });
  };

  const makesTranslator = (init: ts.Expression): boolean => {
    const n = unwrap(ts.isAwaitExpression(unwrap(init)) ? (unwrap(init) as ts.AwaitExpression).expression : init);
    if (isFactoryCall(n)) return true;
    if (ts.isConditionalExpression(n)) return makesTranslator(n.whenTrue) || makesTranslator(n.whenFalse);
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && !ts.isBlock(n.body)) {
      const body = unwrap(n.body);
      return ts.isCallExpression(body) && ts.isIdentifier(body.expression) && body.expression.text === 'translate';
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee)) calledNames.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) calledNames.add(callee.name.text);
      if (ts.isIdentifier(callee) && MUST_TAKE_NO_ARGUMENT.has(callee.text) && node.arguments.length > 0) {
        scan.namespaced.push(`${where(node)} ${node.getText(sf).slice(0, 80)}`);
      }
      const shape = translatorShape(node.expression);
      if (shape) {
        const arg = node.arguments[0];
        judge(arg, node, shape);
        if (arg && ts.isIdentifier(unwrap(arg))) {
          const fwd = forwardedParameter(unwrap(arg) as ts.Identifier);
          if (fwd) wrappers.set(fwd.name, fwd.index);
        }
      }
    }
    // Completeness: a translator bound to any other name is a call this scanner cannot see.
    if (ts.isVariableDeclaration(node) && node.initializer && makesTranslator(node.initializer)) {
      checkBindingName(node.name, node, 'a translator is');
    }
    if (ts.isPropertyAssignment(node) && makesTranslator(node.initializer)) {
      checkBindingName(node.name, node, 'a translator is');
    }
    if ((ts.isParameter(node) || ts.isPropertySignature(node)) && node.type && TRANSLATOR_TYPE.test(node.type.getText(sf))) {
      checkBindingName(node.name, node, `a \`${node.type.getText(sf)}\` is`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // Only a binding that is then CALLED blinds the scan. lib/supabase/server.ts binds
  // `defaultServiceTranslate` purely as a parameter default, and calls it as `t`.
  for (const b of otherBindings) if (calledNames.has(b.name)) scan.unscannedBindings.push(b.at);

  // Second pass: the call sites of same-file wrappers, where their keys are literal.
  if (wrappers.size > 0) {
    const visitWrapperCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && wrappers.has(node.expression.text)) {
        const arg = node.arguments[wrappers.get(node.expression.text)!];
        for (const leaf of arg ? keyLeaves(arg) : []) {
          if (isLiteral(leaf)) scan.literal.push({ file, line: lineOf(leaf), key: leaf.text, shape: `${node.expression.text}()` });
        }
        // A non-literal here needs no second count: the translator call inside the
        // wrapper, `t(key)`, is already counted as dynamic.
      }
      ts.forEachChild(node, visitWrapperCalls);
    };
    visitWrapperCalls(sf);
  }
  return scan;
}

function scanTree(): Scan & { files: number } {
  const files = SOURCE_ROOTS.flatMap((dir) => walk(join(ROOT, dir)));
  const all: Scan & { files: number } = { literal: [], dynamic: [], unscannedBindings: [], namespaced: [], files: files.length };
  for (const full of files) {
    const s = scanSource(relative(ROOT, full), readFileSync(full, 'utf8'));
    all.literal.push(...s.literal);
    all.dynamic.push(...s.dynamic);
    all.unscannedBindings.push(...s.unscannedBindings);
    all.namespaced.push(...s.namespaced);
  }
  return all;
}

const missingFrom = (sites: LiteralSite[]) => sites.filter((s) => !CATALOGUE.has(s.key));

/**
 * The keys that were ALREADY in no catalogue when this guard landed.
 *
 * Shrink-only. Identity is the file and the key; the line is for the reader and
 * is deliberately not compared, so an unrelated edit above the call does not
 * fail this. Fix one — add the key to en-US.json (and its translations), or
 * stop asking for it — and delete its row in the same commit.
 */
const MISSING_AT_HEAD: readonly { file: string; line: number; key: string; note: string }[] = [
  // Empty. When this guard was built it pinned three keys missing from committed
  // code, each a real defect: economy/actions.ts and wallet/invest/actions.ts
  // interpolated a catalogue KEY into an English fallback ("Could not
  // actions.decideTheRedemption."), and visual-mocks.tsx compared the device
  // IDENTIFIER 'Web App' with translated text, so the Web App card fell through
  // to the Smart Display artwork. All three were fixed in code rather than by
  // adding the keys — the fallback now shows the caller's translated message,
  // and the artwork compares identifiers — in the same commit as this guard.
];

describe('every key a t() call names is in the catalogue', () => {
  const tree = scanTree();
  const missing = missingFrom(tree.literal);

  const byShape = new Map<string, number>();
  for (const s of tree.literal) byShape.set(s.shape, (byShape.get(s.shape) ?? 0) + 1);
  console.info([
    `[i18n keys] ${tree.files} source files; ${tree.literal.length} literal keys checked against en-US.json; `
      + `${tree.dynamic.length} translator calls with a key that is not a literal (counted, not checked); `
      + `${missing.length} literal keys in no catalogue.`,
    `[i18n keys] literal keys by call shape: ${[...byShape].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  ].join('\n'));

  it('reads the translator in every shape this tree binds it', () => {
    expect(tree.namespaced, [
      'A translator factory was called WITH an argument. If that is a namespace, every key at its call',
      'sites is a suffix, and this scanner (which reads the literal as the whole key) will report every',
      'one of them as missing. Teach scanSource the prefix before landing it.',
      ...tree.namespaced.map((s) => `  ${s}`),
    ].join('\n')).toEqual([]);
    expect(tree.unscannedBindings, [
      `A translator is bound to a name outside ${[...TRANSLATOR_NAMES].join(', ')}, so every key passed to it is`,
      'invisible to this scan. Use one of those names, or add the new one to TRANSLATOR_NAMES.',
      ...tree.unscannedBindings.map((s) => `  ${s}`),
    ].join('\n')).toEqual([]);
  });

  // Positive control. A blind scanner finds nothing, and "nothing missing" is then
  // a pass. So it must find known-present keys at known call sites — one per shape.
  it('sees known keys at known call sites, in every shape', () => {
    const known: { file: string; key: string; shape: string }[] = [
      { file: 'components/capture/capture-shortcuts.tsx', key: 'captureShortcuts.layoutUnavailable', shape: 't' },
      { file: 'app/(app)/admin/admins/page.tsx', key: 'admins.admin', shape: 'tr' },
      { file: 'app/(app)/home/page.tsx', key: 'home.remaining', shape: 'i18nT' },
      { file: 'app/(app)/dashboard/setup/page.tsx', key: 'completeSetupCopy.title', shape: '(await getTranslations())' },
      { file: 'app/(app)/dashboard/needs-you/actions.ts', key: 'needsYouActions.thatSuggestionCouldNotBe', shape: '.t' },
      // A leaf of `input.t(outbound ? 'contactTimeline.reachedOut' : 'contactTimeline.heardFrom')`.
      { file: 'lib/contacts/timeline.ts', key: 'contactTimeline.heardFrom', shape: '.t' },
      // Through a same-file wrapper: `word('todos.noDueDate', 'No due date')`.
      { file: 'lib/chores/dashboard.ts', key: 'todos.noDueDate', shape: 'word()' },
    ];
    for (const k of known) {
      expect(CATALOGUE.has(k.key), `${k.key} is a real catalogue key`).toBe(true);
      const hit = tree.literal.find((s) => s.file === k.file && s.key === k.key && s.shape === k.shape);
      expect(hit, `the scanner found ${k.shape}('${k.key}') in ${k.file}`).toBeDefined();
    }
    // And it is reading the tree, not a corner of it: there are thousands.
    expect(tree.literal.length).toBeGreaterThan(10_000);
    expect(tree.dynamic.length).toBeGreaterThan(0);
  });

  // Negative control. The scanner is pure, so it can be handed a module that asks
  // for a key no catalogue can hold, and must report it — in each shape.
  it('reports a key that is in no catalogue, and nothing that only looks like one', () => {
    const absent = (tag: string) => `negativeControl.${tag}NotInAnyCatalogue`;
    const PRESENT = 'captureShortcuts.layoutUnavailable';
    expect(CATALOGUE.has(PRESENT)).toBe(true);
    for (const tag of ['bound', 'ternary', 'inline', 'member', 'wrapper', 'fallback']) {
      expect(CATALOGUE.has(absent(tag)), `${absent(tag)} must not exist for this control to mean anything`).toBe(false);
    }
    const source = [
      "import { getTranslations } from '@/lib/i18n/server';",
      'export async function action(ok: boolean, d: { t: (k: string) => string }, code: string) {',
      '  const t = await getTranslations();',
      `  const a = t('${absent('bound')}');`,                                              // line 4
      `  const b = t(ok ? '${PRESENT}' : '${absent('ternary')}');`,                        // line 5
      `  const c = (await getTranslations())('${absent('inline')}');`,                     // line 6
      `  const e = d.t('${absent('member')}');`,                                           // line 7
      `  const f = t(REASONS[code] ?? '${absent('fallback')}');`,                          // line 8
      '  const notice = (key: string) => t(key);',
      `  const g = notice('${absent('wrapper')}');`,                                       // line 10
      '  const h = t(`negativeControl.${code}`);',                                         // dynamic, counted
      "  // t('negativeControl.inACommentIsNotACall')",
      "  const i = \"t('negativeControl.inAStringIsNotACall')\";",
      "  const j = format('negativeControl.notATranslator');",
      `  const k = t('${PRESENT}');`,
      '  return [a, b, c, e, f, g, h, i, j, k];',
      '}',
    ].join('\n');
    const scan = scanSource('synthetic/negative-control.ts', source);
    const reported = missingFrom(scan.literal).map((s) => `${s.line} ${s.shape} ${s.key}`);
    expect(reported).toEqual([
      `4 t ${absent('bound')}`,
      `5 t ${absent('ternary')}`,
      `6 (await getTranslations()) ${absent('inline')}`,
      `7 .t ${absent('member')}`,
      `8 t ${absent('fallback')}`,
      `10 notice() ${absent('wrapper')}`,
    ]);
    // Present keys are checked and pass; dynamic keys are counted, never reported.
    expect(scan.literal.filter((s) => s.key === PRESENT)).toHaveLength(2);
    expect(scan.dynamic.map((d) => d.expression)).toEqual([
      "REASONS[code] ?? 'negativeControl.fallbackNotInAnyCatalogue'",
      'key',
      '`negativeControl.${code}`',
    ]);

    // …and the two ways the scanner could go blind are themselves reported.
    const blind = scanSource('synthetic/blind.tsx', [
      'const translate2 = useTranslations();',
      "const scoped = useTranslations('captureShortcuts');",
      "export const x = [translate2('captureShortcuts.layoutUnavailable'), scoped('layoutUnavailable')];",
    ].join('\n'));
    expect(blind.unscannedBindings).toHaveLength(2);
    expect(blind.namespaced).toHaveLength(1);
  });

  it('holds the keys already missing at HEAD, by name, and adds none', () => {
    const identity = (m: { file: string; key: string }) => `${m.file}  ${m.key}`;
    const now = missing.map(identity).sort();
    const pinned = MISSING_AT_HEAD.map(identity).sort();
    const added = missing.filter((m) => !pinned.includes(identity(m)));
    const fixed = MISSING_AT_HEAD.filter((m) => !now.includes(identity(m)));
    expect(now, [
      ...(added.length > 0 ? [
        'A translator is asked for a key that is in NO catalogue, so it renders as the key itself:',
        ...added.map((m) => `  ${m.file}:${m.line}  ${m.shape}('${m.key}')`),
        'Add it to lib/i18n/messages/en-US.json (and the translations), or ask for a key that exists.',
      ] : []),
      ...(fixed.length > 0 ? [
        'Fixed — delete these rows from MISSING_AT_HEAD in this commit, so they cannot come back:',
        ...fixed.map((m) => `  ${m.file}:${m.line}  '${m.key}'`),
      ] : []),
    ].join('\n')).toEqual(pinned);
  });
});
