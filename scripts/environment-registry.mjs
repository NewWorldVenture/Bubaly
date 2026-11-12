#!/usr/bin/env node
/**
 * Environment registry generator.
 *
 * Builds docs/architecture/environment-registry.json and .md from the code:
 * every environment variable a scanned file reads, where it reads it, what
 * kind of code reads it, whether it is secret-grade, and whether a template
 * (.env.example, mobile/.env.example) declares it. Nothing in the output is
 * typed by hand; the only hand-written inputs are the constants below (which
 * roots count as which scope, which names the platform supplies, and the
 * secret-name pattern), and each is printed into the output so a reader can
 * see the rule that produced a row.
 *
 * Deterministic and offline: it reads files from the working tree, sorts
 * everything, records no timestamps, and never reads an environment value.
 *
 *   node scripts/environment-registry.mjs          # write both files
 *   node scripts/environment-registry.mjs --check  # exit 1 if they are stale
 *
 * tests/the-environment-registry-matches-the-code.test.ts runs buildRegistry()
 * in memory and fails when the committed files differ from it.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const JSON_PATH = 'docs/architecture/environment-registry.json';
export const MD_PATH = 'docs/architecture/environment-registry.md';

/** Scanned roots, and the scope a read in each one counts toward. */
export const ROOTS = [
  { path: 'app', scope: 'app-runtime' },
  { path: 'lib', scope: 'app-runtime' },
  { path: 'components', scope: 'app-runtime' },
  { path: 'middleware.ts', scope: 'app-runtime' },
  { path: 'instrumentation.ts', scope: 'app-runtime' },
  { path: 'next.config.mjs', scope: 'build' },
  { path: 'capacitor.config.ts', scope: 'build' },
  { path: 'mobile/src', scope: 'mobile' },
  { path: 'scripts', scope: 'scripts' },
  { path: 'tests', scope: 'tests' },
  { path: 'playwright.config.ts', scope: 'tests' },
  { path: 'vitest.config.ts', scope: 'tests' },
  { path: 'vitest.feedback-browser.config.ts', scope: 'tests' },
  { path: 'vitest.toast-browser.config.ts', scope: 'tests' },
  { path: '.github/workflows', scope: 'ci' },
];

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const WORKFLOW_EXT = /\.ya?ml$/;
const SELF = 'scripts/environment-registry.mjs';
const CI_SCRIPT = /^scripts\/ci-[^/]+$/;

export const TEMPLATES = ['.env.example', 'mobile/.env.example'];

/**
 * Supplied by Node, Next.js, Vercel, the CI runner or the operating system.
 * Nobody types these into a .env file, so no template line is required.
 */
export const PLATFORM_SUPPLIED = {
  NODE_ENV: 'Node.js / Next.js',
  NEXT_RUNTIME: 'Next.js',
  NEXT_PHASE: 'Next.js',
  VERCEL: 'Vercel',
  VERCEL_ENV: 'Vercel',
  VERCEL_URL: 'Vercel',
  VERCEL_REGION: 'Vercel',
  VERCEL_GIT_COMMIT_SHA: 'Vercel',
  NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: 'Vercel',
  CI: 'CI runner',
  GITHUB_ACTIONS: 'GitHub Actions runner',
  GITHUB_ENV: 'GitHub Actions runner',
  GITHUB_OUTPUT: 'GitHub Actions runner',
  GITHUB_STEP_SUMMARY: 'GitHub Actions runner',
  GITHUB_WORKSPACE: 'GitHub Actions runner',
  GITHUB_SHA: 'GitHub Actions runner',
  GITHUB_REF: 'GitHub Actions runner',
  GITHUB_REPOSITORY: 'GitHub Actions runner',
  GITHUB_EVENT_NAME: 'GitHub Actions runner',
  GITHUB_RUN_ID: 'GitHub Actions runner',
  GITHUB_RUN_ATTEMPT: 'GitHub Actions runner',
  GITHUB_JOB: 'GitHub Actions runner',
  GITHUB_WORKFLOW: 'GitHub Actions runner',
  GITHUB_API_URL: 'GitHub Actions runner',
  GITHUB_EVENT_PATH: 'GitHub Actions runner',
  HTTPS_PROXY: 'operating system / network proxy',
  HTTP_PROXY: 'operating system / network proxy',
  NO_PROXY: 'operating system / network proxy',
  RUNNER_TEMP: 'GitHub Actions runner',
  PATH: 'operating system',
  HOME: 'operating system',
  TZ: 'operating system / test runner',
  LANG: 'operating system',
  TMPDIR: 'operating system',
  USER: 'operating system',
  SHELL: 'operating system',
  npm_lifecycle_event: 'npm',
  npm_config_user_agent: 'npm',
  VITEST: 'Vitest',
  VITEST_WORKER_ID: 'Vitest',
  VITEST_POOL_ID: 'Vitest',
  TEST_WORKER_INDEX: 'Playwright',
};

