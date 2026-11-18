// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';
import { createMockHost } from './host/mock';
import { createMockMediaService } from './player/mock-service';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('UniPlayer primary user flows', () => {
  it('opens demo files into a visible queue and exposes global timeline and playback controls', async () => {
    const host = createMockHost();
    const wrapper = mount(App, { props: { host, service: createMockMediaService(), initialLocale: 'en' } });
    expect(wrapper.text()).toContain('Your next frame awaits');
    await wrapper.get('[data-testid="demo-open"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Alpine light');
    expect(wrapper.get('[data-testid="timeline"]').attributes('max')).toBe('192');
    expect(wrapper.get('[data-testid="play-toggle"]').attributes('aria-label')).toBe('Pause');
    await wrapper.get('[data-testid="play-toggle"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="play-toggle"]').attributes('aria-label')).toBe('Play');
    await wrapper.get('[data-testid="settings-toggle"]').trigger('click');
    expect(wrapper.text()).toContain('Allow parallel playback');
    wrapper.unmount();
  });
  it('routes all multi-picked paths through document instances without loading a second local file', async () => {
    const host = createMockHost();
    const wrapper = mount(App, { props: { host, service: createMockMediaService(), initialLocale: 'en' } });
    await wrapper.get('[data-testid="open-files"]').trigger('click');
    await flushPromises();
    expect(host.openedRequests[0]).toEqual({ files: ['/demo/Alpine light.mp4', '/demo/Coastline.mov', '/demo/City after hours.mkv'], reuse: 'document' });
    expect(wrapper.find('video').exists()).toBe(true);
    expect(wrapper.text()).toContain('Alpine light');
    wrapper.unmount();
  });
  it('waits for host activity before loading an inactive restored file', async () => {
    const host = createMockHost();
    let onActivity: ((active: boolean) => void) | undefined;
    Object.defineProperty(host, 'activity', { get: () => 'inactive' });
    host.lastOpenedFile = () => '/demo/Alpine light.mp4';
    host.listenActivity = handler => { onActivity = handler; return () => {}; };
    const service = createMockMediaService();
    const create = vi.spyOn(service, 'create');
    const wrapper = mount(App, { props: { host, service, initialLocale: 'en' } });
    await flushPromises();
    expect(create).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Alpine light');
    onActivity?.(true);
    await flushPromises();
    expect(create).toHaveBeenCalledOnce();
    expect(wrapper.find('[data-testid="timeline"]').exists()).toBe(true);
    wrapper.unmount();
  });
  it('shows the eight-service quota without automatic retry loops', async () => {
    const host = createMockHost();
    const service = createMockMediaService({ quota: true });
    const wrapper = mount(App, { props: { host, service, initialLocale: 'en' } });
    await wrapper.get('[data-testid="demo-open"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('All 8 playback slots are in use');
    expect(wrapper.get('[data-testid="retry"]').text()).toBe('Try again');
    wrapper.unmount();
  });
});
