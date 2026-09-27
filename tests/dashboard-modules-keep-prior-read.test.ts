import { at } from './helpers/source-order';
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
    // The window is generous on purpose: this assertion used to slice 500 chars
    // and match the literal `if (error) return [];`, which pinned a STATEMENT
    // rather than the behaviour. When the bail grew to also surface the error to
    // the user — strictly better, and the thing this file exists to encourage —
    // the guard went red on an improvement. A test that fails when the code gets
    // better is testing the wrong thing.
    const load = weather.slice(weather.indexOf('const loadSaved'), weather.indexOf('const loadSaved') + 1200);
    expect(load).toContain("const { data, error } = await supabase.from('weather_locations')");
    // What actually matters: the error is bailed on, and the bail happens BEFORE
    // the line that would clobber the visible list to empty.
    expect(load).toMatch(/if \(error\)[^\n]*return \[\];/);
    expect(at(load, 'if (error)')).toBeLessThan(at(load, 'setSaved(data ?? [])'));
  });

  it('assistant conversation list keeps prior history on error', () => {
    const load = assistant.slice(assistant.indexOf('loadConversations'), assistant.indexOf('loadConversation ='));
    expect(load).toContain("const { data, error } = await supabase.from('ai_conversations')");
    expect(at(load, 'if (error) return;')).toBeLessThan(at(load, 'setConversations(data ?? [])'));
  });

  it('assistant message load does not switch into a misleading greeting on error', () => {
    const load = assistant.slice(assistant.indexOf('const loadConversation ='));
    expect(load).toContain("const { data, error } = await supabase.from('ai_messages')");
    // Error bail must come before setConvId + the greeting fallback.
    expect(at(load, 'if (error) return;')).toBeLessThan(at(load, 'setConvId(id)'));
  });
});
