import type { AssistantReply } from './assistant-core';

export type VoicePhase = 'idle' | 'checking' | 'preparing' | 'recording' | 'stopping' | 'transcribing' | 'sending';
export type VoiceContext = { userId: string; familyId: string; memberId: string; role: string; conversationId: string; token: string; locale: string };
export type FreshFamily = { ok: true; family: { familyId: string; memberId: string; role: string } | null } | { ok: false; code: 'unavailable' | 'context_changed' };
export class VoiceSessionError extends Error {
  constructor(readonly key: string) { super(key); this.name = 'VoiceSessionError'; }
}
export type VoiceSessionDependencies = {
  context: () => VoiceContext | null;
  freshFamily: () => Promise<FreshFamily>;
  permission: () => Promise<boolean>;
  audioMode: (recording: boolean) => Promise<void>;
  prepare: () => Promise<void>;
  record: () => void;
  stop: () => Promise<void>;
  recordingUri: () => string | null;
  transcribe: (context: VoiceContext, uri: string, signal: AbortSignal) => Promise<string>;
  ask: (context: VoiceContext, text: string, signal: AbortSignal) => Promise<AssistantReply>;
  phase: (phase: VoicePhase) => void;
  user: (text: string) => void;
  reply: (reply: AssistantReply) => void;
  error: (error: unknown) => void;
};
type Operation = { generation: number; context: VoiceContext; abort: AbortController };
const identity = (context: VoiceContext | null) => context ? [context.userId, context.familyId, context.memberId, context.role, context.conversationId].join(':') : '';

/** Owns one phone turn. Native work is serialized even after invalidation:
 * an old prepare must settle and release audio before a new recording starts.
 * Aborting a request never claims to roll back work already accepted by the server. */
export class VoiceSession {
  private generation = 0;
  private state: VoicePhase = 'idle';
  private active = true;
  private operation: Operation | null = null;
  private nativeQueue: Promise<unknown> = Promise.resolve();
  private prepared = false;
  private audioClaimed = false;
  private nativeOwner: number | null = null;
  constructor(private readonly deps: VoiceSessionDependencies) {}
  get phase() { return this.state; }
  private setPhase(phase: VoicePhase) { this.state = phase; this.deps.phase(phase); }
  private current(op: Operation) { return this.active && op.generation === this.generation && identity(this.deps.context()) === identity(op.context); }
  private check(op: Operation) { if (!this.current(op)) throw new VoiceSessionError('mobileAssistant.contextChanged'); }
  private latest(op: Operation) { this.check(op); return this.deps.context()!; }
  private native<T>(action: () => Promise<T>): Promise<T> {
    const next = this.nativeQueue.then(action);
    this.nativeQueue = next.catch(() => undefined);
    return next;
  }
  private async release(owner?: number) {
    if (owner !== undefined && this.nativeOwner !== owner) return;
    try {
      if (this.prepared) { await this.deps.stop(); this.prepared = false; }
    } finally {
      if (this.audioClaimed) { await this.deps.audioMode(false); this.audioClaimed = false; }
      if (!this.prepared && !this.audioClaimed) this.nativeOwner = null;
    }
  }
  private begin(): Operation | null {
    if (!this.active || this.state !== 'idle') return null;
    const context = this.deps.context();
    if (!context) { this.deps.error(new VoiceSessionError('mobileAssistant.familyUnavailable')); return null; }
    const operation = { generation: ++this.generation, context, abort: new AbortController() };
    this.operation = operation; this.setPhase('checking');
    return operation;
  }
  private async fresh(op: Operation) {
    const result = await this.deps.freshFamily();
    this.check(op);
    if (!result.ok) throw new VoiceSessionError(result.code === 'unavailable' ? 'mobileAssistant.familyUnavailable' : 'mobileAssistant.contextChanged');
    if (!result.family || result.family.familyId !== op.context.familyId || result.family.memberId !== op.context.memberId || result.family.role !== op.context.role) throw new VoiceSessionError('mobileAssistant.contextChanged');
  }
  private async failed(op: Operation, error: unknown) {
    // Clear native ownership on every failure, including a failed stop. If
    // release still fails, ownership is retained so a later start retries it.
    try { await this.native(() => this.release(op.generation)); } catch { /* next start retries cleanup */ }
    if (this.active && op.generation === this.generation) {
      this.deps.error(this.current(op) ? error : new VoiceSessionError('mobileAssistant.contextChanged'));
      this.setPhase('idle');
    }
  }
  invalidate() {
    const owner = this.operation?.generation;
    this.generation++; this.operation?.abort.abort(); this.operation = null;
    this.setPhase('idle');
    if (owner !== undefined) void this.native(() => this.release(owner)).catch(() => undefined);
  }
  suspend() { this.active = false; this.invalidate(); }
  resume() { this.active = true; }
  /** Resolves after native cleanup; useful for lifecycle owners and tests. */
  async settled() { await this.nativeQueue; }

  async startRecording() {
    const op = this.begin(); if (!op) return;
    try {
      await this.fresh(op); this.check(op); this.setPhase('preparing');
      const granted = await this.deps.permission(); this.check(op);
      if (!granted) throw new VoiceSessionError('mobileAssistant.microphoneDenied');
      await this.native(async () => {
        await this.release(); this.check(op);
        this.nativeOwner = op.generation;
        this.audioClaimed = true;
        await this.deps.audioMode(true); this.check(op);
        await this.deps.prepare(); this.prepared = true; this.check(op);
        this.deps.record();
      });
      this.check(op); this.setPhase('recording');
    } catch (error) { await this.failed(op, error); }
  }
  async stopAndSend() {
    const op = this.operation;
    if (this.state !== 'recording' || !op || !this.current(op)) return;
    this.setPhase('stopping');
    try {
      const uri = await this.native(async () => {
        this.check(op);
        try { await this.deps.stop(); this.prepared = false; return this.deps.recordingUri(); }
        finally { await this.deps.audioMode(false); this.audioClaimed = false; if (!this.prepared) this.nativeOwner = null; }
      });
      this.check(op);
      if (!uri) throw new VoiceSessionError('mobileAssistant.emptyRecording');
      await this.fresh(op); this.setPhase('transcribing');
      const text = await this.deps.transcribe(this.latest(op), uri, op.abort.signal);
      this.check(op);
      if (!text.trim()) throw new VoiceSessionError('mobileAssistant.noSpeech');
      await this.submit(op, text.trim());
    } catch (error) { await this.failed(op, error); }
  }
  async send(text: string) {
    if (!text.trim()) return;
    const op = this.begin(); if (!op) return;
    try { await this.fresh(op); await this.submit(op, text.trim()); }
    catch (error) { await this.failed(op, error); }
  }
  private async submit(op: Operation, text: string) {
    this.check(op); this.setPhase('sending'); this.deps.user(text);
    const reply = await this.deps.ask(this.latest(op), text, op.abort.signal);
    this.check(op); this.deps.reply(reply); this.setPhase('idle');
  }
}
