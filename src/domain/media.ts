export type MediaKind = 'video' | 'audio' | 'subtitle';

const extensions: Record<MediaKind, ReadonlySet<string>> = {
  video: new Set(['mkv', 'mp4', 'avi', 'm4v', 'mov', '3gp', 'ts', 'mts', 'm2ts', 'wmv', 'flv', 'webm', 'mpg', 'mpeg', 'ogv', 'ogm']),
  audio: new Set(['mp3', 'aac', 'mka', 'dts', 'flac', 'ogg', 'oga', 'm4a', 'ac3', 'opus', 'wav', 'aiff', 'ape', 'tta']),
  subtitle: new Set(['srt', 'smi', 'ssa', 'ass', 'vtt', 'sub', 'idx', 'lrc']),
};

export function classifyFile(path: string): MediaKind | null {
  const name = path.split(/[\\/]/).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return (Object.keys(extensions) as MediaKind[]).find((kind) => extensions[kind].has(ext)) ?? null;
}

export function createQueue(paths: readonly string[]): string[] {
  const unique = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
  const videos = unique.filter((path) => classifyFile(path) === 'video');
  const audio = unique.filter((path) => classifyFile(path) === 'audio');
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...videos.sort((a, b) => collator.compare(a.split(/[\\/]/).at(-1) ?? a, b.split(/[\\/]/).at(-1) ?? b)),
    ...audio.sort((a, b) => collator.compare(a.split(/[\\/]/).at(-1) ?? a, b.split(/[\\/]/).at(-1) ?? b))];
}

export function nextPath(queue: readonly string[], current: string, direction: -1 | 1): string | null {
  const index = queue.indexOf(current);
  if (index < 0) return direction === 1 ? queue[0] ?? null : null;
  return queue[index + direction] ?? null;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
