import { readFileSync } from 'node:fs';
import ts from 'typescript';
import colors from 'tailwindcss/colors';
import defaultTheme from 'tailwindcss/defaultTheme';
import tailwindConfig from '../../tailwind.config';
import { bodyOf } from './source-order';

// The kitchen display's text, read from the JSX with the TypeScript parser and
// composed through every surface the browser paints under it.
//
// A text's ground is not one class. The timer picker's duration is white/70 on
// a white/10 button, white/20 while hovered, inside the grid's white/6 tile,
// over the ink scrim over the wash; the setup guide's label is white on
// white/15, white/25 hovered, inside its own white/7 card. Composing only the
// innermost surface (as the ambient-wash test first did) misses both. So this
// walks each element up through its parents, through the component that mounts
// it (KitchenTimers inside WidgetBody inside a grid tile), and composes, per
// state, what each layer paints:
//
//   - idle; hovered (`hover:` and `group-hover:` of the element and of every
//     ancestor, since a pointer over a child is over its parents); focused
//     (`focus:`, `focus-visible:`, `focus-within:`);
//   - an animation's faintest frame: a looping `animate-*` takes the element's
//     opacity down to the lowest value in its keyframes (Tailwind's own, read
//     from the config), so white/70 under `animate-pulse` is white/35 there;
//   - `cn()` alternatives (`a && 'x'`, `a ? 'x' : 'y'`) as separate variants,
//     with later classes winning as twMerge resolves them, and conditions kept
//     consistent across one rendering (`isNow && 'bg-white/10'` on a row cannot
//     combine with a span rendered under `isNext && !isNow`);
//   - an earlier sibling laid across the box (`absolute inset-0`: a progress
//     bar, a glow, a pulsing wash) as a layer under the siblings after it.
//
// Arithmetic, not a measurement: alpha compositing in sRGB, as browsers blend,
// and WCAG 2 relative luminance. tests/e2e/the-kitchen-display-text-is-readable-
// on-its-ambient-wash.spec.ts measures the same controls in Chromium's pixels.

export type Rgb = number[];

const channel = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminance = (c: Rgb) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
export const contrast = (a: Rgb, b: Rgb) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** `top` at `alpha` over an opaque `under`. */
export const over = (top: Rgb, alpha: number, under: Rgb): Rgb => top.map((v, i) => v * alpha + under[i] * (1 - alpha));
export const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// ── Reading the JSX ───────────────────────────────────────────────────────────

/** A condition a class or an element was rendered under, scoped to its component. */
type Literal = { cond: string; value: boolean };
/** One way an element's className can come out: its classes and what made them. */
export type Variant = { classes: string[]; when: Literal[] };

export type Node = {
  file: string; line: number; tag: string;
  /** The function component this element is written in. */
  component: string;
  variants: Variant[];
  /** The conditions it is rendered under: `{a && <x />}`, `{a ? <x /> : <y />}`. */
  renderWhen: Literal[];
  parent: Node | null;
  children: Node[];
  /** Earlier siblings, in source order (for absolutely positioned layers). */
  before: Node[];
  /** It has text children: words, or an expression that is not JSX. */
  text: boolean;
  /** Its text children as written (`{formatDuration(p.seconds)}`), to find it by. */
  says: string;
};

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const unwrap = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);

function literals(component: string, cond: ts.Expression, value: boolean): Literal[] {
  const e = unwrap(cond);
  if (value && ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...literals(component, e.left, true), ...literals(component, e.right, true)];
  }
  if (!value) {
    // The negation of a conjunction is a disjunction: nothing certain to assert.
    const pos = literals(component, e, true);
    return pos.length === 1 ? [{ ...pos[0], value: !pos[0].value }] : [];
  }
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    return literals(component, e.operand, false);
  }
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(e.operatorToken.kind)) {
    return [{ cond: `${component}::${squash(e.left.getText())} === ${squash(e.right.getText())}`, value: false }];
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) {
    return [{ cond: `${component}::${squash(e.left.getText())} === ${squash(e.right.getText())}`, value: true }];
  }
  return [{ cond: `${component}::${squash(e.getText())}`, value: true }];
}

const product = (sets: Variant[][]): Variant[] => sets.reduce<Variant[]>(
  (acc, set) => acc.flatMap((a) => set.map((b) => ({ classes: [...a.classes, ...b.classes], when: [...a.when, ...b.when] }))),
  [{ classes: [], when: [] }],
);

