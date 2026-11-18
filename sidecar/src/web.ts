// The online providers built for the app's web view (iPhone), where the Node
// sidecar cannot run. sources/web_providers.rs sends `providers:request`
// events; the page (src/lib/providers-bridge.ts) loads this bundle on the
// first one and hands each request to `window.__mewsikProviders.call`.

import { Platform } from 'youtubei.js/web';
import { invoke, nativeFetch } from './web/native-fetch.js';
import { YouTubeProvider } from './providers/youtube.js';
import { SoundCloudProvider } from './providers/soundcloud.js';
import { BandcampProvider } from './providers/bandcamp.js';
import { callProvider } from './rpc.js';

// YouTube's signature and `n` functions must be evaluated, and the page's
// content security policy forbids eval, so the app evaluates them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Platform.shim as any).eval = (data: { output: string }) =>
  invoke('providers_eval', { code: data.output });

const soundcloud = new SoundCloudProvider();
soundcloud.useInlineHls();

const providers = {
  youtube: new YouTubeProvider(nativeFetch),
  soundcloud,
  bandcamp: new BandcampProvider(),
};

(globalThis as unknown as { __mewsikProviders: unknown }).__mewsikProviders = {
  call: (method: string, params?: Record<string, unknown>) =>
    callProvider(providers, method, params),
};
