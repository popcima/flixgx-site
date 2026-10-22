export function chooseSubtitle(tracks, preference) {
  if (preference === 'off') return -1;
  if (preference && typeof preference === 'object') {
    const exact = tracks.findIndex(t => t.language === preference.language && t.name === preference.name);
    if (exact >= 0) return exact;
    const language = tracks.findIndex(t => t.language === preference.language && !t.forced);
    return language; // Keep unavailable preferences off instead of switching languages.
  }
  const english = tracks.findIndex(t => /^(en|eng)(-|$)/i.test(t.language || '') && !t.forced);
  if (english >= 0) return english;
  return tracks.findIndex(t => t.default && !t.forced);
}
export function readPreference(storage) {
  try { return JSON.parse(storage.getItem('subtitle-preference')); } catch { return null; }
}
export function savePreference(storage, track) {
  try { storage.setItem('subtitle-preference', JSON.stringify(track ? { language: track.language, name: track.name } : 'off')); } catch { /* Playback works without storage. */ }
}
