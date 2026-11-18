import { describe, expect, it } from 'vitest';
import { offsetVtt } from './subtitles';

describe('subtitle source timeline mapping', () => {
  it('subtracts the effective stream origin and drops cues before the new generation', () => {
    const input = 'WEBVTT\n\n1\n00:00:02.000 --> 00:00:04.000\nOld\n\n2\n00:00:08.000 --> 00:00:12.000\nCurrent\n\n3\n00:00:14.000 --> 00:00:16.000 align:start\nLater\n';
    const shifted = offsetVtt(input, 10);
    expect(shifted).not.toContain('Old');
    expect(shifted).toContain('00:00:00.000 --> 00:00:02.000\nCurrent');
    expect(shifted).toContain('00:00:04.000 --> 00:00:06.000 align:start\nLater');
  });
  it('preserves cue text and leaves a zero-origin subtitle unchanged', () => {
    const input = 'WEBVTT\n\n00:01.500 --> 00:02.000\n<b>Hello</b>\n';
    expect(offsetVtt(input, 0)).toBe(input);
    expect(offsetVtt(input, 1)).toContain('00:00:00.500 --> 00:00:01.000\n<b>Hello</b>');
  });
});