/** Every way a className expression can come out. */
function classVariants(component: string, expr: ts.Expression, consts: Map<string, string>): Variant[] {
  const e = unwrap(expr);
  const words = (s: string): Variant[] => [{ classes: s.split(/\s+/).filter(Boolean), when: [] }];
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return words(e.text);
  if (ts.isTemplateExpression(e)) {
    return product([words(e.head.text), ...e.templateSpans.flatMap((s) => [classVariants(component, s.expression, consts), words(s.literal.text)])]);
  }
  if (ts.isCallExpression(e) && ['cn', 'clsx'].includes(e.expression.getText())) {
    return product(e.arguments.map((a) => classVariants(component, a, consts)));
  }
  if (ts.isArrayLiteralExpression(e)) return product(e.elements.map((a) => classVariants(component, a, consts)));
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [
      ...classVariants(component, e.right, consts).map((v) => ({ ...v, when: [...literals(component, e.left, true), ...v.when] })),
      { classes: [], when: literals(component, e.left, false) },
    ];
  }
  if (ts.isConditionalExpression(e)) {
    return [
      ...classVariants(component, e.whenTrue, consts).map((v) => ({ ...v, when: [...literals(component, e.condition, true), ...v.when] })),
      ...classVariants(component, e.whenFalse, consts).map((v) => ({ ...v, when: [...literals(component, e.condition, false), ...v.when] })),
    ];
  }
  if (ts.isIdentifier(e) && consts.has(e.text)) return words(consts.get(e.text)!);
  // A computed class (sizeClass(tile.size)) or an unknown: nothing to compose.
  return [{ classes: [], when: [] }];
}

function containsJsx(n: ts.Node): boolean {
  if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return true;
  return ts.forEachChild(n, containsJsx) ?? false;
}

/** Every JSX element in a file, with its parents, variants and render conditions. */
export function readJsx(file: string, source = readFileSync(file, 'utf8')): Node[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const consts = new Map<string, string>();
  const nodes: Node[] = [];
  const visit = (n: ts.Node, parent: Node | null, conds: Literal[], component: string): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer))) {
      consts.set(n.name.text, n.initializer.text);
    }
    if (ts.isFunctionDeclaration(n) && n.name) { component = n.name.text; parent = null; conds = []; }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^[A-Z]/.test(n.name.text) && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      component = n.name.text; parent = null; conds = [];
    }
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const open = ts.isJsxElement(n) ? n.openingElement : n;
      const attr = open.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === 'className');
      const init = attr?.initializer;
      const expr = !init ? undefined : ts.isJsxExpression(init) ? init.expression : init;
      const children = ts.isJsxElement(n) ? n.children : ts.factory.createNodeArray<ts.JsxChild>();
      const node: Node = {
        file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, tag: open.tagName.getText(), component,
        variants: expr ? classVariants(component, expr, consts) : [{ classes: [], when: [] }],
        renderWhen: conds, parent, children: [], before: parent ? [...parent.children] : [],
        text: children.some((c) => (ts.isJsxText(c) && !c.containsOnlyTriviaWhiteSpaces)
          || (ts.isJsxExpression(c) && !!c.expression && !containsJsx(c.expression))),
        says: squash(children.filter((c) => ts.isJsxText(c) || (ts.isJsxExpression(c) && !!c.expression && !containsJsx(c.expression))).map((c) => c.getText()).join(' ')),
      };
      parent?.children.push(node);
      nodes.push(node);
      // Attributes are not children (a `fallback={<x />}` renders elsewhere).
      for (const c of children) visit(c, node, [], component);
      return;
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && containsJsx(n.right)) {
      visit(n.left, parent, conds, component);
      visit(n.right, parent, [...conds, ...literals(component, n.left, true)], component);
      return;
    }
    if (ts.isConditionalExpression(n) && (containsJsx(n.whenTrue) || containsJsx(n.whenFalse))) {
      visit(n.condition, parent, conds, component);
      visit(n.whenTrue, parent, [...conds, ...literals(component, n.condition, true)], component);
      visit(n.whenFalse, parent, [...conds, ...literals(component, n.condition, false)], component);
      return;
    }
    ts.forEachChild(n, (c) => visit(c, parent, conds, component));
  };
  visit(sf, null, [], '');
  return nodes;
}