/** Secret-grade by name. Public-by-construction prefixes are excluded. */
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|SERVICE_ROLE_KEY|_DB_URL$|^GOOGLE_SEARCH_CONSOLE_KEY$|^SYNC_TOKEN_KEY$)/;
const PUBLIC_NAME = /^(NEXT_PUBLIC_|EXPO_PUBLIC_)|(_TOKEN_FILE|COOKIE_FILE)$/;
/** Secret-grade by use: a value handed to one of these is a credential. */
const SECRET_SINKS = new Set(['configuredSecret', 'secretEquals', 'timingSafeEqual', 'createHmac', 'safeEqual']);

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** A string literal that names an env var in a list read by index. */
const LISTED_ENV_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function toPosix(p) {
  return p.split(sep).join('/');
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(join(root, dir)).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || (entry.startsWith('.') && entry !== '.github')) continue;
    const rel = dir ? `${dir}/${entry}` : entry;
    const st = statSync(join(root, rel));
    if (st.isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
}

export function scannedFiles(root) {
  const files = [];
  for (const { path, scope } of ROOTS) {
    let st;
    try {
      st = statSync(join(root, path));
    } catch {
      continue;
    }
    const list = [];
    if (st.isDirectory()) walk(root, path, list);
    else list.push(path);
    for (const file of list) {
      if (file === SELF) continue;
      if (!(scope === 'ci' ? WORKFLOW_EXT.test(file) : CODE_EXT.test(file))) continue;
      // scripts/ci-*.mjs run only inside CI jobs: their reads count as CI.
      files.push({ file, scope: scope === 'scripts' && CI_SCRIPT.test(file) ? 'ci' : scope });
    }
  }
  return files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Code scanning (TypeScript AST, so comments and strings never count)
// ---------------------------------------------------------------------------

function isProcessEnv(node) {
  return (
    node &&
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'env' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process'
  );
}

function stripWrappers(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression?.(node))) {
    node = node.expression;
  }
  return node;
}

/** `process.env`, or `x ?? process.env` / `x || process.env`. */
function isEnvSource(node) {
  node = stripWrappers(node);
  if (!node) return false;
  if (isProcessEnv(node)) return true;
  if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    return isEnvSource(node.right) || isEnvSource(node.left);
  }
  return false;
}

function literalText(node) {
  node = stripWrappers(node);
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function isAssignmentTarget(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isBinaryExpression(p) && p.left === node) {
    const k = p.operatorToken.kind;
    return k === ts.SyntaxKind.EqualsToken || k === ts.SyntaxKind.QuestionQuestionEqualsToken || k === ts.SyntaxKind.BarBarEqualsToken;
  }
  if (ts.isDeleteExpression(p)) return true;
  return false;
}

/**
 * Mechanical facts about one read: the fallbacks after `??`/`||`, literal
 * comparisons, the call it is handed to, and checks on the variable it is
 * stored in (a regex `.test`, a comparison, configuredSecret()).
 */
function factsFor(node, sf) {
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const facts = [];
  let expr = node;
  // Climb through `.trim()`, `?.`, `!`, parentheses and casts.
  for (;;) {
    const p = expr.parent;
    if (!p) break;
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === expr) { expr = p; continue; }
    if (ts.isCallExpression(p) && p.expression === expr) { expr = p; continue; }
    if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p)) { expr = p; continue; }
    break;
  }
  // Fallback chain.
  for (;;) {
    const p = expr.parent;
    if (!p) break;
    if (ts.isParenthesizedExpression(p)) { expr = p; continue; }
    if (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || p.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      if (p.left === expr) {
        const op = p.operatorToken.getText(sf);
        const lit = literalText(p.right);
        const r = stripWrappers(p.right);
        if (lit !== null) facts.push({ kind: 'fallback-literal', op, value: lit, line: line(p) });
        else {
          const other = envNameOf(r);
          if (other) facts.push({ kind: 'fallback-variable', op, value: other, line: line(p) });
          else facts.push({ kind: 'fallback-expression', op, line: line(p) });
        }
      }
      expr = p;
      continue;
    }
    break;
  }
  const p = expr.parent;
  if (p && ts.isBinaryExpression(p)) {
    const k = p.operatorToken.kind;
    if (k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken) {
      const lit = literalText(p.left === expr ? p.right : p.left);
      if (lit !== null) facts.push({ kind: 'compared-with', op: p.operatorToken.getText(sf), value: lit, line: line(p) });
    }
  }
  if (p && ts.isCallExpression(p) && p.arguments.includes(expr)) {
    const name = calleeName(p);
    if (name) facts.push({ kind: 'passed-to', value: name, line: line(p) });
  }
  if (p && ts.isVariableDeclaration(p) && p.initializer === expr && ts.isIdentifier(p.name)) {
    facts.push(...checksOnBinding(p.name.text, p, sf));
  }
  return facts;
}

