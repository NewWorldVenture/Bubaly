import { cloneElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withLocale } from './render-translated';

// Render a server PAGE the way a test can read it.
//
// React's static renderer does not await an async server component nested in
// the tree — a page's own `async function PlanDonut`, or a RoleDonut that calls
// getTranslations — so those are resolved first, depth first, and every
// ordinary component is left to React. The resolved tree then renders inside a
// LocaleProvider holding the real English catalogue, the way app/layout.tsx
// wraps it, so a client component's useTranslations reads words, not keys.
export async function resolveServerChildren(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServerChildren));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') {
    const component = node.type as (props: unknown) => Promise<ReactNode>;
    return resolveServerChildren(await component(node.props));
  }
  if (!Object.prototype.hasOwnProperty.call(node.props, 'children')) return node;
  return cloneElement(node, {}, await resolveServerChildren(node.props.children));
}

export async function renderServerPage(tree: ReactNode): Promise<string> {
  return renderToStaticMarkup(withLocale(await resolveServerChildren(tree)));
}

/** The page's words: tags stripped, the entities the tests read unescaped, whitespace folded. */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, '’').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The value an admin StatCard renders above `label`:
 * `<p class="… leading-none">VALUE</p><p class="mt-1 text-xs text-muted">LABEL</p>`.
 */
export function statCardValue(html: string, label: string): string {
  const match = new RegExp(`leading-none">([^<]*)</p><p class="mt-1 text-xs text-muted">${escapeRe(label)}</p>`).exec(html);
  if (!match) throw new Error(`the "${label}" tile is not on the page`);
  return match[1];
}
