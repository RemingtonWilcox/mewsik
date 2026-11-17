// Node's `url` for the web bundle: the WHATWG classes are the same.
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export function fileURLToPath(url: string | URL): string {
  return decodeURIComponent(new globalThis.URL(String(url)).pathname);
}
export default { URL, URLSearchParams, fileURLToPath };
