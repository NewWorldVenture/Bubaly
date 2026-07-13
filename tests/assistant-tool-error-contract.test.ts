import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('assistant tool error boundary', () => {
  it('does not pass raw database errors into model-visible tool results', () => {
    const source = readFileSync('lib/assistant/tools.ts', 'utf8');

    expect(source).toContain('function toolFailure(');
    expect(source).toContain('console.error(`[assistant] ${operation} failed:`, error);');
    expect(source).not.toMatch(/error:\s*error\.message/);
  });
});
