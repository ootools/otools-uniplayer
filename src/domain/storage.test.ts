import { describe, expect, it } from 'vitest';
import { createPlaybackStorage } from './storage';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, values };
}

describe('per-instance playback persistence', () => {
  it('keeps force-new instances independent and saves only approved playback fields', () => {
    const storage = memoryStorage();
    const store = createPlaybackStorage(storage);
    store.save('a', '/m/one.mkv', { position: 42, duration: 100, rate: 1.25, paused: true, volume: 0.7, audioTrack: 2, token: 'never-save', handle: 'never-save', pid: 123 } as never);
    store.save('b', '/m/one.mkv', { position: 4, duration: 100, rate: 1, paused: false, volume: 1 });
    expect(store.load('a', '/m/one.mkv')?.position).toBe(42);
    expect(store.load('b', '/m/one.mkv')?.position).toBe(4);
    expect(store.load('a', '/m/other.mkv')).toBe(null);
    expect([...storage.values.values()].join('')).not.toMatch(/token|handle|pid|never-save/);
    expect(store.last('a')?.path).toBe('/m/one.mkv');
  });
  it('restores the last document position when reopening creates a new tab identity', () => {
    const storage = memoryStorage();
    const store = createPlaybackStorage(storage);
    store.save('closed-view', '/m/one.mkv', { position: 42, duration: 100, rate: 1.25, paused: true, volume: 0.7 });
    expect(store.load('new-view', '/m/one.mkv')?.position).toBe(42);
    store.save('new-view', '/m/one.mkv', { position: 8, duration: 100, rate: 1, paused: false, volume: 1 });
    expect(store.load('new-view', '/m/one.mkv')?.position).toBe(8);
    expect(store.load('closed-view', '/m/one.mkv')?.position).toBe(42);
  });
  it('survives corrupt caches and blocked localStorage without breaking playback', () => {
    const storage = memoryStorage();
    storage.setItem('otools-uniplayer:playback:v1', '{broken');
    expect(createPlaybackStorage(storage).load('a', '/m/a.mp4')).toBe(null);
    const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
    expect(() => createPlaybackStorage(blocked).save('a', '/a.mp4', { position: 1, duration: 100, rate: 1, paused: false, volume: 1 })).not.toThrow();
  });
});
