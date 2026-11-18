const timing = /^((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})(.*)$/;

function seconds(value: string): number {
  const parts = value.split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}
function timestamp(value: number): string {
  const ms = Math.max(0, Math.round(value * 1000));
  const hour = Math.floor(ms / 3_600_000);
  const minute = Math.floor(ms / 60_000) % 60;
  const second = Math.floor(ms / 1000) % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

/** Service subtitles use source times; each HLS generation begins at zero. */
export function offsetVtt(source: string, effectiveStart: number): string {
  if (!Number.isFinite(effectiveStart) || effectiveStart <= 0) return source;
  const blocks = source.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const shifted = blocks.flatMap(block => {
    const lines = block.split('\n');
    const index = lines.findIndex(line => timing.test(line));
    if (index < 0) return [block];
    const match = timing.exec(lines[index]!);
    if (!match) return [block];
    const start = seconds(match[1]!) - effectiveStart;
    const end = seconds(match[2]!) - effectiveStart;
    if (end <= 0) return [];
    lines[index] = `${timestamp(start)} --> ${timestamp(end)}${match[3]}`;
    return [lines.join('\n')];
  });
  return shifted.join('\n\n');
}
