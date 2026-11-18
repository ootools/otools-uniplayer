export interface ReadyMessage { event: 'ready'; port: number; protocol: 1 }

export class JsonLineBuffer {
  private carry = '';
  constructor(private readonly maxLineBytes = 64 * 1024) {}

  push(chunk: string): unknown[] {
    this.carry += chunk;
    const lines = this.carry.split('\n');
    if (lines.some(line => new TextEncoder().encode(line).byteLength > this.maxLineBytes)) {
      this.carry = '';
      throw new Error('sidecar stdout line exceeded limit');
    }
    this.carry = lines.pop() ?? '';
    return lines.flatMap((line) => {
      const text = line.trim();
      if (!text) return [];
      try { return [JSON.parse(text) as unknown]; } catch { return []; }
    });
  }

  reset(): void { this.carry = ''; }
}

export function parseReady(value: unknown): Omit<ReadyMessage, 'event'> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.event !== 'ready' || record.protocol !== 1 || typeof record.port !== 'number' || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) return null;
  return { port: record.port, protocol: 1 };
}

export function createSessionToken(): string {
  const bytes = new Uint8Array(32);
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random tokens are unavailable');
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class GenerationGate {
  private request = 0;
  private highestGeneration = -1;
  private active = true;

  begin(): number { this.request += 1; return this.request; }
  accept(request: number, generation: number): boolean {
    if (!this.active || request !== this.request || !Number.isInteger(generation) || generation < 0 || generation < this.highestGeneration) return false;
    this.highestGeneration = generation;
    return true;
  }
  isCurrent(request: number): boolean { return this.active && request === this.request; }
  invalidate(): void { this.active = false; this.request += 1; }
}

export function mediaUrl(origin: string, path: string, generation: number): string {
  const base = new URL(origin);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !Number.isInteger(Number(base.port))) throw new Error('Media origin must use the service loopback address');
  if (/[?#]/.test(path) || /(?:token|auth|bearer|secret)/i.test(path)) throw new Error('Media paths cannot contain credentials or queries');
  const match = /^\/?media\/(\d+)\/(.+)$/.exec(path);
  if (!match || Number(match[1]) !== generation || match[2].split('/').some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('Media path generation is invalid');
  return new URL(`/media/${generation}/${match[2]}`, base.origin).href;
}

export function loopbackOrigin(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid sidecar port');
  return `http://127.0.0.1:${port}`;
}
