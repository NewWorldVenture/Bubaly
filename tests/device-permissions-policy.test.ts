import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';

describe('browser capabilities used by existing family tools', () => {
  it('allows same-origin camera, voice, and location without delegating to third parties', async () => {
    const rules = await nextConfig.headers!();
    const common = rules.find((rule) => rule.source === '/(.*)');
    const policy = common?.headers.find((header) => header.key === 'Permissions-Policy')?.value;
    expect(policy).toBeTruthy();
    const directives = Object.fromEntries(policy!.split(',').map((part) => part.trim().split('=')));
    for (const feature of ['camera', 'microphone', 'geolocation']) {
      expect(directives[feature], `${feature} must not be disabled by the server`).toBe('(self)');
    }
    expect(policy).not.toContain('*');
  });
});
