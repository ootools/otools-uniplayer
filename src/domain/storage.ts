export interface PlaybackRecord {
  position: number;
  duration: number;
  rate: number;
  paused: boolean;
  volume: number;
  audioTrack?: number;
}

export interface PlaybackState extends PlaybackRecord {
  path: string;
  updatedAt: number;
  instanceId: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = 'otools-uniplayer:playback:v1';

type StateMap = Record<string, PlaybackState>;

function safeStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function readMap(storage: StorageLike | null): StateMap {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as StateMap;
  } catch { return {}; }
}

function identity(instanceId: string, path: string): string {
  return JSON.stringify([instanceId, path]);
}

function normalize(record: Partial<PlaybackRecord>): PlaybackRecord {
  const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    position: Math.max(0, finite(record.position, 0)),
    duration: Math.max(0, finite(record.duration, 0)),
    rate: Math.min(2, Math.max(0.5, finite(record.rate, 1))),
    paused: Boolean(record.paused),
    volume: Math.min(1, Math.max(0, finite(record.volume, 1))),
    ...(typeof record.audioTrack === 'number' && Number.isInteger(record.audioTrack) ? { audioTrack: record.audioTrack } : {}),
  };
}

export function createPlaybackStorage(storage?: StorageLike) {
  const target = safeStorage(storage);
  return {
    load(instanceId: string, path: string): PlaybackState | null {
      const states = readMap(target);
      const state = states[identity(instanceId, path)];
      if (state && state.path === path) return state;
      const latest = Object.values(states).filter(entry => entry && entry.path === path)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return latest ? { ...latest, ...normalize(latest), instanceId } : null;
    },
    save(instanceId: string, path: string, record: PlaybackRecord): void {
      if (!target || !instanceId || !path) return;
      try {
        const states = readMap(target);
        states[identity(instanceId, path)] = { ...normalize(record), path, instanceId, updatedAt: Date.now() };
        target.setItem(KEY, JSON.stringify(states));
      } catch { /* Playback continues even with an unavailable local cache. */ }
    },
    last(instanceId: string): PlaybackState | null {
      const values = Object.values(readMap(target)).filter((state) => state && state.path && state.updatedAt);
      return values.filter((state) => state.instanceId === instanceId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    },
  };
}
