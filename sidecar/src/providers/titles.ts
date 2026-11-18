// YouTube video names carry the artist and video noise in the title:
// "Travis Scott - SICKO MODE (Official Video) ft. Drake" from the channel
// "TravisScottVEVO". A music app wants "SICKO MODE ft. Drake" by
// "Travis Scott".

const NOISE = new RegExp(
  String.raw`\s*[\(\[][^\)\]]*\b(?:official|lyrics?|lyric video|audio|video|visuali[sz]er|hd|hq|4k|mv|m\/v|explicit|clean)\b[^\)\]]*[\)\]]`,
  'gi'
);
const TRAILING = /\s*(?:\|.*|\/\/.*|-\s*official.*|official\s+(?:music\s+)?video.*)$/i;

function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The artist behind a channel name: "TravisScottVEVO", "Drake - Topic". */
export function tidyChannel(channel: string): string {
  return channel
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s*Official$/i, '')
    .trim() || channel;
}

export function tidyVideoTitle(rawTitle: string, rawChannel: string): { title: string; artist: string } {
  let artist = tidyChannel(rawChannel);
  let title = rawTitle.replace(NOISE, '').replace(TRAILING, '').replace(/\s{2,}/g, ' ').trim();

  // "Artist - Song": the left side is the artist when it matches the
  // channel, or when the channel is an uploader (a lyrics or label channel)
  // that the title doesn't mention. "Song - Remix" on the artist's own
  // channel stays whole.
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) {
    const [, left, right] = dash;
    const channelKey = squash(artist);
    const leftKey = squash(left);
    const leftIsChannel =
      leftKey.length > 0 && channelKey.length > 0 && (channelKey.includes(leftKey) || leftKey.includes(channelKey));
    const channelIsUploader =
      (channelKey.length === 0 || !squash(rawTitle).includes(channelKey)) &&
      !/\b(?:remix|edit|version|mix|live|acoustic|instrumental|sped up|slowed|reverb)\b/i.test(right);
    if (leftIsChannel || channelIsUploader) {
      artist = left.trim();
      title = right.trim();
    }
  }

  title = title.replace(/^["“']+|["”']+$/g, '').trim();
  return { title: title || rawTitle, artist: artist || rawChannel };
}
