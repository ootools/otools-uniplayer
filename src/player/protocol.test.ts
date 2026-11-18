import { describe, expect, it } from 'vitest';
import { JsonLineBuffer, parseReady, createSessionToken, GenerationGate, mediaUrl } from './protocol';

describe('private sidecar protocol', () => {
  it('joins fragmented stdout and parses several complete lines without leaking stderr', () => {
    const lines = new JsonLineBuffer();
    expect(lines.push('{"event":"rea')).toEqual([]);
    expect(lines.push('dy","port":43210,"protocol":1}\r\n{"event":"ignored"}\n'))
      .toEqual([{ event: 'ready', port: 43210, protocol: 1 }, { event: 'ignored' }]);
  });
  it('ignores malformed complete lines and rejects overlong unterminated output', () => {
    const lines = new JsonLineBuffer(64);
    expect(lines.push('not-json\n{"ok":true}\n')).toEqual([{ ok: true }]);
    expect(() => lines.push('x'.repeat(65))).toThrow();
  });
  it('bounds complete stdout lines as well as a trailing unterminated line', () => {
    const lines = new JsonLineBuffer(64);
    expect(() => lines.push(JSON.stringify({ message: 'x'.repeat(70) }) + '\n')).toThrow(/limit/);
    expect(() => lines.push('{"ok":true}\n' + 'x'.repeat(70))).toThrow(/limit/);
    expect(lines.push('{"ok":true}\n')).toEqual([{ ok: true }]);
  });
  it('requires protocol one and a valid TCP loopback port', () => {
    expect(parseReady({ event: 'ready', port: 43210, protocol: 1 })).toEqual({ port: 43210, protocol: 1 });
    expect(parseReady({ event: 'ready', port: 0, protocol: 1 })).toBe(null);
    expect(parseReady({ event: 'ready', port: 43210, protocol: 2 })).toBe(null);
  });
  it('creates a 32-byte cryptographic token, not a persistent identifier', () => {
    expect(createSessionToken()).toMatch(/^[a-f0-9]{64}$/);
    expect(createSessionToken()).not.toBe(createSessionToken());
  });
  it('never accepts stale requests or lower generations after a newer operation', () => {
    const gate = new GenerationGate();
    const open = gate.begin();
    const seek = gate.begin();
    expect(gate.accept(seek, 3)).toBe(true);
    expect(gate.accept(open, 4)).toBe(false);
    const next = gate.begin();
    expect(gate.accept(next, 2)).toBe(false);
    expect(gate.accept(next, 4)).toBe(true);
    gate.invalidate();
    expect(gate.accept(next, 5)).toBe(false);
  });
  it('only authorizes current-generation loopback media paths without credentials in URLs', () => {
    expect(mediaUrl('http://127.0.0.1:43210', '/media/7/index.m3u8', 7)).toBe('http://127.0.0.1:43210/media/7/index.m3u8');
    expect(() => mediaUrl('http://127.0.0.1:43210', 'https://evil.test/media/7/a', 7)).toThrow();
    expect(() => mediaUrl('http://127.0.0.1:43210', '/media/6/index.m3u8', 7)).toThrow();
    expect(() => mediaUrl('http://127.0.0.1:43210', '/media/7/index.m3u8?token=secret', 7)).toThrow();
  });
});
