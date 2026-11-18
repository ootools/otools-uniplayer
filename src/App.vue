<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './components/Icon.vue';
import type { HostAdapter, Locale, MediaServiceFactory } from './host/contracts';
import { DEMO_PATHS } from './host/mock';
import { createQueue, fileName, formatTime, nextPath } from './domain/media';
import { shortcutAction } from './domain/playback';
import { initialLocale, translate, type MessageKey } from './i18n';
import { applyTheme, resolveTheme } from './theme';
import { createPlayerSession } from './player/session';

const props = defineProps<{ host: HostAdapter; service: MediaServiceFactory; initialLocale?: Locale }>();
const locale = ref<Locale>(props.initialLocale ?? initialLocale());
const text = (key: MessageKey) => translate(locale.value, key);
const video = ref<HTMLVideoElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const player = createPlayerSession(props.host, props.service, () => video.value, () => active || parallel.value);
const state = player.state;
const files = ref<string[]>([]);
const filter = ref('');
const settings = ref(false);
const about = ref(false);
const notice = ref('');
const opening = ref(false);
const subtitle = ref('off');
const appearance = ref(document.documentElement.getAttribute('data-theme-mode') || 'system');
const readFlag = (key: string, fallback: boolean) => {
  try { const value = localStorage.getItem(`otools-uniplayer:${key}`); return value === null ? fallback : value === 'true'; } catch { return fallback; }
};
const parallel = ref(readFlag('parallel', false));
const resume = ref(readFlag('resume', true));
let active = props.host.activity !== 'inactive';
let pendingFile = '';
let alive = true;
let interval: ReturnType<typeof setInterval> | undefined;
let resolveInitialized!: () => void;
const initialized = new Promise<void>(resolve => { resolveInitialized = resolve; });
const stops: Array<() => void> = [];
const filteredFiles = computed(() => files.value.filter(path => fileName(path).toLowerCase().includes(filter.value.toLowerCase())));
const metadata = computed(() => state.response?.media);
const selectedName = computed(() => metadata.value?.name || (state.path ? fileName(state.path) : text('noFile')));
const playing = computed(() => state.phase === 'playing');
const error = computed(() => state.phase === 'error' || state.phase === 'quota');
const duration = computed(() => metadata.value?.duration || 0);
const timelineStyle = computed(() => ({ '--progress': `${duration.value ? state.position / duration.value * 100 : 0}%` }));

function addToQueue(paths: string[]) { files.value = createQueue([...files.value, ...paths]); }
async function receiveFiles(paths: string[]) {
  if (!alive || !paths.length) return;
  addToQueue(paths);
  const path = paths[0]!;
  if (!active && !parallel.value) { pendingFile = path; return; }
  pendingFile = '';
  await player.open(path, 'ordinaryOpen', resume.value);
}
async function openPaths(paths: string[], reuse: 'document' | 'new' = 'document') {
  await initialized;
  if (!alive || !paths.length || opening.value) return;
  opening.value = true; notice.value = '';
  try { addToQueue(paths); await props.host.openInstances({ files: paths, reuse }); }
  catch (reason) { notice.value = reason instanceof Error ? reason.message : text('errorHint'); }
  finally { opening.value = false; }
}
async function pickFiles() { try { await openPaths(await props.host.pickFiles()); } catch { notice.value = text('errorHint'); } }
const openDemo = () => openPaths([...DEMO_PATHS]);
async function navigate(direction: -1 | 1) {
  const path = nextPath(files.value, state.path, direction);
  if (path) await openPaths([path]);
  else if (direction === -1 && state.path) await player.seek(0);
}
const seek = (event: Event) => player.seek(Number((event.target as HTMLInputElement).value));
async function chooseSubtitle(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value === 'external') {
    try { const path = await props.host.pickSubtitle(); if (path) { subtitle.value = 'external'; await player.subtitles(path); } }
    catch { notice.value = text('unsupportedSubtitle'); }
    return;
  }
  subtitle.value = value;
  await player.subtitles(value);
}
async function fullscreen() {
  if (!stage.value) return;
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await stage.value.requestFullscreen(); }
  catch { notice.value = text('fullscreen'); }
}
function changeLocale(value: Locale) { locale.value = value; try { localStorage.setItem('otools-uniplayer:locale', value); } catch {} }
function changeTheme(value: string) {
  appearance.value = value;
  try { localStorage.setItem('otools:theme-mode', value); } catch {}
  applyTheme(document.documentElement, resolveTheme(undefined, { mode: value, accent: document.documentElement.style.getPropertyValue('--accent') }, matchMedia('(prefers-color-scheme: dark)').matches));
}
function changeFlag(key: 'parallel' | 'resume', value: boolean) {
  if (key === 'parallel') parallel.value = value; else resume.value = value;
  try { localStorage.setItem(`otools-uniplayer:${key}`, String(value)); } catch {}
  if (key === 'parallel' && !value && !active) void player.pause();
}
function handleKey(event: KeyboardEvent) {
  const target = event.target;
  const editable = target instanceof HTMLElement && (target.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(target.tagName));
  const action = shortcutAction(event.key, editable, event.altKey || event.ctrlKey || event.metaKey);
  if (!action || !state.response) return;
  event.preventDefault();
  if (action === 'toggle') void player.toggle();
  if (action === 'back') void player.seek(state.position - 10);
  if (action === 'forward') void player.seek(state.position + 10);
  if (action === 'fullscreen') void fullscreen();
}
function browserDrop(event: DragEvent) {
  event.preventDefault();
  if (props.host.kind === 'browser' && event.dataTransfer?.files.length) notice.value = text('invalidDrop');
}
async function trackEnded() {
  if (duration.value && state.position >= duration.value - 2) { state.position = duration.value; player.save(); await navigate(1); }
  else { await player.seek(state.position, playing.value); }
}

