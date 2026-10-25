import { chooseSubtitle, readPreference, savePreference } from './subtitle-preferences.js';

const $ = id => document.getElementById(`stream-${id}`);
const overlay = document.getElementById('fp-overlay'), video = document.getElementById('fp-video');
let hls, generation = 0, episodeRequest = 0, controller, currentTitle, returnFocus, previousOverflow;
let prepared = null, playRequestedAt = 0, sessionRecoveryAvailable = true;
let startupQualityInstance = null;
let sourceSubtitles = [], subtitleTracks = [], nativeActive = false, preference = null, background = [];
try { preference = readPreference(localStorage); } catch { /* Private browsing may disable storage. */ }
const options = (element, values) => element.replaceChildren(...values.map(([value, label]) => {
  const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
}));
let hideTimer, buffering = false, playbackError = false, openMenu = null;
let hoveringChrome = false, keyboardFocus = false, lastFullscreenExit = 0, dismissVideoClick = false;
const bottomChrome = overlay.querySelector('.stream-bottom');
const formatTime = seconds => {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(whole / 3600), minutes = Math.floor(whole % 3600 / 60), remainder = whole % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(remainder).padStart(2, '0')}`;
};
const isOpen = () => overlay.classList.contains('open');
const captionLines = new WeakMap(), watchedTracks = new WeakSet();
const nativeCaptionOffset = window.CSS?.supports?.('selector(video::-webkit-media-text-track-container)');
function positionCaptions() {
  overlay.style.setProperty('--caption-lift', `${Math.max(0, bottomChrome.offsetHeight - 8)}px`);
  const hiddenChrome = overlay.classList.contains('controls-hidden') || overlay.classList.contains('is-native-fullscreen') || overlay.classList.contains('is-pip');
  const line = hiddenChrome ? -2 : -5;
  for (const track of video.textTracks) for (const cue of track.activeCues || []) {
    if (!captionLines.has(cue)) captionLines.set(cue, cue.line);
    const original = captionLines.get(cue);
    if (original === 'auto' || (typeof original === 'number' && original < 0)) cue.line = nativeCaptionOffset ? original : line;
  }
}
function watchCaptions() {
  for (const track of video.textTracks) {
    if (watchedTracks.has(track)) continue;
    watchedTracks.add(track); track.addEventListener('cuechange', positionCaptions);
  }
  positionCaptions();
}
video.textTracks.addEventListener('addtrack', watchCaptions);
function canHideChrome() {
  return isOpen() && !video.paused && !video.ended && !buffering && !playbackError && !openMenu && !hoveringChrome && !(keyboardFocus && overlay.contains(document.activeElement));
}
function scheduleHide() {
  clearTimeout(hideTimer);
  if (canHideChrome()) hideTimer = setTimeout(() => {
    if (canHideChrome()) { overlay.classList.add('controls-hidden'); positionCaptions(); }
  }, 3000);
}
function showChrome() { overlay.classList.remove('controls-hidden'); positionCaptions(); scheduleHide(); }
function setBuffering(value) {
  buffering = value; $('spinner').hidden = !value; if (value) showChrome(); else scheduleHide();
}
function announce(message) { $('announcement').textContent = message; }
function status(message, retry = false) {
  const loading = /^(Finding|Loading|Buffering)/.test(message), ready = message.startsWith('Ready.');
  playbackError = retry;
  $('status').textContent = message; $('retry').hidden = !retry; $('start').hidden = !ready;
  $('message').hidden = !(retry || ready);
  setBuffering(loading); announce(message);
  if (retry || ready) showChrome();
  updateMediaControls();
}
function closeMenus({ restoreFocus = false } = {}) {
  if (!openMenu) return;
  const name = openMenu; $(name + '-menu').hidden = true; $(name + '-toggle').setAttribute('aria-expanded', 'false'); openMenu = null;
  if (restoreFocus) $(name + '-toggle').focus();
  scheduleHide();
}
function positionEpisodesMenu() {
  if (openMenu !== 'episodes') return;
  const trigger = $('episodes-toggle').getBoundingClientRect(), bounds = overlay.getBoundingClientRect();
  const top = trigger.bottom - bounds.top + 8;
  const panel = $('episodes-menu');
  panel.style.setProperty('--episodes-top', `${top}px`);
  panel.style.setProperty('--episodes-right', `${Math.max(12, bounds.right - trigger.right)}px`);
  panel.style.setProperty('--episodes-height', `${Math.max(100, bounds.height - top - bottomChrome.offsetHeight - 10)}px`);
}
function toggleMenu(name) {
  const opening = openMenu !== name; closeMenus();
  if (opening) {
    openMenu = name; $(name + '-menu').hidden = false; $(name + '-toggle').setAttribute('aria-expanded', 'true'); showChrome();
    if (name === 'episodes') positionEpisodesMenu();
    if (keyboardFocus) $(name + '-menu').querySelector('select:not(:disabled),button:not(:disabled),a[href]')?.focus();
  }
}
function updateMediaControls() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  $('seek').disabled = !duration;
  $('seek').max = duration;
  if (document.activeElement !== $('seek') || !overlay.classList.contains('is-seeking')) $('seek').value = video.currentTime || 0;
  $('seek').setAttribute('aria-valuetext', `${formatTime(video.currentTime)} of ${formatTime(duration)}`);
  $('played').style.width = `${duration ? Math.min(100, video.currentTime / duration * 100) : 0}%`;
  $('time').textContent = `${formatTime(video.currentTime)} / ${formatTime(duration)}`;
  overlay.classList.toggle('is-playing', !video.paused && !video.ended);
  $('play').setAttribute('aria-label', video.paused ? 'Play' : 'Pause'); $('play').title = video.paused ? 'Play' : 'Pause';
  $('play').disabled = !video.getAttribute('src') || playbackError;
  $('backward').disabled = $('forward').disabled = !duration;
  $('pip').disabled = video.readyState < 2 || playbackError;
}
function updateBuffered() {
  const duration = video.duration, spans = [];
  if (Number.isFinite(duration) && duration > 0) for (let i = 0; i < video.buffered.length; i++) {
    const span = document.createElement('span');
    span.style.left = `${video.buffered.start(i) / duration * 100}%`;
    span.style.width = `${(video.buffered.end(i) - video.buffered.start(i)) / duration * 100}%`; spans.push(span);
  }
  $('buffered').replaceChildren(...spans);
}
function updateVolume() {
  const level = video.muted ? 0 : video.volume;
  $('volume').value = level; $('volume').style.setProperty('--volume', `${level * 100}%`);
  $('volume').setAttribute('aria-valuetext', `${Math.round(level * 100)} percent`);
  overlay.classList.toggle('is-muted', !level);
  $('mute').setAttribute('aria-label', level ? 'Mute' : 'Unmute'); $('mute').title = level ? 'Mute' : 'Unmute';
}
function togglePlayback() {
  if ($('play').disabled) return;
  if (video.paused) video.play().catch(() => status('Ready. Press Play video to start.'));
  else video.pause();
  showChrome();
}
function seekBy(delta) {
  if (!Number.isFinite(video.duration)) return;
  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + delta)); updateMediaControls(); showChrome();
}
function toggleMute() { if (!video.volume) video.volume = 1; video.muted = !video.muted; updateVolume(); showChrome(); }
function fullscreenActive() { return document.fullscreenElement === overlay || Boolean(video.webkitDisplayingFullscreen); }
function updateFullscreen() {
  const full = fullscreenActive();
  if (!full && overlay.classList.contains('is-fullscreen')) lastFullscreenExit = performance.now();
  overlay.classList.toggle('is-fullscreen', full);
  overlay.classList.toggle('is-native-fullscreen', Boolean(video.webkitDisplayingFullscreen));
  $('fullscreen').setAttribute('aria-label', full ? 'Exit fullscreen' : 'Enter fullscreen'); $('fullscreen').title = full ? 'Exit fullscreen' : 'Enter fullscreen'; showChrome();
}
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (video.webkitDisplayingFullscreen) video.webkitExitFullscreen();
    else if (overlay.requestFullscreen) await overlay.requestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    else announce('Fullscreen is unavailable in this browser.');
  } catch { announce('Fullscreen could not start. Try the fullscreen button again.'); }
}
async function togglePip() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (video.requestPictureInPicture) await video.requestPictureInPicture();
    else if (video.webkitSetPresentationMode) video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
  } catch { announce('Picture in picture is unavailable for this video.'); }
}
function detectPip() {
  $('pip').hidden = !(document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') && !(video.webkitSupportsPresentationMode?.('picture-in-picture'));
}
$('cast').addEventListener('click', async () => {
  try {
    if (video.webkitShowPlaybackTargetPicker) video.webkitShowPlaybackTargetPicker();
    else if (video.remote) await video.remote.prompt();
  } catch { announce('No compatible screen is available.'); }
});
if (video.remote?.watchAvailability) video.remote.watchAvailability(available => { $('cast').hidden = !available; }).catch(() => {});
video.addEventListener('webkitplaybacktargetavailabilitychanged', event => { $('cast').hidden = event.availability !== 'available'; });
$('play').addEventListener('click', togglePlayback);
$('start').addEventListener('click', togglePlayback);
$('backward').addEventListener('click', () => seekBy(-10));
$('forward').addEventListener('click', () => seekBy(10));
$('mute').addEventListener('click', toggleMute);
$('volume').addEventListener('input', () => { video.volume = Number($('volume').value); video.muted = video.volume === 0; updateVolume(); });
$('seek').addEventListener('pointerdown', () => overlay.classList.add('is-seeking'));
$('seek').addEventListener('input', () => { if (Number.isFinite(video.duration)) video.currentTime = Number($('seek').value); updateMediaControls(); showChrome(); });
$('seek').addEventListener('change', () => overlay.classList.remove('is-seeking'));
$('seek').addEventListener('pointerup', () => overlay.classList.remove('is-seeking'));
$('speed').addEventListener('change', () => { video.playbackRate = Number($('speed').value); });
$('subtitle-toggle').addEventListener('click', () => toggleMenu('subtitle'));
$('settings-toggle').addEventListener('click', () => toggleMenu('settings'));
$('episodes-toggle').addEventListener('click', () => toggleMenu('episodes'));
$('fullscreen').addEventListener('click', toggleFullscreen);
$('pip').addEventListener('click', togglePip);
video.addEventListener('click', () => {
  closeMenus();
  if (dismissVideoClick) { dismissVideoClick = false; showChrome(); return; }
  togglePlayback();
});
video.addEventListener('dblclick', event => { event.preventDefault(); void toggleFullscreen(); });
for (const eventName of ['timeupdate','durationchange','loadedmetadata','canplay','play','pause','ended','emptied']) video.addEventListener(eventName, updateMediaControls);
for (const eventName of ['progress','durationchange','loadedmetadata','emptied']) video.addEventListener(eventName, updateBuffered);
video.addEventListener('volumechange', updateVolume);
video.addEventListener('loadedmetadata', detectPip);
video.addEventListener('ratechange', () => { $('speed').value = String(video.playbackRate); });
video.addEventListener('seeked', () => { if (video.readyState >= 3) setBuffering(false); });
video.addEventListener('canplay', () => { if (!playbackError) setBuffering(false); });
document.addEventListener('fullscreenchange', updateFullscreen);
video.addEventListener('webkitbeginfullscreen', updateFullscreen);
video.addEventListener('webkitendfullscreen', updateFullscreen);
function updatePip() {
  overlay.classList.toggle('is-pip', document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture');
  positionCaptions();
}
video.addEventListener('enterpictureinpicture', updatePip);
video.addEventListener('leavepictureinpicture', updatePip);
video.addEventListener('webkitpresentationmodechanged', updatePip);
new ResizeObserver(positionCaptions).observe(bottomChrome);
new ResizeObserver(positionEpisodesMenu).observe(overlay);
overlay.addEventListener('pointermove', showChrome);
overlay.addEventListener('pointerdown', event => {
  dismissVideoClick = event.target === video && (Boolean(openMenu) || (event.pointerType === 'touch' && overlay.classList.contains('controls-hidden')));
  keyboardFocus = false; showChrome();
  if (openMenu && !event.target.closest('.stream-menu') && !event.target.closest('[aria-controls]')) closeMenus();
});
for (const chrome of overlay.querySelectorAll('.stream-chrome')) {
  chrome.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') { hoveringChrome = true; showChrome(); } });
  chrome.addEventListener('pointerleave', () => { hoveringChrome = false; scheduleHide(); });
}
overlay.addEventListener('focusin', () => { if (keyboardFocus) showChrome(); });
overlay.addEventListener('focusout', () => queueMicrotask(scheduleHide));
document.addEventListener('keydown', event => {
  if (!isOpen()) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopImmediatePropagation();
    if (openMenu) closeMenus({ restoreFocus: true });
    else if (fullscreenActive()) void toggleFullscreen();
    else if (performance.now() - lastFullscreenExit > 350) window.closePlayer();
    return;
  }
  if (event.key === 'Tab') {
    keyboardFocus = true; showChrome(); event.stopPropagation();
    const items = Array.from(overlay.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href]')).filter(el => el.getClientRects().length);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === overlay)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    return;
  }
  // Inputs keep their native keyboard behavior; all player keystrokes stay out of the catalog.
  event.stopPropagation();
  if (event.target.matches('input,select,textarea') || event.target.isContentEditable || event.altKey || event.ctrlKey || event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === ' ' && event.target.matches('button,a')) return;
  if (![' ','k','m','f','arrowleft','arrowright','arrowup','arrowdown'].includes(key)) return;
  event.preventDefault();
  if (key === ' ' || key === 'k') togglePlayback();
  else if (key === 'm') toggleMute();
  else if (key === 'f') void toggleFullscreen();
  else if (key === 'arrowleft' || key === 'arrowright') seekBy(key === 'arrowleft' ? -10 : 10);
  else { video.volume = Math.max(0, Math.min(1, video.volume + (key === 'arrowup' ? .05 : -.05))); video.muted = video.volume === 0; updateVolume(); showChrome(); }
}, true);
detectPip(); updateVolume(); updateMediaControls();

function resetMedia() {
  clearPreparation();
  startupQualityInstance = null; delete overlay.dataset.qualityPhase;
  currentTitle = null; closeMenus(); clearTimeout(hideTimer); setBuffering(false); playbackError = false;
  $('message').hidden = true; $('episodes-toggle').hidden = true; overlay.classList.remove('controls-hidden', 'is-seeking');
  controller?.abort(); controller = null; nativeActive = false;
  hls?.destroy(); hls = null; video.pause(); video.removeAttribute('src'); video.load();
  sourceSubtitles = []; subtitleTracks = []; updateBuffered(); updateMediaControls();
  for (const [id, value, label] of [['quality', -1, 'Auto'], ['audio', 0, 'Default'], ['subtitles', -1, 'Off']]) {
    options($(id), [[value, label]]); $(id).disabled = true;
  }
  $('download').hidden = true; $('download').removeAttribute('href');
  $('subtitle-status').textContent = 'Looking for subtitles…';
}
function subtitleSelection(index, loading = false) {
  $('subtitles').value = String(index);
  const track = subtitleTracks[index];
  $('subtitle-status').textContent = track ? `${track.name || track.language} subtitles${loading ? ' · loading…' : ' enabled'}` : subtitleTracks.length ? 'Subtitles are off.' : 'No subtitles are available for this title.';
  const source = track && sourceSubtitles.find(s => s.playlistUrl === track.url || (s.language === track.language && s.name === track.name));
  $('download').hidden = !source?.vttUrl;
  if (source?.vttUrl) $('download').href = `${source.vttUrl}?download=1`;
  else $('download').removeAttribute('href');
}
function populateSubtitles(tracks) {
  subtitleTracks = tracks;
  options($('subtitles'), [[-1, 'Off'], ...tracks.map((t, i) => [i, t.name || t.language || `Subtitle ${i + 1}`])]);
  $('subtitles').disabled = !tracks.length;
  return chooseSubtitle(tracks, preference);
}
const nativeTracks = () => Array.from(video.textTracks).filter(t => ['subtitles', 'captions'].includes(t.kind));
function syncNativeSubtitles() {
  if (!nativeActive) return;
  const tracks = nativeTracks(), index = populateSubtitles(tracks.map(t => ({ name: t.label, language: t.language })));
  tracks.forEach((t, i) => { t.mode = i === index ? 'showing' : 'disabled'; });
  subtitleSelection(index);
}
video.textTracks.addEventListener('addtrack', syncNativeSubtitles);
video.addEventListener('loadedmetadata', syncNativeSubtitles);
video.textTracks.addEventListener('change', () => { if (nativeActive) subtitleSelection(nativeTracks().findIndex(t => t.mode === 'showing')); });

async function episodesFor(title, season) {
  if (title.season === season && title.episodes?.length) return title.episodes;
  if (typeof window.tmdb !== 'function') throw new Error('Episode details are unavailable. Reopen this series from the catalog.');
  const data = await window.tmdb(`/tv/${title.id}/season/${season}`);
  if (!Array.isArray(data.episodes) || !data.episodes.length) throw new Error('No episodes are available for this season.');
  return data.episodes;
}
async function setupEpisodes(title, current) {
  $('episodes-toggle').hidden = $('episodes').hidden = title.mediaType !== 'tv';
  if (title.mediaType !== 'tv') return;
  const seasons = (title.seasons || []).filter(s => s.season_number > 0 || s.season_number === title.season);
  if (!seasons.some(s => s.season_number === title.season)) seasons.push({ season_number: title.season, name: `Season ${title.season}` });
  options($('season'), seasons.map(s => [s.season_number, s.name || `Season ${s.season_number}`]));
  $('season').value = title.season; $('season').disabled = false;
  options($('episode'), [[title.episode, title.episodeName || `Episode ${title.episode}`]]);
  $('episode').disabled = true; $('next').disabled = true;
  try {
    const episodes = await episodesFor(title, title.season);
    if (generation !== current) return;
    currentTitle.episodes = episodes;
    options($('episode'), episodes.map(e => [e.episode_number, `E${e.episode_number} · ${e.name || 'Episode'}`]));
    $('episode').value = title.episode; $('episode').disabled = false;
    $('next').disabled = !episodes.some(e => e.episode_number > title.episode);
  } catch { if (generation === current) $('episode').disabled = true; }
}
function playVideo(current, resumeAt = 0) {
  if (current !== generation || !isOpen()) return;
  if (resumeAt > 0) video.currentTime = resumeAt;
  video.play().catch(error => {
    if (current === generation && error.name !== 'AbortError') status('Ready. Press Play in the video to start.');
  });
}
function updateQualityLabel(instance, level = instance.currentLevel) {
  const auto = $('quality').querySelector('option[value="-1"]');
  if (auto) auto.textContent = instance.autoLevelEnabled && instance.levels[level]?.height
    ? `Auto (${instance.levels[level].height}p)` : 'Auto';
}

const normalizedTitle = metadata => ({ ...metadata,
  season: Number(metadata?.season ?? metadata?.seasons?.find(s => s.season_number > 0)?.season_number ?? 1),
  episode: Number(metadata?.episode ?? 1) });
const titleKey = title => `${title.mediaType}/${title.id}/${title.season}/${title.episode}`;
function clearPreparation() {
  if (prepared) { clearTimeout(prepared.expiryTimer); clearTimeout(prepared.loadTimer); }
  prepared = null; overlay.dataset.preloadState = 'idle';
}
window.cancelPreparedPlayer = function () {
  if (!prepared || isOpen()) return;
  generation++; resetMedia();
};
window.preparePlayer = function (metadata) {
  // Prepare only the selected title, never an entire catalog or autoplaying hero.
  if (isOpen() || !document.getElementById('modal-backdrop')?.classList.contains('open') ||
      !window.Hls?.isSupported() || navigator.connection?.saveData || /(^|-)2g$/.test(navigator.connection?.effectiveType || '')) return;
  const title = normalizedTitle(metadata), key = titleKey(title);
  if (!/^[1-9]\d{0,9}$/.test(String(title.id)) || !['movie', 'tv'].includes(title.mediaType)) return;
  if (prepared?.key === key && prepared.until > Date.now()) return;
  const current = ++generation; resetMedia();
  const entry = prepared = { key, current, until: Date.now() + 60000, ready: false };
  overlay.dataset.preloadState = 'loading';
  entry.expiryTimer = setTimeout(window.cancelPreparedPlayer, 60000);
  entry.loadTimer = setTimeout(window.cancelPreparedPlayer, 12000);
  entry.promise = loadMedia(title, current);
};
function stopPreparationAtBuffer() {
  if (!prepared || isOpen() || !video.buffered.length || video.readyState < 3) return;
  const seconds = video.buffered.end(0) - video.buffered.start(0);
  if (seconds < Math.min(4, video.duration || 4)) return;
  prepared.ready = true; clearTimeout(prepared.loadTimer);
  hls?.stopLoad(); overlay.dataset.preloadState = 'ready';
}
video.addEventListener('progress', stopPreparationAtBuffer);
video.addEventListener('canplay', stopPreparationAtBuffer);
// Also cancel a preparation when the catalog closes its modal by Escape or another control.
const catalogModal = document.getElementById('modal-backdrop');
if (catalogModal) new MutationObserver(() => {
  if (!catalogModal.classList.contains('open') && !isOpen()) window.cancelPreparedPlayer();
}).observe(catalogModal, { attributes: true, attributeFilter: ['class'] });

async function loadMedia(title, current, { refresh = false, resumeAt = 0 } = {}) {
  try {
    if (!/^[1-9]\d{0,9}$/.test(String(title.id)) || !['movie', 'tv'].includes(title.mediaType)) throw new Error('Could not load this title. Close the player and select it again.');
    const base = (window.FLIXGX_PLAYER?.apiBaseUrl || '').replace(/\/$/, '');
    const target = title.mediaType === 'tv' ? `tv/${title.id}/${title.season}/${title.episode}` : `movie/${title.id}`;
    controller = new AbortController();
    const response = await fetch(`${base}/api/playback/${target}${refresh ? '?refresh=1' : ''}`, { signal: controller.signal });
    if (!response.headers.get('content-type')?.includes('application/json')) {
      console.warn('FlixGX: configure a reachable playback backend in assets/player-config.js.');
      throw new Error('The video service is unavailable. Please try again later.');
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'This stream is unavailable. Try again shortly.');
    if (current !== generation) return;
    if (prepared?.current === current) prepared.until = Math.min(prepared.until, Date.parse(data.expiresAt) - 5000);
    const source = data.sources?.[0];
    if (!source?.playbackUrl) throw new Error('No playable stream was found for this title.');
    sourceSubtitles = source.subtitles || [];
    if (window.Hls?.isSupported()) {
      const preparing = prepared?.current === current;
      const instance = hls = new Hls({ startLevel: 0, testBandwidth: false,
        maxBufferLength: preparing ? 4 : 15, maxMaxBufferLength: preparing ? 8 : 30,
        renderTextTracksNatively: true });
      // Keep the first buffer small even if preparation finishes before Play.
      instance.autoLevelCapping = 0; startupQualityInstance = instance;
      overlay.dataset.qualityPhase = 'startup';
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        options($('quality'), [[-1, 'Auto'], ...instance.levels.map((level, i) => [i, `${level.height}p`])]);
        $('quality').disabled = instance.levels.length < 2;
        playVideo(current, resumeAt);
      });
      instance.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        if (current !== generation || hls !== instance) return;
        updateQualityLabel(instance, data.level);
      });
      instance.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_, data) => {
        options($('audio'), data.audioTracks.map((t, i) => [i, t.name || t.lang || `Audio ${i + 1}`]));
        $('audio').disabled = data.audioTracks.length < 2;
      });
      instance.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => { $('audio').value = data.id; });
      instance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_, data) => {
        const index = populateSubtitles(data.subtitleTracks.map(t => ({ name: t.name, language: t.lang, forced: t.forced, default: t.default, url: t.url })));
        queueMicrotask(() => {
          if (generation !== current || hls !== instance) return;
          instance.subtitleDisplay = index >= 0; instance.subtitleTrack = index; subtitleSelection(index, index >= 0);
        });
      });
      instance.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_, data) => subtitleSelection(data.id, data.id >= 0));
      instance.on(Hls.Events.SUBTITLE_FRAG_PROCESSED, (_, data) => { if (data.success && instance.subtitleTrack >= 0) subtitleSelection(instance.subtitleTrack); });
      instance.on(Hls.Events.ERROR, (_, data) => {
        if (current !== generation) return;
        if (/subtitle/i.test(data.details || '')) $('subtitle-status').textContent = 'This subtitle track could not load. Try another language.';
        if (data.fatal && !isOpen()) { window.cancelPreparedPlayer(); return; }
        if (data.fatal && data.response?.code === 410 && sessionRecoveryAvailable && currentTitle) {
          void window.openPlayer(currentTitle, { refresh: true, resumeAt: video.currentTime, recovering: true }); return;
        }
        if (data.fatal) { instance.destroy(); if (hls === instance) hls = null; status('Playback was interrupted. Retry to request a fresh stream.', true); }
      });
      instance.loadSource(source.playbackUrl); instance.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      nativeActive = true; video.src = source.playbackUrl;
      video.addEventListener('loadedmetadata', () => playVideo(current, resumeAt), { once: true });
    } else throw new Error('This browser does not support this video format. Try a current version of Chrome, Firefox, Edge or Safari.');
    status('Loading video…');
  } catch (error) {
    if (current !== generation || error.name === 'AbortError') return;
    if (!isOpen()) { window.cancelPreparedPlayer(); return; }
    status(error instanceof TypeError ? 'The video service cannot be reached. Check your connection and retry.' : error.message, true);
    $('subtitle-status').textContent = '';
  }
}

window.openPlayer = async function (metadata, { refresh = false, resumeAt = 0, recovering = false } = {}) {
  sessionRecoveryAvailable = !recovering;
  playRequestedAt = performance.now(); delete overlay.dataset.startupMs;
  const title = normalizedTitle(metadata);
  const reuse = !refresh && !resumeAt && prepared?.key === titleKey(title) && prepared.until > Date.now() && !playbackError ? prepared : null;
  const current = reuse ? generation : ++generation;
  episodeRequest++;
  if (reuse) clearPreparation(); else resetMedia();
  overlay.dataset.prepared = String(Boolean(reuse));
  currentTitle = title;
  if (!overlay.classList.contains('open')) {
    returnFocus = document.activeElement;
    window.FLIXGX_DETAILS?.suspendForPlayer();
    document.getElementById('modal-backdrop')?.classList.remove('open');
    // Modal also locks scrolling; restore normal catalog scrolling on close.
    previousOverflow = document.body.style.overflow === 'hidden' ? '' : document.body.style.overflow;
    background = Array.from(document.body.children).filter(el => el !== overlay).map(el => [el, el.inert]);
    background.forEach(([el]) => { el.inert = true; });
  }
  overlay.classList.add('open'); overlay.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden';
  keyboardFocus = false; hoveringChrome = false; showChrome();
  $('close').focus(); $('title').textContent = title.title || 'Now playing';
  $('detail').textContent = title.mediaType === 'tv' ? `Season ${title.season} · Episode ${title.episode}${title.episodeName ? ` · ${title.episodeName}` : ''}` : title.subtitle || 'Movie';
  video.removeAttribute('poster');
  status('Finding a stream…');
  void setupEpisodes(title, current);
  if (reuse) {
    await reuse.promise;
    if (current !== generation) return;
    if (hls) {
      hls.config.maxBufferLength = 15; hls.config.maxMaxBufferLength = 30;
      if (reuse.ready) hls.startLoad(-1);
    }
    if (!playbackError && video.getAttribute('src')) playVideo(current, resumeAt);
  } else await loadMedia(title, current, { refresh, resumeAt });
};

window.closePlayer = function () {
  const closingTitle = currentTitle;
  generation++; episodeRequest++; resetMedia(); currentTitle = null;
  if (document.fullscreenElement === overlay) document.exitFullscreen().catch(() => {});
  if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
  overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = previousOverflow || '';
  background.forEach(([el, inert]) => { el.inert = inert; }); background = [];
  if (window.FLIXGX_DETAILS?.resumeFromPlayer(closingTitle)) return;
  const focusTarget = returnFocus?.isConnected && returnFocus.getClientRects().length && !returnFocus.closest('#modal-backdrop') ? returnFocus : Array.from(document.querySelectorAll('a[href],button')).find(el => !overlay.contains(el) && !el.closest('#modal-backdrop') && el.getClientRects().length);
  focusTarget?.focus();
};
$('close').addEventListener('click', window.closePlayer);
$('retry').addEventListener('click', () => window.openPlayer(currentTitle, { refresh: true, resumeAt: video.currentTime }));
video.addEventListener('playing', () => {
  if (!currentTitle) return;
  if (hls && startupQualityInstance === hls) {
    startupQualityInstance = null;
    hls.autoLevelCapping = -1; overlay.dataset.qualityPhase = 'auto';
    // Upgrade at a segment boundary without flushing the frame being played.
    if (Number($('quality').value) === -1) hls.nextLevel = -1;
  }
  status('Playing'); scheduleHide();
  if (!overlay.dataset.startupMs && playRequestedAt) {
    const current = generation, started = playRequestedAt;
    const record = () => { if (current === generation && isOpen() && !overlay.dataset.startupMs) overlay.dataset.startupMs = String(Math.round(performance.now() - started)); };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(record); else record();
  }
});
video.addEventListener('pause', () => { if (currentTitle && video.getAttribute('src') && !video.ended && !playbackError) { status('Paused'); showChrome(); } });
video.addEventListener('waiting', () => { if (currentTitle && !playbackError) status('Buffering…'); });
video.addEventListener('ended', () => { if (currentTitle) { status(currentTitle.mediaType === 'tv' ? 'Episode finished. Choose another episode to continue.' : 'Movie finished.'); showChrome(); } });
video.addEventListener('error', () => { if (nativeActive && currentTitle) status('The stream could not play. Retry to refresh it.', true); });
$('quality').addEventListener('change', () => {
  if (!hls) return;
  startupQualityInstance = null; hls.autoLevelCapping = -1;
  const level = Number($('quality').value);
  overlay.dataset.qualityPhase = level === -1 ? 'auto' : 'manual';
  hls.nextLevel = level;
  updateQualityLabel(hls);
});
$('audio').addEventListener('change', () => { if (hls) hls.audioTrack = Number($('audio').value); });
$('subtitles').addEventListener('change', () => {
  const index = Number($('subtitles').value), track = subtitleTracks[index];
  preference = track ? { language: track.language, name: track.name } : 'off';
  try { savePreference(localStorage, track); } catch {}
  if (hls) { hls.subtitleDisplay = index >= 0; hls.subtitleTrack = index; }
  else if (nativeActive) nativeTracks().forEach((t, i) => { t.mode = i === index ? 'showing' : 'disabled'; });
  subtitleSelection(index, Boolean(hls && index >= 0));
});
function playEpisode(number) {
  const episode = currentTitle.episodes?.find(e => e.episode_number === number);
  if (episode) void window.openPlayer({ ...currentTitle, episode: number, episodeName: episode.name });
}
$('episode').addEventListener('change', () => playEpisode(Number($('episode').value)));
$('next').addEventListener('click', () => {
  const next = currentTitle.episodes?.find(e => e.episode_number > currentTitle.episode);
  if (next) playEpisode(next.episode_number);
});
$('season').addEventListener('change', async () => {
  const request = ++episodeRequest, title = currentTitle, season = Number($('season').value);
  $('season').disabled = true; $('episode').disabled = true; $('next').disabled = true;
  try {
    const episodes = await episodesFor(title, season);
    if (request !== episodeRequest) return;
    void window.openPlayer({ ...title, season, episode: episodes[0].episode_number, episodeName: episodes[0].name, episodes });
  } catch (error) {
    if (request !== episodeRequest) return;
    announce(error.message); void setupEpisodes(title, generation);
  }
});
