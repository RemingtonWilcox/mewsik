// Stands in for `undici` in the web bundle (soundcloud-fetch and cheerio
// import its fetch).
export { nativeFetch as fetch } from './native-fetch.js';
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export const FormData = globalThis.FormData;
