import 'server-only';
import { getResend, FROM_EMAIL, emailEnabled } from '@/lib/email';
import type { Copy } from '@/lib/marketing/automation-triggers';

export type Step = { action: string; subject?: string; body?: string };
export type Recipient = { email: string | null; name?: string | null };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

/**
 * Executes a workflow's steps for one recipient. Only `send_email` actually
 * sends today (via Resend); other actions (notify_admin / apply_tag /
 * add_to_segment / update_lead_score …) are recorded but not yet executed.
 * Returns a per-step result log for the run's metadata. Shared by both the
 * scheduled runner and the event-driven dispatcher so behaviour stays identical.
 */
export async function runSteps(steps: Step[], recipient: Recipient, fallback: Copy): Promise<string[]> {
  const done: string[] = [];
  for (const step of steps) {
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
  }
  return done;
}
