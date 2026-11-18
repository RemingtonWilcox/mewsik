// Minimal posix `path` for the web bundle.
export const sep = '/';
export function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}
export const resolve = join;
export function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? '';
}
export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? (i === 0 ? '/' : '.') : p.slice(0, i);
}
export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}
export default { sep, join, resolve, basename, dirname, extname };
