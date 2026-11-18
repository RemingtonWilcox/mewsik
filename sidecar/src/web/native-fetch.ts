// `fetch` for the in-app providers. The web view's own fetch is bound by
// cross-origin rules and drops headers such as Cookie and Origin, so every
// request goes through the app (`native_fetch` in sources/web_providers.rs).
// The web bundle substitutes this for the global fetch and for undici's.

interface TauriInternals {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

interface NativeResponse {
  status: number;
  status_text: string;
  url: string;
  headers: [string, string][];
  body: string;
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (globalThis as unknown as { __TAURI_INTERNALS__?: TauriInternals })
    .__TAURI_INTERNALS__;
  if (!internals) throw new Error('The app bridge is not available');
  return internals.invoke<T>(cmd, args);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function bodyBytes(body: unknown, headers: Headers): Promise<Uint8Array | null> {
  if (body == null) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof URLSearchParams) {
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    }
    return new TextEncoder().encode(body.toString());
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  // FormData and streams: let the browser serialise them.
  const encoded = new Response(body as BodyInit);
  const type = encoded.headers.get('content-type');
  if (type && !headers.has('content-type')) headers.set('content-type', type);
  return new Uint8Array(await encoded.arrayBuffer());
}

const NULL_BODY_STATUS = new Set([204, 205, 304]);

function aborted(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export async function nativeFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  let url: string;
  let method = init.method;
  // A plain `new Headers()` (unlike a Request's) keeps every header name.
  const headers = new Headers();
  let body: unknown = init.body;
  if (input instanceof Request) {
    url = input.url;
    method ??= input.method;
    input.headers.forEach((value, key) => headers.set(key, value));
    if (body == null && input.method !== 'GET' && input.method !== 'HEAD') {
      body = await input.clone().arrayBuffer();
    }
  } else {
    url = input instanceof URL ? input.href : String(input);
  }
  new Headers(init.headers ?? {}).forEach((value, key) => headers.set(key, value));
  if (init.signal?.aborted) throw aborted();

  const bytes = await bodyBytes(body, headers);
  const pairs: [string, string][] = [];
  headers.forEach((value, key) => pairs.push([key, value]));

  const response = await invoke<NativeResponse>('native_fetch', {
    request: {
      url,
      method: (method ?? 'GET').toUpperCase(),
      headers: pairs,
      body: bytes ? toBase64(bytes) : null,
    },
  });
  if (init.signal?.aborted) throw aborted();

  const responseHeaders = new Headers();
  for (const [key, value] of response.headers) responseHeaders.append(key, value);
  const status = response.status < 200 || response.status > 599 ? 502 : response.status;
  const result = new Response(
    NULL_BODY_STATUS.has(status) ? null : (fromBase64(response.body) as BodyInit),
    { status, statusText: response.status_text },
  );
  // A constructed Response has an empty url and hides Set-Cookie; the
  // providers read both.
  Object.defineProperty(result, 'url', { value: response.url });
  Object.defineProperty(result, 'headers', { value: responseHeaders });
  Object.defineProperty(result, 'redirected', { value: response.url !== url });
  return result;
}

export { nativeFetch as fetch };