/**
 * Each chain of elements a node is painted inside, outermost first, following
 * a component up to every place it is mounted, until `root`.
 */
export function mountChains(node: Node, all: Node[], root: string, seen: string[] = []): Node[][] {
  const local: Node[] = [];
  for (let p: Node | null = node; p; p = p.parent) local.unshift(p);
  if (node.component === root) return [local];
  if (!node.component || seen.includes(node.component)) return [];
  return all.filter((u) => u.tag === node.component)
    .flatMap((u) => mountChains(u, all, root, [...seen, node.component]).map((c) => [...c, ...local]));
}

// ── Painting ──────────────────────────────────────────────────────────────────

export type State = { hover: boolean; focus: boolean; trough: boolean };
export const STATES: Record<string, State> = {
  idle: { hover: false, focus: false, trough: false },
  hovered: { hover: true, focus: false, trough: false },
  focused: { hover: false, focus: true, trough: false },
  'faintest frame': { hover: false, focus: false, trough: true },
  'hovered, faintest frame': { hover: true, focus: false, trough: true },
};

const HOVER = new Set(['hover', 'group-hover']);
const FOCUS = new Set(['focus', 'focus-visible', 'focus-within', 'group-focus', 'group-focus-within', 'group-focus-visible']);
const SCREEN = new Set(Object.keys((tailwindConfig.theme as { screens: Record<string, string> }).screens));

/** The token's base when it applies in `state`, with whether a state variant chose it. */
function applies(token: string, state: State): { base: string; variant: boolean } | null {
  const parts = token.split(':');
  const base = parts.pop()!;
  let variant = false;
  for (const p of parts) {
    if (HOVER.has(p) && state.hover) variant = true;
    else if (FOCUS.has(p) && state.focus) variant = true;
    else if (!SCREEN.has(p)) return null; // disabled:, placeholder:, dark: … : not this state
  }
  return { base, variant };
}

let brand: Rgb[] | undefined;
/** `--brand` in each theme block of app/globals.css (bg-brand is `rgb(var(--brand))`). */
const brandValues = (): Rgb[] => (brand ??= [...readFileSync('app/globals.css', 'utf8').matchAll(/--brand:\s*(\d+)\s+(\d+)\s+(\d+);/g)]
  .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]));
const NOT_A_COLOUR = /^(xs|sm|base|lg|\d?xl|left|right|center|justify|start|end|ellipsis|clip|wrap|nowrap|balance|pretty|\[\d.*\])$/;
const NOT_A_FILL = /^(cover|contain|center|top|bottom|left|right|fixed|local|scroll|repeat|no-repeat|repeat-x|repeat-y|origin-.+|clip-.+|blend-.+|gradient-to-.+|none|\[url.+\])$/;

export type Paint = { rgb: Rgb[]; alpha: number };
export const unresolved = new Set<string>();

