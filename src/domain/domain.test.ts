import { describe, expect, it } from 'vitest';
import { classifyFile, createQueue, nextPath, formatTime } from './media';
import { isFinished, resolveLoadPlan, globalPosition, shortcutAction } from './playback';

describe('upstream file classification and queue policy', () => {
  it('classifies case-insensitive media and keeps subtitle files out of playback', () => {
    expect(classifyFile('/movies/Episode.MKV')).toBe('video');
    expect(classifyFile('C:\\Music\\a.FLAC')).toBe('audio');
    expect(classifyFile('/movies/Episode.zh.srt')).toBe('subtitle');
    expect(classifyFile('/movies/queue.m3u8')).toBe(null);
  });
  it('groups videos before audio, naturally sorts episodes and de-duplicates exact paths', () => {
    expect(createQueue(['/m/Episode10.mp4', '/m/theme.mp3', '/m/Episode2.mp4', '/m/Episode2.mp4', '/m/sub.srt']))
      .toEqual(['/m/Episode2.mp4', '/m/Episode10.mp4', '/m/theme.mp3']);
  });
  it('does not wrap previous/next past queue boundaries', () => {
    expect(nextPath(['/1.mp4', '/2.mp4'], '/1.mp4', -1)).toBe(null);
    expect(nextPath(['/1.mp4', '/2.mp4'], '/1.mp4', 1)).toBe('/2.mp4');
    expect(nextPath(['/1.mp4', '/2.mp4'], '/2.mp4', 1)).toBe(null);
  });
});

describe('catalog resume decisions adapted from UniPlayer', () => {
  it('treats exactly 97 percent as completed, but not the preceding position', () => {
    expect(isFinished({ position: 96.99, duration: 100 })).toBe(false);
    expect(isFinished({ position: 97, duration: 100 })).toBe(true);
    expect(isFinished({ position: 1, duration: 0 })).toBe(false);
  });
  it('resumes ordinary unfinished files only when the preference is enabled', () => {
    expect(resolveLoadPlan({ position: 40, duration: 100 }, 'ordinaryOpen', true)).toBe(40);
    expect(resolveLoadPlan({ position: 40, duration: 100 }, 'ordinaryOpen', false)).toBe(0);
    expect(resolveLoadPlan({ position: 97, duration: 100 }, 'ordinaryOpen', true)).toBe(0);
    expect(resolveLoadPlan({ position: 40, duration: 100, manualWatched: true }, 'ordinaryOpen', true)).toBe(0);
  });
  it('keeps explicit resume and beginning distinct and rejects invalid observed time', () => {
    expect(resolveLoadPlan({ position: 98, duration: 100, completed: true }, 'resume', false)).toBe(98);
    expect(resolveLoadPlan({ position: 40, duration: 100 }, 'fromBeginning', true)).toBe(0);
    expect(resolveLoadPlan({ position: Number.NaN, duration: 100 }, 'resume', true)).toBe(0);
  });
  it('uses the service effective origin for the global video timeline', () => {
    expect(globalPosition(118.4, 7.5, 400)).toBeCloseTo(125.9);
    expect(globalPosition(118.4, 500, 400)).toBe(400);
    expect(formatTime(3661)).toBe('1:01:01');
  });
  it('does not steal keys from inputs or modified shortcuts', () => {
    expect(shortcutAction(' ', false, false)).toBe('toggle');
    expect(shortcutAction('ArrowRight', false, false)).toBe('forward');
    expect(shortcutAction('f', false, false)).toBe('fullscreen');
    expect(shortcutAction(' ', true, false)).toBe(null);
    expect(shortcutAction('ArrowRight', false, true)).toBe(null);
  });
});
