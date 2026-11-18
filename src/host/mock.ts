import type { HostAdapter, InstanceOpenRequest } from './contracts';
import { createPlaybackStorage } from '../domain/storage';

export const DEMO_PATHS = ['/demo/Alpine light.mp4', '/demo/Coastline.mov', '/demo/City after hours.mkv'];

export function createMockHost(): HostAdapter & { openedRequests: InstanceOpenRequest[] } {
  const store = createPlaybackStorage();
  const openedRequests: InstanceOpenRequest[] = [];
  let listener: ((files: { path: string }[]) => void) | null = null;
  return {
    kind: 'browser', instanceId: 'browser-demo', activity: 'active', isTauri: false, clipboardAvailable: false,
    openedRequests,
    async pickFiles() { return [...DEMO_PATHS]; },
    async pickSubtitle() { return null; },
    async openInstances(request) {
      openedRequests.push({ files: [...request.files], reuse: request.reuse });
      if (request.files[0]) listener?.([{ path: request.files[0] }]);
      return request.files.map((_, index) => `demo-${index}`);
    },
    lastOpenedFile() { return null; },
    async listenFiles(handler) { listener = handler; return () => { listener = null; }; },
    async listenDrop() { return () => {}; },
    listenActivity() { return () => {}; },
    beforeClose() { return () => {}; },
    loadPlayback: (id, path) => store.load(id, path),
    savePlayback: (id, path, state) => store.save(id, path, state),
    async readTextFile() { return 'WEBVTT\n\n00:00:03.000 --> 00:00:09.000\nA little space to slow down.\n'; },
    toast() {},
  };
}