onMounted(async () => {
  try {
    await props.host.ready?.();
    if (!alive) return;
    active = props.host.activity !== 'inactive';
    stops.push(props.host.listenActivity(value => {
      active = value;
      if (!value && !parallel.value) void player.pause();
      else if (value && pendingFile) void receiveFiles([pendingFile]);
    }));
    const fileStop = await props.host.listenFiles(entries => { void receiveFiles(entries.map(entry => entry.path)); });
    if (!alive) { fileStop(); return; }
    stops.push(fileStop);
    const dropStop = await props.host.listenDrop(paths => { void openPaths(paths); });
    if (!alive) { dropStop(); return; }
    stops.push(dropStop);
    stops.push(props.host.beforeClose(() => player.close()));
    const last = props.host.lastOpenedFile();
    if (last && !state.path) await receiveFiles([last]);
    if (!alive) return;
    let ticks = 0;
    interval = setInterval(() => { player.tickDemo(1); if (++ticks % 2 === 0) void player.progress(); }, 1000);
    window.addEventListener('keydown', handleKey);
  } catch (reason) { notice.value = reason instanceof Error ? reason.message : text('errorHint'); }
  finally { resolveInitialized(); }
});
onBeforeUnmount(() => {
  alive = false;
  resolveInitialized();
  if (interval) clearInterval(interval);
  window.removeEventListener('keydown', handleKey);
  stops.forEach(stop => stop());
  void player.close();
});
</script>

