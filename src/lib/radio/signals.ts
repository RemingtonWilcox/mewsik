import type { RadioBrowserStation, RadioStationSort } from '$lib/api/tauri';

export const DIRECTORY_SORT_OPTIONS: ReadonlyArray<{
	value: RadioStationSort;
	label: string;
	title: string;
}> = [
	{ value: 'smart', label: 'Smart order', title: 'Balanced quality and momentum' },
	{ value: 'popular', label: 'Popular · 24h', title: 'Most directory starts in the last 24 hours' },
	{ value: 'rising', label: 'Rising now', title: 'Biggest start increase versus yesterday' },
	{ value: 'loved', label: 'Most voted', title: 'Most community votes over time' },
	{ value: 'quality', label: 'High bitrate', title: 'Highest reported stream bitrate' }
];

const compactNumber = new Intl.NumberFormat('en', {
	notation: 'compact',
	maximumFractionDigits: 1
});

function finiteMetric(value: number | null | undefined): number {
	return Number.isFinite(value) ? Number(value) : 0;
}

export function formatStationMetric(value: number | null | undefined): string {
	return compactNumber.format(Math.max(0, finiteMetric(value)));
}

export function isDirectoryCheckFresh(
	station: Pick<RadioBrowserStation, 'lastchecktime_iso8601'>,
	now = Date.now(),
	maxAgeMs = 48 * 60 * 60 * 1_000
): boolean {
	if (!station.lastchecktime_iso8601) return false;
	const checkedAt = Date.parse(station.lastchecktime_iso8601);
	return Number.isFinite(checkedAt) && now >= checkedAt && now - checkedAt <= maxAgeMs;
}

export function formatDirectoryCheckAge(
	station: Pick<RadioBrowserStation, 'lastchecktime_iso8601'>,
	now = Date.now()
): string | null {
	if (!station.lastchecktime_iso8601) return null;
	const checkedAt = Date.parse(station.lastchecktime_iso8601);
	if (!Number.isFinite(checkedAt)) return null;
	const ageMs = Math.max(0, now - checkedAt);
	const minutes = Math.floor(ageMs / 60_000);
	if (minutes < 1) return 'checked just now';
	if (minutes < 60) return `checked ${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `checked ${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 60) return `check ${days}d old`;
	const months = Math.floor(days / 30);
	return `check ${months}mo old`;
}

function smartScore(station: RadioBrowserStation): number {
	const starts = finiteMetric(station.clickcount);
	const votes = finiteMetric(station.votes);
	const trend = finiteMetric(station.clicktrend);
	const bitrate = Math.min(384, Math.max(0, finiteMetric(station.bitrate)));
	const recentOnline = station.lastcheckok === 1 && isDirectoryCheckFresh(station) ? 1 : 0;

	return (
		Math.log1p(starts) * 4.4 +
		Math.log1p(votes) * 1.5 +
		Math.max(-250, Math.min(250, trend)) * 0.012 +
		bitrate / 160 +
		recentOnline * 1.25
	);
}

function sortMetric(station: RadioBrowserStation, sort: RadioStationSort): number {
	switch (sort) {
		case 'popular': return finiteMetric(station.clickcount);
		case 'rising': return finiteMetric(station.clicktrend);
		case 'loved': return finiteMetric(station.votes);
		case 'quality': return finiteMetric(station.bitrate);
		default: return smartScore(station);
	}
}

export function sortRadioStations(
	stations: RadioBrowserStation[],
	sort: RadioStationSort
): RadioBrowserStation[] {
	return [...stations].sort((left, right) => {
		const primary = sortMetric(right, sort) - sortMetric(left, sort);
		if (primary !== 0) return primary;
		const popularity = finiteMetric(right.clickcount) - finiteMetric(left.clickcount);
		if (popularity !== 0) return popularity;
		return left.name.localeCompare(right.name);
	});
}
