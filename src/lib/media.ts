import { convertFileSrc } from '@tauri-apps/api/core';
import type { LibraryTrack } from '$lib/types';

function hasTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** An image URL the webview can load, from a local cover path or a web URL. */
export function coverSrc(pathOrUrl: string | null | undefined): string | null {
	if (!pathOrUrl) return null;
	if (/^(https?:|data:|asset:|blob:)/i.test(pathOrUrl)) return pathOrUrl;
	if (!hasTauri()) return null;
	try {
		return convertFileSrc(pathOrUrl);
	} catch {
		return null;
	}
}

export function trackCover(track: Pick<LibraryTrack, 'cover_art_path' | 'cover_art_url'>) {
	return coverSrc(track.cover_art_path || track.cover_art_url);
}

export function formatDuration(ms: number | null | undefined): string {
	if (!ms || ms < 0) return '';
	const total = Math.round(ms / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const ss = seconds.toString().padStart(2, '0');
	return hours > 0 ? `${hours}:${minutes.toString().padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** "3 hr 12 min" / "42 min" for a list of tracks. */
export function formatTotal(ms: number): string {
	const minutes = Math.round(ms / 60000);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	return `${hours} hr ${minutes % 60} min`;
}

/** A shuffled copy (Fisher–Yates). */
export function shuffled<T>(items: T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Case- and accent-insensitive text for filtering. */
export function fold(text: string | null | undefined): string {
	return (text ?? '')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase();
}

export function plural(count: number, word: string): string {
	return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
}
