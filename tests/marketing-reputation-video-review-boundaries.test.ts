import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const reputation = readFileSync('app/(app)/admin/marketing/reputation/actions.ts', 'utf8');
const video = readFileSync('app/(app)/admin/marketing/video/actions.ts', 'utf8');
const reviews = readFileSync('app/(app)/admin/marketing/reviews/actions.ts', 'utf8');

describe('marketing reputation, video, and review action boundaries', () => {
  it('checks reputation inserts, updates, deletes, and publication changes', () => {
    expect(reputation).toContain('marketingActionFailure');
    expect(reputation).toContain(".select('id').maybeSingle()");
    expect(reputation).not.toContain("await supabase.from('testimonials').delete().eq('id', id);");
    expect(reputation).not.toContain("await supabase.from('case_studies').delete().eq('id', id);");
  });

  it('fails closed when video assets or video rows cannot be read or written', () => {
    expect(video).toContain('marketingActionFailure');
    expect(video).toContain('assetError');
    expect(video).toContain(".select('id').maybeSingle()");
    expect(video).not.toContain("await supabase.from('marketing_videos').update(row).eq('id', id);");
  });

  it('checks review moderation, replies, deletion, and reputation settings', () => {
    expect(reviews).toContain('marketingActionFailure');
    expect(reviews).toContain(".select('singleton').single()");
    expect(reviews).toContain(".select('id').maybeSingle()");
    expect(reviews).not.toContain("await supabase.from('reviews').update({ status }).eq('id', id);");
  });
});
