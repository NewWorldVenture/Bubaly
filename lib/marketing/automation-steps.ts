import 'server-only';
import { getResend, FROM_EMAIL, emailEnabled } from '@/lib/email';
import type { Copy } from '@/lib/marketing/automation-triggers';

export type Step = { action: string; subject?: string; body?: string };
export type Recipient = { email: string | null; name?: string | null };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

/**
 * The per-step results an earlier attempt of a run recorded in its metadata
 * (`{ actions: [...] }`), or none. A failed run is retried by running its steps
 * again, and this is how the retry knows which of them already went out.
 */
export function recordedActions(metadata: unknown): string[] {
  const actions = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as { actions?: unknown }).actions
    : undefined;
  return Array.isArray(actions) ? actions.map((action) => (typeof action === 'string' ? action : '')) : [];
}

/** Emails this attempt actually sent: a send carried over from `previous` was not sent again. */
export function emailsSent(actions: readonly string[], previous: readonly string[] = []): number {
  return actions.filter((action, i) => action === 'send_email' && previous[i] !== 'send_email').length;
}

/**
 * The log to record when an attempt failed without producing one of its own
 * (the caller caught a throw from `runSteps`). Writing a bare
 * `['automation:failed']` there erased the only record of which emails had
 * already gone, so the next retry sent them again. This keeps every send the
 * earlier attempt recorded, by position, and marks the rest failed, so the run
 * stays failed and the retry repeats nothing that was delivered.
 */
export function failedAttempt(steps: readonly unknown[], previous: readonly string[] = []): string[] {
  if (steps.length === 0) return ['automation:failed'];
  return steps.map((_, i) => (previous[i] === 'send_email' ? 'send_email' : 'automation:failed'));
}

/**
 * Executes a workflow's steps for one recipient. Only `send_email` actually
 * sends today (via Resend); other actions (notify_admin / apply_tag /
 * add_to_segment / update_lead_score …) are recorded but not yet executed.
 * Returns a per-step result log for the run's metadata. Shared by both the
 * scheduled runner and the event-driven dispatcher so behaviour stays identical.
 *
 * `previous` is the log of the earlier attempt when a failed run is retried.
 * A `send_email` step it records as sent is carried over and NOT sent again:
 * every step but `send_email` is recorded `:unsupported`, which fails the run,
 * so a workflow such as "send_email, then apply_tag" is retried on every pass
 * and used to mail the same person the same email each time. A failed, skipped
 * or never-attempted send is still sent. Steps are matched by position.
 *
 * A step that throws (a malformed workflow, such as a body that is not text)
 * is recorded `<action>:failed` and the rest still run. It used to escape, and
 * the caller then replaced the whole log, sends included, with one failure.
 */
export async function runSteps(steps: Step[], recipient: Recipient, fallback: Copy, previous: readonly string[] = []): Promise<string[]> {
  const done: string[] = [];
  for (const [i, step] of steps.entries()) {
    try {
      if (step.action === 'send_email' && previous[i] === 'send_email') {
        done.push('send_email');
        continue;
      }
      if (step.action === 'send_email' && !recipient.email) {
        done.push('send_email:skipped(no-recipient)');
        continue;
      }
      if (step.action === 'send_email' && recipient.email) {
        const subject = step.subject || fallback.subject;
        const html = `<p>Hi ${escapeHtml(recipient.name || 'there')},</p><p>${escapeHtml(step.body || fallback.body)}</p><p>— The Bubaly Team</p>`;
        if (emailEnabled()) {
          try {
            const { error } = await getResend().emails.send({ from: FROM_EMAIL, to: recipient.email, subject, html });
            done.push(error ? 'send_email:failed' : 'send_email');
          } catch (error) {
            console.error('[marketing automation] email provider call failed', error);
            done.push('send_email:failed');
          }
        } else {
          done.push('send_email:skipped(no-key)');
        }
      } else {
        done.push(`${step.action}:unsupported`);
      }
    } catch (error) {
      console.error('[marketing automation] step threw', error);
      done.push(`${typeof step?.action === 'string' ? step.action : 'step'}:failed`);
    }
  }
  return done;
}
