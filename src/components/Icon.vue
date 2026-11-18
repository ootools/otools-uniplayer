<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  play: 'M8 5v14l11-7z', pause: 'M8 5v14M16 5v14',
  folder: 'M3 7V5h6l2 2h10v12H3z', plus: 'M12 5v14M5 12h14',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17m10-10 1.4-1.4',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M16 16l5 5',
  previous: 'M6 5v14M19 5 9 12l10 7z', next: 'M18 5v14M5 5l10 7L5 19z',
  back: 'M9 4 4 8l5 4M5 8h8a7 7 0 1 1-6.2 10.2', forward: 'M15 4l5 4-5 4M19 8h-8a7 7 0 1 0 6.2 10.2',
  volume: 'M3 10h4l5-4v12l-5-4H3zM16 9a5 5 0 0 1 0 6M19 6a9 9 0 0 1 0 12',
  muted: 'M3 10h4l5-4v12l-5-4H3zM17 9l5 6M22 9l-5 6',
  fullscreen: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  close: 'm6 6 12 12M18 6 6 18', film: 'M4 3h16v18H4zM4 8h16M4 16h16M8 3v18M16 3v18',
  external: 'M14 3h7v7M21 3 10 14M10 3H3v18h18v-7',
  refresh: 'M20 7v5h-5M4 17v-5h5M19 7a8 8 0 0 0-14-1M5 17a8 8 0 0 0 14 1',
  subtitle: 'M3 5h18v14H3zM6 10h5m2 0h5M6 14h8m2 0h2',
  check: 'm5 12 4 4L19 6', chevron: 'm8 5 7 7-7 7',
};
</script>
<template>
  <svg :width="size || 20" :height="size || 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name] || paths.film" />
  </svg>
</template>
