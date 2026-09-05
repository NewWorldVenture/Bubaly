import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/modules/career-module.tsx', 'utf8');
function bodies(fn: string): string[] {
  const out: string[] = []; let from = 0;
  for (;;) {
    const start = src.indexOf(`async function ${fn}(`, from);
    if (start === -1) break;
    const after = src.indexOf('async function ', start + 1);
    out.push(src.slice(start, after === -1 ? undefined : after)); from = start + 1;
  }
  return out;
}

describe('career-module writes fail visibly', () => {
  it('every inline mutation guards its result', () => {
    for (const fn of ['moveStage', 'deleteApplication', 'setPrimary', 'deleteResume', 'archiveProfile', 'deleteProfile']) {
      const [b] = bodies(fn);
      expect(b, fn).toBeTruthy();
      expect(b, fn).toMatch(/const \{ error \} =/);
      expect(b, fn).toContain('toastError(describeDbError(error))');
    }
  });
  it('all three forms guard their insert/update', () => {
    const forms = bodies('onSubmit');
    expect(forms).toHaveLength(3);
    for (const b of forms) {
      expect(b).toMatch(/const \{ (data, )?error \} =/);
      expect(b).toContain('describeDbError(error)');
    }
  });
  it('making a resume primary clears the others first, both writes guarded', () => {
    const [b] = bodies('setPrimary');
    expect(b).toContain("update({ is_primary: false }).eq('profile_id', r.profile_id).neq('id', r.id)");
    expect(b).toContain('if (clearError) return toastError(describeDbError(clearError))');
  });
  it('resume versions persist the deterministic ATS score with the text', () => {
    const [form] = bodies('onSubmit').filter((b) => b.includes("from('resume_versions')"));
    expect(form).toContain('const ats = atsScore(body, keywords)');
    expect(form).toContain('ats_score: ats.score, matched_keywords: ats.matched, missing_keywords: ats.missing');
  });
  it('destructive actions are confirmed', () => {
    for (const fn of ['deleteApplication', 'deleteResume', 'deleteProfile']) expect(bodies(fn)[0], fn).toMatch(/if \(!confirm\(/);
  });
});
