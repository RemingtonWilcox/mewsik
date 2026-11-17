// Runs the online providers (YouTube, SoundCloud, Bandcamp) in this page
// when the app cannot start its Node sidecar, which is always the case on
// iPhone. The app sends `providers:request` events (see
// src-tauri/src/sources/web_providers.rs); the provider bundle
// (/web-providers.js, built from sidecar/src/web.ts) loads on the first one.
// On the desktop no request ever arrives and nothing is loaded.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface ProviderRequest {
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

interface Providers {
	call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

let providers: Promise<Providers> | null = null;

function loadProviders(): Promise<Providers> {
	providers ??= new Promise<Providers>((resolve, reject) => {
		const script = document.createElement('script');
		script.src = '/web-providers.js';
		script.onload = () => {
			const loaded = (window as unknown as { __mewsikProviders?: Providers }).__mewsikProviders;
			if (loaded) resolve(loaded);
			else reject(new Error('Online search did not load'));
		};
		script.onerror = () => reject(new Error('Online search could not be loaded'));
		document.head.appendChild(script);
	}).catch((error) => {
		providers = null;
		throw error;
	});
	return providers;
}

async function answer({ id, method, params }: ProviderRequest) {
	try {
		const result = await (await loadProviders()).call(method, params);
		await invoke('providers_reply', { id, result: result ?? null, error: null });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await invoke('providers_reply', { id, result: null, error: message });
	}
}

let started = false;

export function startProvidersBridge() {
	if (started) return;
	started = true;
	void listen<ProviderRequest>('providers:request', (event) => void answer(event.payload)).catch(
		() => {
			started = false;
		}
	);
}
