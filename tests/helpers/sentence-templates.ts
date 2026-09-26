import { readFileSync } from 'node:fs';
import ts from 'typescript';

// I18N-003's last blind spot. The hardcoded-string scanner (scripts/i18n-scan.mjs)
// reads a template literal only in the places it can tell by pattern that it is
// copy: a copy attribute, a lone JSX child, confirm(), a toast. An English
// sentence built in a ternary, a return, an object property, an array or an
// ordinary call (`${n} events are coming up`, `Expires in ${h}h`) was invisible
// to it. This walker parses the file, so it can see a template wherever it is
// and ask what it is for.

export type Sentence = { file: string; line: number; text: string };

// Where a template is not a sentence for a person to read.
const NOT_COPY_ATTR = /^(className|key|href|src|id|htmlFor|style|data-|role|type|name|value|target|rel|as|d|viewBox|fill|stroke|transform|width|height|pattern|accept|autoComplete|inputMode|lang)$/;
const NOT_COPY_PROP = /^(className|href|key|id|url|path|src|query|select|filter|systemPrompt|prompt|sql|slug|cacheKey|storageKey|channel|topic|event)$/;
// A call whose template argument goes to a machine, a log, or is already a key.
const NOT_COPY_CALL = /^(console\.\w+|fetch|encodeURIComponent|redirect|notFound|router\.\w+|cn|clsx|t|tr|i18nT|translate|revalidatePath|revalidateTag|require|import|setTimeout|JSON\.parse|new URL|URL|RegExp|new RegExp|\w+\.(from|select|eq|neq|or|and|ilike|like|rpc|order|in|filter|match|contains|not|is|gte|lte|gt|lt|textSearch|channel|on|storage|upload|download|createSignedUrl|remove|list|startsWith|endsWith|includes|split|replace|replaceAll|querySelector|getItem|setItem|removeItem|get|set|has|delete|append|push|localeCompare|toLocaleDateString|toLocaleTimeString|toLocaleString))$/;

/** The static text of a template, with each ${…} as a gap. */
function staticText(n: ts.TemplateLiteral): string {
  return ts.isNoSubstitutionTemplateLiteral(n) ? n.text : [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join('\u0000');
}

/** Two or more words that read as prose: a capitalised word then a lower-case one, or three lower-case words. */
export function readsAsSentence(text: string): boolean {
  const flat = text.replace(/\u0000/g, ' ');
  const words = flat.match(/[A-Za-z][a-z']+/g) ?? [];
  if (words.length < 2) return false;
  return /(^|[\s\u0000])[A-Z][a-z']+[ ,][a-z]/.test(text) || /\b[a-z]{2,} [a-z]{2,} [a-z]{2,}\b/.test(flat);
}

/** What the template is for, walking out through ternaries, `&&`, `??`, `+` and parentheses. */
function context(n: ts.Node): ts.Node | undefined {
  let p = n.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p) || ts.isBinaryExpression(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isAsExpression(p))) p = p.parent;
  return p;
}

function isCopy(n: ts.TemplateLiteral): boolean {
  if (ts.isTaggedTemplateExpression(n.parent)) return false;
  const p = context(n);
  if (!p) return true;
  if (ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent)) return !NOT_COPY_ATTR.test(p.parent.name.getText());
  if (ts.isJsxAttribute(p)) return !NOT_COPY_ATTR.test(p.name.getText());
  if (ts.isPropertyAssignment(p)) return !NOT_COPY_PROP.test(p.name.getText());
  if (ts.isNewExpression(p)) return false;                 // new Error(…): a thrown message, for a log and the error boundary
  if (ts.isThrowStatement(p)) return false;
  if (ts.isCallExpression(p)) return !NOT_COPY_CALL.test(p.expression.getText().replace(/\s+/g, ''));
  if (ts.isVariableDeclaration(p)) return !/^(cls|className|classes|url|href|key|path|query|sql|prompt|systemPrompt)$/i.test(p.name.getText());
  return true;
}

export function sentenceTemplates(file: string, text = readFileSync(file, 'utf8')): Sentence[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Sentence[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) && readsAsSentence(staticText(n)) && isCopy(n)) {
      // An inner template (`Save memory${n > 1 ? ` (${n} photos)` : ''}`) is part of its outer one.
      let inner = false; let q: ts.Node | undefined = n.parent;
      while (q && !ts.isSourceFile(q)) { if (ts.isTemplateExpression(q)) { inner = true; break; } q = q.parent; }
      if (!inner) out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: staticText(n).replace(/\u0000/g, '…') });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
