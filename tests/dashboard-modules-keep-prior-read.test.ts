import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// A-05 (agent-05, PLA-0792): weather-module.loadSaved and assistant-module's
// conversation-list + message reads dropped `error` and clobbered visible state to
// empty on a transient failure — the family's saved cities vanished, the AI
// conversation sidebar emptied, and clicking a thread showed a fake fresh greeting
// that hid real history. Each now captures `error` and keeps prior state (no
// false-empty). Low severity (convenience surfaces), no destructive write.

const weather = fs.readFileSync('components/modules/weather-module.tsx', 'utf8');
const assistant = fs.readFileSync('components/modules/assistant-module.tsx', 'utf8');

describe('dashboard modules keep prior state on failed read (A-05)', () => {
  it('weather loadSaved does not wipe saved cities on error', () => {
    const load = weather.slice(weather.indexOf('const loadSaved'), weather.indexOf('const loadSaved') + 500);
    expect(load).toContain("const { data, error } = await supabase.from('weather_locations')");
    expect(load).toContain('if (error) return [];');
    // The keep-prior guard must precede the setSaved clobber.
    expect(load.indexOf('if (error) return')).toBeLessThan(load.indexOf('setSaved(data ?? [])'));
  });

  it('assistant conversation list keeps prior history on error', () => {
    const load = assistant.slice(assistant.indexOf('loadConversations'), assistant.indexOf('loadConversation ='));
    expect(load).toContain("const { data, error } = await supabase.from('ai_conversations')");
    expect(load.indexOf('if (error) return;')).toBeLessThan(load.indexOf('setConversations(data ?? [])'));
  });

  it('assistant message load does not switch into a misleading greeting on error', () => {
    const load = assistant.slice(assistant.indexOf('const loadConversation ='));
    expect(load).toContain("const { data, error } = await supabase.from('ai_messages')");
    // Error bail must come before setConvId + the greeting fallback.
    expect(load.indexOf('if (error) return;')).toBeLessThan(load.indexOf('setConvId(id)'));
  });
});
