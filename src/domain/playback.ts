export type LoadIntent = 'ordinaryOpen' | 'resume' | 'fromBeginning';
export interface SavedProgress { position: number; duration: number; completed?: boolean; manualWatched?: boolean }

export function isFinished(state: SavedProgress): boolean {
  if (state.manualWatched || state.completed) return true;
  return Number.isFinite(state.position) && Number.isFinite(state.duration) && state.duration > 0 && state.position / state.duration >= 0.97;
}

export function resolveLoadPlan(state: SavedProgress | null | undefined, intent: LoadIntent, resumePreference: boolean): number {
  const position = state && Number.isFinite(state.position) && state.position > 0 ? state.position : 0;
  if (intent === 'fromBeginning') return 0;
  if (intent === 'resume') return position;
  return resumePreference && state && !isFinished(state) ? position : 0;
}

export function globalPosition(effectiveStart: number, videoTime: number, duration: number): number {
  const sum = Math.max(0, Number.isFinite(effectiveStart) ? effectiveStart : 0) + Math.max(0, Number.isFinite(videoTime) ? videoTime : 0);
  return Number.isFinite(duration) && duration > 0 ? Math.min(duration, sum) : sum;
}

export type ShortcutAction = 'toggle' | 'back' | 'forward' | 'fullscreen' | null;
export function shortcutAction(key: string, isEditable: boolean, modified: boolean): ShortcutAction {
  if (isEditable || modified) return null;
  if (key === ' ' || key.toLowerCase() === 'k') return 'toggle';
  if (key === 'ArrowLeft') return 'back';
  if (key === 'ArrowRight') return 'forward';
  if (key.toLowerCase() === 'f') return 'fullscreen';
  return null;
}