<template>
  <div class="player-app" @dragover.prevent @drop="browserDrop">
    <aside class="library">
      <div class="brand"><img src="../logo.svg" alt="" /><div><h1>UniPlayer</h1><span>{{ text('tagline') }}</span></div></div>
      <button class="button accent open-button" data-testid="open-files" :disabled="opening" @click="pickFiles"><Icon name="plus" />{{ text('open') }}<span class="key-hint">⌘ O</span></button>
      <div class="section-heading"><span>{{ text('library') }}</span><span class="count">{{ files.length }}</span></div>
      <label class="file-filter"><Icon name="search" :size="16" /><input v-model="filter" :placeholder="text('filter')" :aria-label="text('filter')" /></label>
      <div class="file-list">
        <div v-if="!files.length" class="library-empty"><Icon name="film" :size="30" /><p>{{ text('noFiles') }}</p><small>{{ text('noFilesText') }}</small></div>
        <button v-for="(path, index) in filteredFiles" :key="path" class="file-item" :class="{ selected: path === state.path }" @click="openPaths([path])">
          <span class="file-art" :class="`art-${index % 3}`"><Icon :name="path === state.path && playing ? 'pause' : 'play'" :size="19" /></span>
          <span class="file-copy"><strong>{{ fileName(path).replace(/\.[^.]+$/, '') }}</strong><small>{{ path.split('.').at(-1)?.toUpperCase() }} <span v-if="path === state.path">· {{ playing ? text('nowPlaying') : text('paused') }}</span></small></span>
          <span v-if="path === state.path" class="playing-bars" :class="{ paused: !playing }"><i /><i /><i /></span>
        </button>
      </div>
      <div class="library-footer"><span class="privacy-dot" />{{ text('localOnly') }}<button class="icon-button" data-testid="settings-toggle" :aria-label="text('settings')" @click="settings = !settings"><Icon name="settings" /></button></div>
    </aside>

    <main class="workspace">
      <header class="workspace-header"><div><span class="eyebrow">{{ text('singleTab') }}</span><h2>{{ selectedName.replace(/\.[^.]+$/, '') }}</h2></div><div class="header-actions"><span v-if="host.kind === 'browser'" class="badge demo-badge">{{ text('demoBadge') }}</span><button v-if="state.path" class="icon-button" :aria-label="text('newInstance')" :title="text('newInstance')" @click="openPaths([state.path], 'new')"><Icon name="external" /></button><button class="icon-button" :aria-label="text('settings')" @click="settings = !settings"><Icon name="settings" /></button></div></header>
      <div v-if="notice" class="notice" role="status">{{ notice }}<button class="icon-button" :aria-label="text('close')" @click="notice = ''"><Icon name="close" :size="16" /></button></div>

      <section ref="stage" class="player-stage" :class="{ 'has-media': !!metadata }">
        <video v-if="metadata" ref="video" playsinline preload="auto" :muted="state.muted" @timeupdate="player.updateTime" @ended="trackEnded" @dblclick="fullscreen">
          <track v-if="state.subtitleUrl" :src="state.subtitleUrl" kind="subtitles" default />
        </video>
        <div v-if="metadata && player.demo" class="demo-scene" :class="`scene-${files.indexOf(state.path) % 3}`" @dblclick="fullscreen"><div class="scene-sun" /><div class="scene-mountain mountain-back" /><div class="scene-mountain mountain-front" /><div class="scene-grain" /><div class="scene-caption"><span>01 / A MOMENT IN MOTION</span><h3>{{ selectedName.replace(/\.[^.]+$/, '') }}</h3><p>{{ text('demoBadge') }} · {{ text('browserHint') }}</p></div></div>
        <div v-if="!metadata && !state.busy && !error" class="stage-empty">
          <div class="empty-orbit"><span class="orbit one" /><span class="orbit two" /><div class="empty-play"><Icon name="play" :size="38" /></div><span class="orbit-dot" /></div>
          <span class="eyebrow">UNIPLAYER / LOCAL FIRST</span><h2>{{ text('emptyTitle') }}</h2><p>{{ text('emptyText') }}</p>
          <div class="empty-actions"><button class="button accent" @click="pickFiles"><Icon name="folder" />{{ text('open') }}</button><button v-if="host.kind === 'browser'" class="button secondary" data-testid="demo-open" @click="openDemo">{{ text('demo') }}<Icon name="chevron" :size="16" /></button></div>
          <small class="format-hint">{{ text('formats') }}</small><span class="drop-hint">{{ text('dropHint') }}</span>
        </div>
        <div v-if="state.busy" class="stage-overlay loading-overlay" role="status"><span class="spinner" /><strong>{{ text('loading') }}</strong></div>
        <div v-if="error" class="stage-overlay error-overlay" role="alert"><div class="error-symbol"><Icon :name="state.phase === 'quota' ? 'film' : 'refresh'" :size="30" /></div><h3>{{ text(state.phase === 'quota' ? 'quotaTitle' : 'errorTitle') }}</h3><p>{{ text(state.phase === 'quota' ? 'quotaText' : 'errorHint') }}</p><small v-if="state.phase !== 'quota'">{{ state.error }}</small><button class="button accent" data-testid="retry" @click="player.retry"><Icon name="refresh" :size="17" />{{ text('retry') }}</button></div>
        <button v-if="metadata && state.phase === 'paused' && !error && !state.busy" class="center-play" :aria-label="text('play')" @click="player.play"><Icon name="play" :size="30" /></button>
      </section>

      <section v-if="metadata" class="transport" :aria-label="text('nowPlaying')">
        <div class="timeline-row"><span>{{ formatTime(state.position) }}</span><input data-testid="timeline" class="timeline" type="range" min="0" :max="duration" :value="state.position" step="0.1" :style="timelineStyle" :aria-label="text('timeline')" @change="seek" /><span>{{ formatTime(duration) }}</span></div>
        <div class="transport-row"><div class="transport-left"><button class="icon-button" :aria-label="text('previous')" @click="navigate(-1)"><Icon name="previous" /></button><button class="icon-button seek-button" :aria-label="text('back')" @click="player.seek(state.position - 10)"><Icon name="back" /><small>10</small></button><button class="play-button" data-testid="play-toggle" :aria-label="text(playing ? 'pause' : 'play')" :disabled="state.busy" @click="player.toggle"><Icon :name="playing ? 'pause' : 'play'" :size="23" /></button><button class="icon-button seek-button" :aria-label="text('forward')" @click="player.seek(state.position + 10)"><Icon name="forward" /><small>10</small></button><button class="icon-button" :aria-label="text('next')" @click="navigate(1)"><Icon name="next" /></button><span class="transport-divider" /><button class="icon-button" :aria-label="text('mute')" @click="player.toggleMute"><Icon :name="state.muted ? 'muted' : 'volume'" /></button><input class="volume-slider" type="range" min="0" max="1" step="0.05" :value="state.volume" :aria-label="text('volume')" @input="player.setVolume(Number(($event.target as HTMLInputElement).value))" /></div>
          <div class="transport-right"><select :value="state.rate" :aria-label="text('speed')" @change="player.setRate(Number(($event.target as HTMLSelectElement).value))"><option v-for="rate in [0.5, 0.75, 1, 1.25, 1.5, 2]" :key="rate" :value="rate">{{ rate }}×</option></select><select v-if="metadata.audioTracks.length" :value="state.audioTrack ?? metadata.audioTracks[0]?.id" :aria-label="text('audio')" @change="player.setAudioTrack(Number(($event.target as HTMLSelectElement).value))"><option v-for="track in metadata.audioTracks" :key="track.id" :value="track.id">{{ track.label || track.language || track.codec }}</option></select><select :value="subtitle" :aria-label="text('subtitles')" @change="chooseSubtitle"><option value="off">{{ text('subtitleOff') }} · CC</option><option v-for="track in metadata.subtitleTracks" :key="track.id" :value="`track:${track.id}`">{{ track.label }}</option><option value="external">{{ text('subtitleOpen') }}</option></select><button class="icon-button" :aria-label="text('fullscreen')" @click="fullscreen"><Icon name="fullscreen" /></button></div></div>
      </section>
      <footer class="workspace-footer"><span v-if="metadata" class="media-info"><span class="status-dot" />{{ text(state.response?.mode === 'copy' ? 'copy' : 'transcode') }}<span>·</span>{{ metadata.width }} × {{ metadata.height }}<span>·</span>{{ metadata.videoCodec.toUpperCase() }}<span v-if="metadata.hdr" class="hdr-warning">{{ text('hdrWarning') }}</span><span v-else>· {{ text('sdr') }}</span></span><span v-else>{{ host.kind === 'browser' ? text('browserHint') : text('hostHint') }}</span><button class="text-button" @click="about = true">{{ text('about') }}</button></footer>
    </main>

    <div v-if="settings || about" class="dialog-backdrop" @click.self="settings = false; about = false">
      <section class="settings-dialog" role="dialog" aria-modal="true" :aria-label="text(about ? 'about' : 'settings')"><header><h2>{{ text(about ? 'about' : 'settings') }}</h2><button class="icon-button" :aria-label="text('close')" @click="settings = false; about = false"><Icon name="close" /></button></header>
        <template v-if="about"><div class="about-brand"><img src="../logo.svg" alt="" /><strong>OTools UniPlayer</strong><span>0.1.0</span></div><p class="about-copy">{{ text('aboutText') }}</p><a class="button secondary" href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener noreferrer">{{ text('license') }}<Icon name="external" :size="16" /></a></template>
        <template v-else><label class="setting-row"><span><strong>{{ text('parallel') }}</strong><small>{{ text('parallelText') }}</small></span><input type="checkbox" :checked="parallel" @change="changeFlag('parallel', ($event.target as HTMLInputElement).checked)" /></label><label class="setting-row"><span><strong>{{ text('resume') }}</strong><small>{{ text('resumeText') }}</small></span><input type="checkbox" :checked="resume" @change="changeFlag('resume', ($event.target as HTMLInputElement).checked)" /></label><label class="setting-row"><strong>{{ text('language') }}</strong><select :value="locale" @change="changeLocale(($event.target as HTMLSelectElement).value as Locale)"><option value="zh">简体中文</option><option value="en">English</option></select></label><label class="setting-row"><strong>{{ text('theme') }}</strong><select :value="appearance" @change="changeTheme(($event.target as HTMLSelectElement).value)"><option value="system">{{ text('system') }}</option><option value="light">{{ text('light') }}</option><option value="dark">{{ text('dark') }}</option></select></label><p class="shortcut-help">{{ text('shortcuts') }}</p></template>
      </section>
    </div>
  </div>
</template>
