import type { ActiveFamily } from './family';
import type { FreshFamily } from './voice-session';

/** A late family read can never replace the current account's context. */
export class FamilySession {
  private generation = 0;
  constructor(private readonly deps: {
    user: () => string | null;
    read: (userId: string) => Promise<ActiveFamily | null>;
    result: (family: ActiveFamily | null, failed: boolean) => void;
    loading: (loading: boolean) => void;
  }) {}
  invalidate() { this.generation++; }
  async refresh(): Promise<FreshFamily> {
    const userId = this.deps.user();
    if (!userId) return { ok: false, code: 'context_changed' };
    const generation = ++this.generation;
    const current = () => generation === this.generation && userId === this.deps.user();
    this.deps.loading(true);
    try {
      const family = await this.deps.read(userId);
      if (!current()) return { ok: false, code: 'context_changed' };
      this.deps.result(family, false);
      return { ok: true, family };
    } catch (error) {
      if (!current()) return { ok: false, code: 'context_changed' };
      console.error('[mobile-family] family context read failed', error);
      this.deps.result(null, true);
      return { ok: false, code: 'unavailable' };
    } finally { if (current()) this.deps.loading(false); }
  }
}
