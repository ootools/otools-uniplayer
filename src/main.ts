import { createApp } from 'vue';
import App from './App.vue';
import { createHostAdapter } from './host/adapter';
import { createMockHost } from './host/mock';
import { createMediaService } from './player/service';
import { createMockMediaService } from './player/mock-service';
import { installTheme } from './theme';
import './styles.css';

installTheme();
const params = new URLSearchParams(location.search);
const mock = params.get('mock') === '1' || !window.otools;
const host = mock ? createMockHost() : createHostAdapter();
const service = mock ? createMockMediaService({ quota: params.get('quota') === '1' }) : createMediaService(window.otools?.sidecar);
createApp(App, { host, service }).mount('#app');