function enclosingScope(node) {
  let n = node.parent;
  while (n && !ts.isFunctionLike(n) && !ts.isSourceFile(n)) n = n.parent;
  return n;
}

function checksOnBinding(name, decl, sf) {
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const out = [];
  const scope = enclosingScope(decl);
  const isRef = (n) => {
    n = stripWrappers(n);
    if (!n) return false;
    if (ts.isIdentifier(n)) return n.text === name;
    // `name.trim()`, `name.length` still test the bound value.
    if (ts.isCallExpression(n)) return isRef(n.expression);
    if (ts.isPropertyAccessExpression(n)) return isRef(n.expression);
    return false;
  };
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isPropertyAccessExpression(e) && e.name.text === 'test' && ts.isRegularExpressionLiteral(stripWrappers(e.expression)) && n.arguments.some(isRef)) {
        out.push({ kind: 'validated-by-regex', value: stripWrappers(e.expression).text, line: line(n) });
      } else if (n.arguments.some(isRef)) {
        const c = calleeName(n);
        if (c && (SECRET_SINKS.has(c) || /^(require|assert|validate|is)[A-Z]/.test(c))) out.push({ kind: 'passed-to', value: c, line: line(n) });
      }
    } else if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        const lit = isRef(n.left) ? literalText(n.right) : isRef(n.right) ? literalText(n.left) : null;
        if (lit !== null) out.push({ kind: 'compared-with', op: n.operatorToken.getText(sf), value: lit, line: line(n) });
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(scope, visit);
  return out;
}

let currentAliases = new Set();

/** The env name a node reads directly, if any (`process.env.X`, `process.env['X']`, `env.X` for an alias). */
function envNameOf(node) {
  node = stripWrappers(node);
  if (!node) return null;
  if (ts.isPropertyAccessExpression(node) && ENV_NAME.test(node.name.text)) {
    if (isProcessEnv(node.expression)) return node.name.text;
    if (ts.isIdentifier(node.expression) && currentAliases.has(node.expression.text)) return node.name.text;
  }
  if (ts.isElementAccessExpression(node)) {
    const lit = literalText(node.argumentExpression);
    if (lit && ENV_NAME.test(lit)) {
      if (isProcessEnv(node.expression)) return lit;
      if (ts.isIdentifier(node.expression) && currentAliases.has(node.expression.text)) return lit;
    }
  }
  return null;
}