/** `bg-white/10`, `text-emerald-200`, `bg-white/[0.07]`, `bg-[#0b1020]/75`, `bg-brand` → colours and alpha. */
function paint(kind: string, token: string): Paint | null | undefined {
  const m = token.match(new RegExp(`^${kind}-(.+?)(?:/(\\d+|\\[[\\d.]+\\]))?$`));
  if (!m) return undefined;
  const name = m[1];
  if ((kind === 'text' && NOT_A_COLOUR.test(name)) || (kind === 'bg' && NOT_A_FILL.test(name))) return undefined;
  const alpha = m[2] === undefined ? 1 : m[2].startsWith('[') ? Number(m[2].slice(1, -1)) : Number(m[2]) / 100;
  if (name === 'transparent' || name === 'current' || name === 'inherit') return null;
  let rgb: Rgb[] | null = null;
  const named = name.match(/^([a-z]+)-(\d{2,3})$/);
  const pal = colors as unknown as Record<string, Record<string, string> | string>;
  if (name === 'white') rgb = [[255, 255, 255]];
  else if (name === 'black') rgb = [[0, 0, 0]];
  else if (name === 'brand') rgb = brandValues();
  else if (/^\[#[0-9a-fA-F]{6}\]$/.test(name)) rgb = [hex(name.slice(1, -1))];
  else if (named && typeof pal[named[1]] === 'object' && (pal[named[1]] as Record<string, string>)[named[2]]) rgb = [hex((pal[named[1]] as Record<string, string>)[named[2]])];
  if (!rgb) { unresolved.add(`${kind}-${name}`); return undefined; }
  return { rgb, alpha };
}

/**
 * The last class of a kind that applies in a state; a state variant (`hover:`)
 * outranks the base class, as its pseudo-class does in the cascade. `null` is
 * an explicit transparent, `undefined` no class at all.
 */
function last(classes: string[], state: State, kind: string): Paint | null | undefined {
  let base: Paint | null | undefined; let chosen: Paint | null | undefined;
  for (const token of classes) {
    const a = applies(token, state); if (!a) continue;
    const p = paint(kind, a.base); if (p === undefined) continue;
    if (a.variant) chosen = p; else base = p;
  }
  return chosen !== undefined ? chosen : base;
}

/** What an element fills its box with, as alternatives (a gradient's stops are each the worst case somewhere). */
function fills(classes: string[], state: State): Paint[] {
  const gradient = classes.some((c) => applies(c, state)?.base.startsWith('bg-gradient-to-'));
  const stops = gradient ? (['from', 'via', 'to'] as const).map((k) => last(classes, state, k)) : [last(classes, state, 'bg')];
  const real = stops.filter((p): p is Paint => !!p);
  return real.length < stops.filter((p) => p !== undefined).length ? [...real, { rgb: [], alpha: 0 }] : real;
}

const fill = (grounds: Rgb[], paints: Paint[]): Rgb[] => paints.length
  ? grounds.flatMap((u) => paints.flatMap((p) => (p.rgb.length ? p.rgb.map((c) => over(c, p.alpha, u)) : [u])))
  : grounds;

type Extend = { extend?: { keyframes?: Record<string, unknown>; animation?: Record<string, string> } };
const extend = (tailwindConfig.theme as Extend).extend ?? {};
const keyframes = { ...defaultTheme.keyframes, ...(extend.keyframes ?? {}) } as Record<string, Record<string, { opacity?: string }>>;
const animations = { ...defaultTheme.animation, ...(extend.animation ?? {}) } as Record<string, string>;

/**
 * The lowest opacity an `animate-*` class keeps returning to, from its
 * keyframes. Only a looping (`infinite`) animation has one: an entrance
 * (`fade-in … both`) passes through 0 once and rests on its last frame.
 */
export function animationTrough(name: string): number {
  const animation = animations[name];
  if (!animation || !/\binfinite\b/.test(animation)) return 1;
  const frames = keyframes[animation.split(/\s+/)[0]] ?? {};
  const values = Object.values(frames).map((f) => f.opacity).filter((o): o is string => o !== undefined).map(Number);
  return values.length ? Math.min(1, ...values) : 1;
}

/** The element's group opacity in a state: `opacity-*`, or an animation's faintest frame. */
function opacity(classes: string[], state: State): number {
  let o = 1;
  for (const token of classes) {
    const a = applies(token, state); if (!a) continue;
    const m = a.base.match(/^opacity-(\d+)$/); if (m) o = Number(m[1]) / 100;
  }
  if (state.trough) for (const token of classes) {
    const a = applies(token, state); if (!a) continue;
    const m = a.base.match(/^animate-(.+)$/); if (m) o = Math.min(o, animationTrough(m[1]));
  }
  return o;
}

/**
 * An earlier sibling laid across the box (`absolute inset-0`, a full-height
 * `absolute inset-y-0` bar): it paints under the siblings after it. A small
 * absolutely placed control (`absolute right-3 top-3 h-10 w-10`) does not lie
 * under the text beside it, so it is not a layer.
 */
const layer = (v: Variant) => v.classes.includes('absolute') && v.classes.some((c) => /^-?inset-(0|[xy]-0)$/.test(c));
const consistent = (facts: Map<string, boolean>, lits: Literal[]) => lits.every((l) => !facts.has(l.cond) || facts.get(l.cond) === l.value);
const assume = (facts: Map<string, boolean>, lits: Literal[]) => { const f = new Map(facts); for (const l of lits) f.set(l.cond, l.value); return f; };

export type Reading = { fg: Rgb; bg: Rgb; layers: string[] };

/** What one element's subtree paints over `under` (its own fill, then its descendants' fills, at its opacity). */
function overlay(node: Node, state: State, under: Rgb, facts: Map<string, boolean>): Rgb[] {
  const out: Rgb[] = [];
  for (const v of node.variants) {
    if (!consistent(facts, [...node.renderWhen, ...v.when])) continue;
    let painted = fill([under], fills(v.classes, state));
    for (const child of node.children) painted = painted.flatMap((u) => overlay(child, state, u, facts));
    const o = opacity(v.classes, state);
    out.push(...painted.map((p) => over(p, o, under)));
  }
  return out.length ? out : [under];
}

/**
 * Every (text, ground) pair the last node of `chain` can show in `state`,
 * starting from an opaque `ground`.
 */
export function compose(chain: Node[], state: State, ground: Rgb): Reading[] {
  const go = (i: number, under: Rgb, text: Paint, facts: Map<string, boolean>, layers: string[]): Reading[] => {
    if (i === chain.length) return text.rgb.map((c) => ({ fg: over(c, text.alpha, under), bg: under, layers }));
    const node = chain[i];
    const out: Reading[] = [];
    for (const v of node.variants) {
      const lits = [...node.renderWhen, ...v.when];
      if (!consistent(facts, lits)) continue;
      const f = assume(facts, lits);
      // Earlier siblings laid across the box paint under this one.
      let layered: Rgb[] = [under];
      for (const s of node.before) if (s.variants.some(layer)) layered = layered.flatMap((u) => overlay(s, state, u, f));
      const nextText = last(v.classes, state, 'text') ?? text;
      const o = opacity(v.classes, state);
      const label = `${node.file.split('/').pop()}:${node.line} ${v.classes.filter((c) => /(^|:)(bg|text|from|opacity|animate)-/.test(c) && !/text-(xs|sm|base|lg|\d?xl|\[\d)/.test(c)).join(' ')}`.trim();
      for (const backdrop of layered) {
        for (const g of fill([backdrop], fills(v.classes, state))) {
          // At opacity o the element and everything in it blend with its backdrop.
          for (const r of go(i + 1, g, nextText, f, [...layers, label])) {
            out.push(o === 1 ? r : { ...r, fg: over(r.fg, o, backdrop), bg: over(r.bg, o, backdrop) });
          }
        }
      }
    }
    return out;
  };
  return go(0, ground, { rgb: [[255, 255, 255]], alpha: 1 }, new Map(), []);
}

// ── The display ───────────────────────────────────────────────────────────────

export const INK = hex('#0b1020'); // the display's ground, under the wash and over it

/** Every colour a theme's wash or glow can put behind a tile: the THEMES record in lib/display/ambient.ts. */
export function washColours(ambient = readFileSync('lib/display/ambient.ts', 'utf8')): Rgb[] {
  const themes = bodyOf(ambient, 'const THEMES', '\n};');
  return [...new Set(themes.match(/#[0-9a-fA-F]{6}\b/g) ?? [])].map(hex);
}

/** The ink display-grid.tsx lays over the wash, as its scrim element writes it. */
export function scrimAlpha(grid = readFileSync('components/display/display-grid.tsx', 'utf8')): number | null {
  const m = grid.match(/\{settings\.ambient && <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-\[#0b1020\]\/(\d+)" \/>\}/);
  return m ? Number(m[1]) / 100 : null;
}

/** It paints an opaque ground of its own in every variant (a screen that is not on the wash). */
export function opaque(node: Node): boolean {
  // Asking is not composing: a theme token here (bg-surface) is simply not opaque ink.
  const known = new Set(unresolved);
  const result = node.variants.every((v) => fills(v.classes, STATES.idle).some((p) => p.alpha === 1 && p.rgb.length > 0));
  unresolved.clear();
  for (const u of known) unresolved.add(u);
  return result;
}

/** The lowest ratio a chain's last element reaches in a state, over every ground. */
export function worstReading(chain: Node[], state: State, grounds: Rgb[]): { ratio: number; layers: string[] } {
  let worst = { ratio: Infinity, layers: [] as string[] };
  for (const g of grounds) for (const r of compose(chain, state, g)) {
    const ratio = contrast(r.fg, r.bg);
    if (ratio < worst.ratio) worst = { ratio, layers: r.layers };
  }
  return worst;
}

