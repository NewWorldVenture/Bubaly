import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Page audit B7 (the signed-in app as a teen and as a child).
//
// The two screens a child's login passes through were the two the crawls could
// not see properly. The parent's "Create login" row on /dashboard/family-access
// only renders after its button is pressed, so no render crawl reached it: its
// username and PIN inputs were named by nothing but English placeholders
// ("username", "PIN"), and the confirm button held only a check-mark icon, so
// a screen reader announced the step that creates a child's login as "button".
// The reset row's "Save" was a literal, and its button lost its name entirely
// while the spinner replaced the text. And on /kid-login itself the show/hide
// PIN control said "Show PIN" in English to a child in any household.

const managerSrc = readFileSync('components/family/child-access-manager.tsx', 'utf8');
const kidLoginSrc = readFileSync('components/auth/kid-login-form.tsx', 'utf8');

/** Every opening tag of `<tag` in `src`, with `{…}` balanced. */
function openingTags(src: string, tag: string): string[] {
  const tags: string[] = [];
  for (let at = src.indexOf(`<${tag}`); at !== -1; at = src.indexOf(`<${tag}`, at + 1)) {
    const next = src[at + tag.length + 1];
    if (next !== ' ' && next !== '\n') continue; // <Buttons, <inputRef…
    let depth = 0;
    for (let i = at + 1; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      else if (depth === 0 && src[i] === '>') { tags.push(src.slice(at, i + 1)); break; }
    }
  }
  return tags;
}

describe('the child-login controls are named, in the family\'s language', () => {
  it('finds the controls it checks', () => {
    expect(openingTags(managerSrc, 'input').length).toBeGreaterThanOrEqual(3);
    expect(openingTags(managerSrc, 'Button').length).toBeGreaterThanOrEqual(2);
  });

  it('names every input and every Button in the parent\'s create and reset rows', () => {
    const unnamed = [...openingTags(managerSrc, 'input'), ...openingTags(managerSrc, 'Button')]
      .filter((tag) => !/\saria-label=\{t\('/.test(tag));
    expect(unnamed).toEqual([]);
  });

  it('shows no English literal as a placeholder or a button label', () => {
    expect(managerSrc).not.toMatch(/placeholder="[A-Za-z]/);
    expect(managerSrc).not.toMatch(/:\s*'Save'/);
  });

  it('says show and hide PIN in the child\'s language on /kid-login', () => {
    const labels = [...kidLoginSrc.matchAll(/aria-label=\{([^}]*)\}/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.filter((expr) => /'[A-Z][a-z]/.test(expr) && !/t\('/.test(expr))).toEqual([]);
    expect(kidLoginSrc).toContain("t('kidLogin.hidePin')");
    expect(kidLoginSrc).toContain("t('kidLogin.showPin')");
  });

  it('the rule would have caught the shapes that shipped', () => {
    const before = '<input value={username} placeholder="username" />';
    expect(openingTags(before, 'input').filter((tag) => !/\saria-label=\{t\('/.test(tag))).toHaveLength(1);
    expect("aria-label={showPin ? 'Hide PIN' : 'Show PIN'}".match(/'[A-Z][a-z]/)).not.toBeNull();
  });
});