function scanCode(file, text) {
  const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : /\.(ts|mts|cts)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const reads = [];
  const dynamicSites = [];

  // Pass 1: aliases of process.env (a variable or parameter initialised from it,
  // or a parameter named `env` that is indexed by a computed key).
  const aliases = new Set();
  const visitAliases = (n) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name) && n.initializer && isEnvSource(n.initializer)) {
      aliases.add(n.name.text);
    }
    ts.forEachChild(n, visitAliases);
  };
  visitAliases(sf);
  currentAliases = aliases;

  const indexedParams = new Set();
  const visitParams = (n) => {
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'env' && literalText(n.argumentExpression) === null) indexedParams.add('env');
    ts.forEachChild(n, visitParams);
  };
  visitParams(sf);
  for (const a of indexedParams) aliases.add(a);

  let dynamic = false;
  const nameTemplates = [];
  const visit = (n) => {
    // Destructuring: const { A, B: b } = process.env
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && isEnvSource(n.initializer)) {
      for (const el of n.name.elements) {
        const key = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null;
        if (key && ENV_NAME.test(key)) reads.push({ name: key, line: line(el), how: 'destructured', facts: [] });
      }
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const target = n.expression;
      const fromEnv = isProcessEnv(target) || (ts.isIdentifier(target) && aliases.has(target.text));
      if (fromEnv) {
        const name = envNameOf(n);
        if (name) {
          const how = isAssignmentTarget(n) ? 'set' : isProcessEnv(target) ? (ts.isPropertyAccessExpression(n) ? 'read' : 'read-indexed') : 'read-via-alias';
          reads.push({ name, line: line(n), how, facts: how === 'set' ? [] : factsFor(n, sf) });
        } else if (ts.isElementAccessExpression(n)) {
          dynamic = true;
          dynamicSites.push({ line: line(n), key: n.argumentExpression.getText(sf).slice(0, 80) });
        }
      }
    }
    // `PREFIX_${x}` builds an env name elsewhere read by a computed key
    // (lib/claude-fleet/config.ts derives ANTHROPIC_ADMIN_API_KEY__<ALIAS>).
    if (ts.isTemplateExpression(n) && !(n.parent && ts.isElementAccessExpression(n.parent)) && /^[A-Z][A-Z0-9_]*_$/.test(n.head.text) && n.templateSpans.every((sp) => /^[A-Z0-9_]*$/.test(sp.literal.text))) {
      nameTemplates.push({ line: line(n), key: n.getText(sf) });
    }
    // vi.stubEnv('X', ...) sets a variable for one test.
    if (ts.isCallExpression(n) && calleeName(n) === 'stubEnv' && n.arguments.length) {
      const lit = literalText(n.arguments[0]);
      if (lit && ENV_NAME.test(lit)) reads.push({ name: lit, line: line(n), how: 'set', facts: [] });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // A computed key reads names from a table: count every listed env-shaped
  // string literal in the file as a presence read at its own line.
  if (dynamic) {
    const seen = new Set(reads.filter((r) => r.how !== 'set').map((r) => `${r.name}:${r.line}`));
    const visitLits = (n) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && LISTED_ENV_NAME.test(n.text)) {
        const p = n.parent;
        const isIndexArg = p && ts.isElementAccessExpression(p);
        const isStub = p && ts.isCallExpression(p) && calleeName(p) === 'stubEnv';
        const key = `${n.text}:${line(n)}`;
        if (!isIndexArg && !isStub && !seen.has(key)) {
          seen.add(key);
          reads.push({ name: n.text, line: line(n), how: 'listed-for-dynamic-read', facts: [] });
        }
      }
      ts.forEachChild(n, visitLits);
    };
    visitLits(sf);
  }
  return { reads, dynamicSites, nameTemplates };
}

// ---------------------------------------------------------------------------
// Workflow scanning: `env:` bindings
// ---------------------------------------------------------------------------

