import type { PlaybackRecord } from '../domain/storage';

export type Locale = 'zh' | 'en';
export type PlaybackMode = 'copy' | 'transcode';
export type PipelineState = 'probing' | 'ready' | 'playing' | 'paused' | 'buffering' | 'error' | 'closed' | string;
export interface AudioTrack { id: number; label: string; language?: string; codec: string }
export interface SubtitleTrack { id: number; label: string; language?: string }
export interface MediaMetadata {
  name: string;
  duration: number;
  videoCodec: string;
  width: number;
  height: number;
  hdr: boolean;
  hdrToneMapped?: boolean;
  audioTracks: AudioTrack[];
  subtitleTracks?: SubtitleTrack[];
}
export interface OpenResponse {
  generation: number;
  effectiveStart: number;
  requestedStart?: number;
  seekPrecision?: 'keyframe' | 'exact';
  playlist: string;
  mode: PlaybackMode;
  media: MediaMetadata;
}
export interface StatusResponse {
  generation: number;
  position: number;
  paused: boolean;
  rate: number;
  pipelineState: PipelineState;
  needReload: boolean;
  cacheBytes: number;
}
export interface PlaybackSession {
  readonly demo: boolean;
  open(path: string, options?: { start?: number; rate?: number; audioTrack?: number }): Promise<OpenResponse>;
  seek(position: number, options?: { rate?: number; audioTrack?: number }): Promise<OpenResponse>;
  pause(position: number, paused: boolean): Promise<void>;
  progress(position: number, paused: boolean, rate: number): Promise<void>;
  status(): Promise<StatusResponse>;
  close(): Promise<void>;
  playlistUrl(response: OpenResponse): string;
  fetchSubtitle(path: string): Promise<Blob>;
  selectSubtitle(path: string): Promise<string | null>;
}

export interface MediaServiceFactory {
  create(instanceId: string, state?: { token?: string; handle?: string; pid?: number }): Promise<PlaybackSession>;
}

export interface HostFile { path: string; name?: string; ext?: string }
export interface InstanceOpenRequest { files: string[]; reuse: 'document' | 'new' }
export interface HostAdapter {
  readonly kind: 'otools' | 'browser';
  readonly instanceId: string;
  readonly activity: 'active' | 'inactive' | 'unknown';
  readonly isTauri: boolean;
  readonly clipboardAvailable: boolean;
  ready?(): Promise<void>;
  pickFiles(): Promise<string[]>;
  pickSubtitle(): Promise<string | null>;
  openInstances(request: InstanceOpenRequest): Promise<string[]>;
  lastOpenedFile(): string | null;
  listenFiles(handler: (files: HostFile[]) => void): Promise<() => void>;
  listenDrop(handler: (paths: string[]) => void): Promise<() => void>;
  listenActivity(handler: (active: boolean) => void): () => void;
  beforeClose(handler: () => Promise<void>): () => void;
  loadPlayback(instanceId: string, path: string): PlaybackRecord | null;
  savePlayback(instanceId: string, path: string, state: PlaybackRecord): void;
  readTextFile(path: string): Promise<string>;
  toast(message: string): void;
}
