import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const steps = readFileSync('lib/marketing/automation-steps.ts', 'utf8');
const runner = readFileSync('lib/marketing/automation-runner.ts', 'utf8');
const events = readFileSync('lib/marketing/automation-events.ts', 'utf8');

describe('marketing automation execution boundaries', () => {
  it('does not send to missing recipients and escapes user-controlled email HTML', () => {
    expect(steps).toContain("send_email:skipped(no-recipient)");
    expect(steps).toContain('function escapeHtml');
    expect(steps).toContain('escapeHtml(recipient.name || \'there\')');
    expect(steps).toContain('escapeHtml(step.body || fallback.body)');
  });

  it('surfaces provider and unsupported-action outcomes instead of recording success', () => {
    expect(steps).toContain("send_email:failed");
    expect(steps).toContain('${step.action}:unsupported');
    expect(runner).toContain("status: failed ? 'failed' : 'completed'");
    expect(events).toContain("status: failed ? 'failed' : 'completed'");
    expect(events).toContain("Could not record the event-driven automation result.");
  });
});