function scanWorkflow(text) {
  const reads = [];
  const lines = text.split('\n');
  let envIndent = -1;
  let childIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(#|$)/.test(raw)) continue;
    const indent = raw.match(/^\s*/)[0].length;
    if (envIndent >= 0) {
      if (indent <= envIndent) {
        envIndent = -1;
        childIndent = -1;
      } else {
        if (childIndent < 0) childIndent = indent;
        if (indent === childIndent) {
          const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
          if (m && ENV_NAME.test(m[1])) {
            const fromSecret = /\$\{\{\s*secrets\./.test(m[2]);
            reads.push({ name: m[1], line: i + 1, how: fromSecret ? 'workflow-env-from-secret' : 'workflow-env', facts: [] });
          }
        }
        continue;
      }
    }
    const m = raw.match(/^(\s*)(?:-\s+)?env:\s*$/);
    if (m) {
      envIndent = raw.indexOf('env:');
      childIndent = -1;
    }
  }
  return { reads, dynamicSites: [], nameTemplates: [] };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Declarations in a template: live `NAME=value` and commented `# NAME=`. The
 * purpose is the run of comment lines directly above the declaration (skipping
 * other commented declarations); a `[secret]` tag in it marks secret-grade.
 */
export function parseTemplate(text) {
  const lines = text.split('\n');
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#\s?)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const comment = [];
    for (let j = i - 1; j >= 0; j--) {
      const l = lines[j];
      if (/^(#\s?)?[A-Z][A-Z0-9_]*=/.test(l)) {
        if (comment.length) break;
        continue;
      }
      if (!l.startsWith('#') || /^#\s*-{3,}/.test(l) || /^#\s*={3,}/.test(l)) break;
      comment.unshift(l.replace(/^#\s?/, ''));
    }
    decls.push({
      name: m[2],
      line: i + 1,
      live: !m[1],
      hasValue: m[3].trim() !== '',
      purpose: comment.join(' ').replace(/\s+/g, ' ').trim(),
    });
  }
  return decls;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const SCOPE_ORDER = ['app-runtime', 'build', 'mobile', 'scripts', 'ci', 'tests'];

function tierOf(scopes) {
  if (scopes.includes('app-runtime')) return 'app';
  if (scopes.includes('build')) return 'build';
  if (scopes.includes('mobile')) return 'mobile';
  if (scopes.includes('scripts')) return scopes.includes('ci') ? 'ci-scripts' : 'operator-scripts';
  if (scopes.includes('ci')) return 'ci-only';
  if (scopes.includes('tests')) return 'tests-only';
  return 'set-but-never-read';
}

export function buildRegistry(root = process.cwd()) {
  const files = scannedFiles(root);
  const vars = new Map();
  const dynamicSites = [];
  const derivedNames = [];
  const get = (name) => {
    if (!vars.has(name)) vars.set(name, { name, readers: [], setters: [] });
    return vars.get(name);
  };
  const stats = Object.fromEntries(SCOPE_ORDER.map((s) => [s, { filesScanned: 0, filesWithReads: 0 }]));

  for (const { file, scope } of files) {
    const text = readFileSync(join(root, file), 'utf8');
    stats[scope].filesScanned++;
    if (scope !== 'ci' && !/env/i.test(text)) continue;
    const { reads, dynamicSites: dyn, nameTemplates } = scope === 'ci' ? scanWorkflow(text) : scanCode(file, text);
    for (const d of nameTemplates) derivedNames.push({ path: file, line: d.line, key: d.key, scope });
    if (reads.some((r) => r.how !== 'set')) stats[scope].filesWithReads++;
    for (const d of dyn) {
      if (!dynamicSites.some((x) => x.path === file && x.line === d.line && x.key === d.key)) dynamicSites.push({ path: file, line: d.line, key: d.key });
    }
    for (const r of reads) {
      const v = get(r.name);
      const entry = { path: file, line: r.line, scope, how: r.how };
      if (r.facts.length) entry.facts = r.facts;
      (r.how === 'set' ? v.setters : v.readers).push(entry);
    }
  }

  // A computed key built from a template literal (`${provider}_SYNC_REDIRECT_URI`)
  // reads every known name it can produce.
  for (const d of [...dynamicSites, ...derivedNames]) {
    if (!d.key.startsWith('`') || !d.key.includes('${')) continue;
    const pattern = new RegExp(`^${d.key.slice(1, -1).split(/\$\{[^}]*\}/).map((part) => part.replace(/[.*+?^$()|[\]\\]/g, '\\$&')).join('[A-Z0-9_]+')}$`);
    d.pattern = pattern.source;
    d.scope = files.find((f) => f.file === d.path)?.scope;
  }
  const templates = {};
  for (const t of TEMPLATES) {
    let text = '';
    try {
      text = readFileSync(join(root, t), 'utf8');
    } catch {
      continue;
    }
    templates[t] = parseTemplate(text);
    for (const d of templates[t]) get(d.name);
  }

  for (const d of [...dynamicSites, ...derivedNames]) {
    if (!d.pattern) continue;
    const re = new RegExp(d.pattern);
    const how = dynamicSites.includes(d) ? 'computed-key-match' : 'derived-name-match';
    for (const v of vars.values()) {
      if (re.test(v.name)) v.readers.push({ path: d.path, line: d.line, scope: d.scope, how });
    }
  }
  // Keep only derived-name templates that produced a known name.
  const usedDerived = derivedNames.filter((d) => [...vars.values()].some((v) => v.readers.some((x) => x.how === 'derived-name-match' && x.path === d.path && x.line === d.line)));
  const variables = [...vars.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((v) => {
      const scopes = SCOPE_ORDER.filter((s) => v.readers.some((r) => r.scope === s));
      const declarations = [];
      for (const t of TEMPLATES) {
        for (const d of templates[t] ?? []) {
          if (d.name === v.name) declarations.push({ path: t, line: d.line, live: d.live, hasValue: d.hasValue, purpose: d.purpose });
        }
      }
      const sinks = v.readers.flatMap((r) => (r.facts ?? []).filter((f) => f.kind === 'passed-to' && SECRET_SINKS.has(f.value)).map((f) => `${f.value}() at ${r.path}:${f.line}`));
      const fromSecret = v.readers.filter((r) => r.how === 'workflow-env-from-secret').map((r) => `bound from secrets.* at ${r.path}:${r.line}`);
      const byName = SECRET_NAME.test(v.name) && !PUBLIC_NAME.test(v.name);
      const secretBasis = [
        ...(byName ? ['name matches the secret pattern'] : []),
        ...[...new Set(sinks)].slice(0, 3),
      ];
      const secret = !PUBLIC_NAME.test(v.name) && secretBasis.length > 0;
      const facts = [];
      const seenFacts = new Set();
      for (const r of v.readers) {
        for (const f of r.facts ?? []) {
          const where = `${r.path}:${f.line}`;
          const key = `${f.kind}|${f.op ?? ''}|${f.value ?? ''}|${where}`;
          if (seenFacts.has(key)) continue;
          seenFacts.add(key);
          facts.push({ ...f, at: where, line: undefined });
        }
      }
      const tier = tierOf(scopes);
      const platform = PLATFORM_SUPPLIED[v.name] ?? null;
      const needsTemplate = !platform && ['app', 'build', 'mobile', 'operator-scripts'].includes(tier);
      return {
        name: v.name,
        tier,
        scopes,
        secret,
        secretBasis,
        boundFromWorkflowSecret: fromSecret.length > 0,
        platformSupplied: platform,
        templateRequired: needsTemplate,
        declarations,
        readers: [...new Set(
          [...v.readers]
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
            .map((r) => `${r.path}:${r.line}${r.how === 'read' ? '' : ` (${r.how})`}`),
        )],
        readerCountByScope: Object.fromEntries(scopes.map((s) => [s, v.readers.filter((r) => r.scope === s).length])),
        setByTests: v.setters.length,
        facts: facts.map(({ line, ...f }) => f),
      };
    });

  const missingFromTemplate = variables.filter((v) => v.templateRequired && v.declarations.length === 0).map((v) => v.name);
  const duplicateDeclarations = variables.filter((v) => v.declarations.length > 1).map((v) => `${v.name} (${v.declarations.map((d) => `${d.path}:${d.line}`).join(', ')})`);
  const declaredButUnread = variables.filter((v) => v.declarations.length && v.readers.length === 0).map((v) => v.name);
  const secretsNotTagged = variables
    .filter((v) => v.secret && v.declarations.some((d) => d.path === '.env.example' && !/\[secret\]/.test(d.purpose)))
    .map((v) => v.name);

  const tierCounts = {};
  for (const v of variables) tierCounts[v.tier] = (tierCounts[v.tier] ?? 0) + 1;

  const json = {
    schemaVersion: 2,
    artifact: 'environment-registry',
    status: 'GENERATED_FROM_SOURCE',
    generator: `${SELF} (npm run env:registry)`,
    scope: 'Every environment variable read by the scanned roots, with its readers, scope, secret grade and template declaration. Generated; do not edit by hand.',
    safety: {
      networkUsed: false,
      actualEnvironmentFilesRead: false,
      processEnvironmentValuesRead: false,
      variableValuesIncluded: false,
      templatePlaceholderValuesIncluded: false,
      codeLiteralsIncluded: 'Fallback and comparison literals are copied from source code, which is already public in the repository; email addresses are replaced with <email address>.',
    },
    rules: {
      scopes: { ...Object.fromEntries(ROOTS.map((r) => [r.path, r.scope])), 'scripts/ci-*': 'ci' },
      tiers: {
        app: 'read by app/, lib/, components/, middleware.ts or instrumentation.ts',
        build: 'read by next.config.mjs or capacitor.config.ts at build time',
        mobile: 'read by the Expo app under mobile/src (EXPO_PUBLIC_* values are inlined at build)',
        'operator-scripts': 'read by scripts/ that a person runs by hand (and possibly by tests), and not bound by any workflow',
        'ci-scripts': 'read by scripts/ and also bound by a .github/workflows env: block or read by a scripts/ci-*.mjs file: CI plumbing an operator may also set',
        'ci-only': 'bound only by a .github/workflows env: block (and possibly read by tests)',
        'tests-only': 'read only by tests/ or the test-runner configs',
        'set-but-never-read': 'only set by tests (process.env.X = …, vi.stubEnv) or only declared in a template; no scanned code reads it',
      },
      templateRule:
        'Every variable in the app, build, mobile or operator-scripts tier is declared exactly once in .env.example or mobile/.env.example, unless the platform supplies it. Tests-only and CI-only variables are listed here and need no template line; the few a developer sets by hand to run the e2e suite locally are also in the test-only block of .env.example.',
      secret: `Secret-grade when the name matches ${SECRET_NAME} (except NEXT_PUBLIC_*/EXPO_PUBLIC_* and file-path names), or when a read is passed to ${[...SECRET_SINKS].join('/')}. A workflow binding from secrets.* is recorded (boundFromWorkflowSecret) but does not by itself make a name secret-grade: CI also stores public keys and project refs as secrets. A secret-grade name in .env.example carries a [secret] tag in its comment.`,
      platformSupplied: PLATFORM_SUPPLIED,
      reads:
        'process.env.X, process.env["X"], const { X } = process.env, an alias initialised from process.env (or a parameter named env indexed by a computed key) read as alias.X, string literals listed in a file that indexes process.env by a computed key (e.g. credentialEnv in lib/social/capabilities.ts), and env: bindings in workflows. Assignments, delete and vi.stubEnv count as sets, not reads. Comments and strings never count.',
      facts:
        'fallback-literal / fallback-variable / fallback-expression: what follows ?? or || at the read. compared-with: a literal the value is compared with. passed-to: the call the value is handed to. validated-by-regex: a regex .test() on the variable the value is stored in, within the same function.',
      notScanned: 'Shell, Python and SQL files; mobile/app.json extra (a fallback for EXPO_PUBLIC_*); vercel.json; Supabase config.',
    },
    coverage: {
      filesScannedByScope: stats,
      variables: variables.length,
      byTier: Object.fromEntries(Object.entries(tierCounts).sort()),
      dynamicReadSites: dynamicSites.map(({ path, line, key, pattern }) => ({ path, line, key, ...(pattern ? { pattern } : {}) })),
      derivedNameTemplates: usedDerived.map(({ path, line, key, pattern }) => ({ path, line, key, pattern })),
    },
    checks: {
      missingFromTemplate,
      duplicateDeclarations,
      declaredButUnread,
      secretsNotTagged,
    },
    variables,
  };

  const redacted = redactEmails(json);
  return { json: `${JSON.stringify(redacted, null, 2)}\n`, markdown: renderMarkdown(redacted), registry: redacted };
}

/** No email address, real or not, is copied into the registry. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;
function redactEmails(value) {
  if (typeof value === 'string') return value.replace(EMAIL, '<email address>');
  if (Array.isArray(value)) return value.map(redactEmails);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactEmails(v)]));
  return value;
}

function mdEscape(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function factText(f) {
  switch (f.kind) {
    case 'fallback-literal':
      return `\`${f.op} ${JSON.stringify(f.value)}\` (${f.at})`;
    case 'fallback-variable':
      return `falls back to \`${f.value}\` (${f.at})`;
    case 'fallback-expression':
      return `\`${f.op}\` computed fallback (${f.at})`;
    case 'compared-with':
      return `\`${f.op} ${JSON.stringify(f.value)}\` (${f.at})`;
    case 'passed-to':
      return `passed to \`${f.value}()\` (${f.at})`;
    case 'validated-by-regex':
      return `checked by \`${f.value}\` (${f.at})`;
    default:
      return `${f.kind} (${f.at})`;
  }
}

function renderMarkdown(j) {
  const out = [];
  out.push('# Environment registry');
  out.push('');
  out.push(`Generated by \`${j.generator}\` from the source tree. Do not edit by hand: change the code or the templates and rerun \`npm run env:registry\`. \`tests/the-environment-registry-matches-the-code.test.ts\` fails when this file is stale.`);
  out.push('');
  out.push('No environment file, process environment value, credential store or network was read. Template placeholder values are not copied; fallback and comparison literals come from source code.');
  out.push('');
  out.push('## Rules');
  out.push('');
  out.push(`- **Template rule.** ${j.rules.templateRule}`);
  out.push(`- **Secret grade.** ${j.rules.secret}`);
  out.push(`- **What counts as a read.** ${j.rules.reads}`);
  out.push(`- **Facts.** ${j.rules.facts}`);
  out.push(`- **Not scanned.** ${j.rules.notScanned}`);
  out.push(`- **Platform-supplied** (no template line required): ${Object.keys(j.rules.platformSupplied).map((n) => `\`${n}\``).join(', ')}.`);
  out.push('');
  out.push('Tiers:');
  out.push('');
  for (const [k, v] of Object.entries(j.rules.tiers)) out.push(`- \`${k}\`: ${v}.`);
  out.push('');
  out.push('## Coverage');
  out.push('');
  out.push('| Scope | Files scanned | Files with reads |');
  out.push('| --- | ---: | ---: |');
  for (const [s, st] of Object.entries(j.coverage.filesScannedByScope)) out.push(`| \`${s}\` | ${st.filesScanned} | ${st.filesWithReads} |`);
  out.push('');
  out.push(`${j.coverage.variables} variables: ${Object.entries(j.coverage.byTier).map(([k, n]) => `${n} \`${k}\``).join(', ')}.`);
  out.push('');
  if (j.coverage.dynamicReadSites.length) {
    out.push('Computed-key reads (the names a table lists are recorded as `listed-for-dynamic-read`; a key built at run time cannot be resolved statically):');
    out.push('');
    for (const d of j.coverage.dynamicReadSites) out.push(`- \`${d.path}:${d.line}\` — key \`${mdEscape(d.key)}\``);
    out.push('');
  }
  out.push('## Checks');
  out.push('');
  const list = (xs) => (xs.length ? xs.map((x) => `\`${x}\``).join(', ') : 'none');
  out.push(`- Read outside tests/CI, not platform-supplied, and missing from every template: ${list(j.checks.missingFromTemplate)}.`);
  out.push(`- Declared more than once across the templates: ${list(j.checks.duplicateDeclarations)}.`);
  out.push(`- Declared in a template but read by no scanned code: ${list(j.checks.declaredButUnread)}.`);
  out.push(`- Secret-grade but not tagged \`[secret]\` in .env.example: ${list(j.checks.secretsNotTagged)}.`);
  out.push('');
  out.push('## Variables');
  out.push('');
  out.push('Readers: up to three per scope are shown; the JSON lists every reader. A `[secret]` cell means secret-grade by the rule above.');
  out.push('');
  out.push('| Variable | Tier | Secret | Template | Readers | Facts from the code | Template purpose |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const v of j.variables) {
    const tmpl = v.declarations.length
      ? v.declarations.map((d) => `\`${d.path}:${d.line}\`${d.live ? '' : ' (commented)'}`).join('<br>')
      : v.platformSupplied
        ? `platform (${v.platformSupplied})`
        : v.templateRequired
          ? '**missing**'
          : '—';
    const readers = [];
    for (const s of v.scopes) {
      const rs = v.readers.filter((r) => {
        const path = r.split(':')[0];
        return j.rules.scopes[Object.keys(j.rules.scopes).find((root) => path === root || path.startsWith(`${root}/`))] === s;
      });
      readers.push(`${s} ${v.readerCountByScope[s]}: ${rs.slice(0, 3).map((r) => `\`${r}\``).join(', ')}${rs.length > 3 ? ', …' : ''}`);
    }
    if (!readers.length) readers.push(v.setByTests ? `none (set by ${v.setByTests} test site${v.setByTests === 1 ? '' : 's'})` : 'none');
    const facts = v.facts.filter((f) => !(f.kind === 'passed-to' && /^(String|Boolean|Number|trim)$/.test(f.value)));
    const factCell = facts.length ? `${facts.slice(0, 4).map(factText).join('; ')}${facts.length > 4 ? `; +${facts.length - 4} more` : ''}` : '';
    const purpose = v.declarations.map((d) => d.purpose).filter(Boolean)[0] ?? '';
    out.push(`| \`${v.name}\` | ${v.tier} | ${v.secret ? '[secret]' : ''} | ${tmpl} | ${mdEscape(readers.join('<br>'))} | ${mdEscape(factCell)} | ${mdEscape(purpose)} |`);
  }
  out.push('');
  return `${out.join('\n')}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = process.cwd();
  const { json, markdown } = buildRegistry(root);
  if (process.argv.includes('--check')) {
    const stale = [];
    if (readFileSync(join(root, JSON_PATH), 'utf8') !== json) stale.push(JSON_PATH);
    if (readFileSync(join(root, MD_PATH), 'utf8') !== markdown) stale.push(MD_PATH);
    if (stale.length) {
      console.error(`Stale: ${stale.join(', ')}. Run: npm run env:registry`);
      process.exit(1);
    }
    console.log('environment registry is current');
  } else {
    writeFileSync(join(root, JSON_PATH), json);
    writeFileSync(join(root, MD_PATH), markdown);
    console.log(`wrote ${JSON_PATH} and ${MD_PATH}`);
  }
}
void relative;
void toPosix;
