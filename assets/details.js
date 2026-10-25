/* Shared title details. The existing modal ID is also the player's preload boundary. */
(() => {
  'use strict';
  const overlay = document.getElementById('modal-backdrop');
  if (!overlay) return;
  const player = () => document.getElementById('fp-overlay');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const image = (path, size = 'w1280') => /^\/[a-zA-Z0-9._-]+$/.test(path || '') ? `https://image.tmdb.org/t/p/${size}${path}` : '';
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{
    back: '<path d="m14 5-7 7 7 7"/>', play: '<path d="m7 4 13 8-13 8Z" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12 4 4L19 6"/>',
    episodes: '<path d="M5 6h14M5 12h14M5 18h9"/>', similar: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    mute: '<path d="m11 5-6 4H2v6h3l6 4Z"/><path d="m17 9 5 6m0-6-5 6"/>', sound: '<path d="m11 5-6 4H2v6h3l6 4Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'
  }[name] || ''}</svg>`;
  const back = () => `<button type="button" class="detail-circle detail-back" data-action="back" aria-label="Back to browsing" title="Back">${icon('back')}</button>`;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let state = null, version = 0, seasonVersion = 0, background = [], priorOverflow = '', returnFocus = null;
  let preview = null, previewTimer = null, youtubePromise = null;
  overlay.className = 'details-page';
  overlay.removeAttribute('onclick');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Title details');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.tabIndex = -1;
  overlay.inert = true;
  overlay.innerHTML = '';
  const active = () => overlay.classList.contains('open');
  const valid = token => token === version && state && (active() || state.suspended);
  const focusBack = () => overlay.querySelector('[data-action="back"]')?.focus({ preventScroll: true });

  function lockBackground() {
    background = Array.from(document.body.children).filter(el => el !== overlay && el !== player()).map(el => [el, el.inert]);
    background.forEach(([el]) => { el.inert = true; });
    priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  function stopPreview() {
    clearTimeout(previewTimer);
    preview?.destroy?.(); preview = null;
    const container = overlay.querySelector('.detail-trailer');
    if (container) { container.classList.remove('is-playing'); container.innerHTML = ''; }
    const mute = overlay.querySelector('.detail-mute');
    if (mute) mute.hidden = true;
  }
  function loadYoutube() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (youtubePromise) return youtubePromise;
    youtubePromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      const timeout = setTimeout(() => reject(new Error('Preview unavailable')), 10000);
      window.onYouTubeIframeAPIReady = () => { clearTimeout(timeout); previous?.(); resolve(window.YT); };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api'; script.async = true;
      script.onerror = () => { clearTimeout(timeout); reject(new Error('Preview unavailable')); };
      document.head.append(script);
    });
    return youtubePromise;
  }
  async function startPreview(token) {
    if (!valid(token) || !active() || state.suspended || !state.trailer || reducedMotion.matches || navigator.connection?.saveData || document.hidden) return;
    const trailer = state.trailer;
    try {
      const YT = await loadYoutube();
      if (!valid(token) || !active() || state.suspended) return;
      const container = overlay.querySelector('.detail-trailer');
      if (!container || preview) return;
      const mount = document.createElement('div'); container.append(mount);
      preview = new YT.Player(mount, {
        host: 'https://www.youtube-nocookie.com', videoId: trailer,
        playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, fs: 0, playsinline: 1, rel: 0, loop: 1, playlist: trailer, origin: location.origin },
        events: {
          onReady: event => {
            if (!valid(token) || !active() || state.suspended) { event.target.destroy(); return; }
            const frame = event.target.getIframe(); frame.title = `${state.metadata.title} trailer preview`; frame.tabIndex = -1;
            frame.setAttribute('aria-hidden', 'true');
            event.target.mute(); event.target.playVideo();
          },
          onStateChange: event => {
            if (!valid(token) || !active() || state.suspended) return;
            if (event.data === 1) {
              if (document.hidden || overlay.scrollTop > overlay.clientHeight * .8) { event.target.pauseVideo(); return; }
              container.classList.add('is-playing');
              const mute = overlay.querySelector('.detail-mute'); if (mute) mute.hidden = false;
            }
          },
          onError: () => { if (valid(token)) stopPreview(); }
        }
      });
    } catch { /* The backdrop remains visible if embedding/autoplay is unavailable. */ }
  }
  function updatePreviewVisibility() {
    if (!preview?.pauseVideo) return;
    const shouldPause = !active() || document.hidden || overlay.scrollTop > overlay.clientHeight * .8;
    if (shouldPause) preview.pauseVideo(); else preview.playVideo();
  }
  function watchlist() {
    try { const data = JSON.parse(localStorage.getItem('flixgx.watchlist') || '[]'); return Array.isArray(data) ? data.filter(x => x && Number.isSafeInteger(x.id) && ['movie', 'tv'].includes(x.mediaType)) : []; }
    catch { return []; }
  }
  function updateWatchlist() {
    const button = overlay.querySelector('[data-action="watchlist"]');
    if (!button || !state?.metadata) return;
    const saved = watchlist().some(x => x.id === state.metadata.id && x.mediaType === state.metadata.mediaType);
    button.setAttribute('aria-pressed', String(saved)); button.setAttribute('aria-label', saved ? 'Remove from My List' : 'Add to My List');
    button.title = saved ? 'Remove from My List' : 'Add to My List'; button.innerHTML = icon(saved ? 'check' : 'plus');
  }
  function updatePlay() {
    const button = overlay.querySelector('[data-action="play"]');
    if (!button || !state) return;
    const meta = state.metadata;
    button.disabled = meta.mediaType === 'tv' && !meta.episodes?.length;
    button.innerHTML = `${icon('play')}<span>${meta.mediaType === 'tv' ? `Play S${meta.season} E${meta.episode}` : 'Play'}</span>`;
    overlay.querySelectorAll('[data-episode]').forEach(el => el.classList.toggle('is-selected', Number(el.dataset.episode) === meta.episode));
  }
  function renderCredits(credits = []) {
    return credits.length ? `<ul class="detail-cast-grid">${credits.slice(0, 12).map(person => `<li class="detail-actor"><div class="detail-avatar" aria-hidden="true"><span>${esc((person.name || '?').slice(0, 1))}</span>${image(person.profile_path, 'w185') ? `<img src="${image(person.profile_path, 'w185')}" alt="" loading="lazy" data-image-fallback>` : ''}</div><div class="detail-actor-info"><p class="detail-actor-name">${esc(person.name || 'Unknown')}</p><p class="detail-character">${esc(person.character || person.roles?.[0]?.character || '')}</p></div></li>`).join('')}</ul>` : '<p class="detail-empty">Cast information is not available for this title yet.</p>';
  }
  function renderRecommendations(items, type) {
    const titles = items.filter(item => Number.isSafeInteger(item.id) && item.id > 0 && (!item.media_type || ['movie', 'tv'].includes(item.media_type))).slice(0, 20);
    return titles.length ? `<div class="detail-recs">${titles.map(item => {
      const itemType = item.media_type || type, title = item.title || item.name || 'Untitled';
      const art = image(item.backdrop_path, 'w780') || image(item.poster_path, 'w500');
      return `<button type="button" class="detail-rec" data-title-id="${item.id}" data-title-type="${itemType}" aria-label="View ${esc(title)}"><span class="detail-rec-art">${art ? `<img src="${art}" alt="" loading="lazy" data-image-fallback>` : icon('play')}</span><span class="detail-rec-title">${esc(title)}</span><span class="detail-rec-meta"><span class="detail-star" aria-label="Rating">★</span><span>${item.vote_average ? Number(item.vote_average).toFixed(1) : '—'}</span><span class="detail-dot">·</span><span>${esc((item.release_date || item.first_air_date || '').slice(0, 4) || '—')}</span><span class="detail-dot">·</span><span>${itemType === 'tv' ? 'Series' : 'Movie'}</span></span></button>`;
    }).join('')}</div>` : '<p class="detail-empty">No similar titles are available yet.</p>';
  }
  function render(data, type, token) {
    const title = data.title || data.name || 'Untitled', year = (data.release_date || data.first_air_date || '').slice(0, 4);
    const seasons = (data.seasons || []).filter(s => s.season_number > 0);
    const runtime = type === 'movie' && data.runtime ? `${Math.floor(data.runtime / 60) ? `${Math.floor(data.runtime / 60)}h ` : ''}${data.runtime % 60}m` : type === 'tv' && seasons.length ? `${seasons.length} season${seasons.length === 1 ? '' : 's'}` : '';
    const logos = (data.images?.logos || []).filter(item => image(item.file_path, 'w500'));
    const logo = logos.find(item => item.iso_639_1 === 'en') || logos.find(item => !item.iso_639_1) || logos[0];
    const trailer = (data.videos?.results || []).filter(item => item.site === 'YouTube' && item.official && /^[\w-]{11}$/.test(item.key) && ['Trailer', 'Teaser'].includes(item.type)).sort((a, b) => Number(b.type === 'Trailer') - Number(a.type === 'Trailer'))[0];
    const backdrop = image(data.backdrop_path) || image(data.poster_path);
    state.metadata = { id: data.id, mediaType: type, title, subtitle: [year, runtime].filter(Boolean).join(' · '), backdropUrl: backdrop, posterUrl: image(data.poster_path, 'w500'), runtimeSecs: (data.runtime || 45) * 60, seasons, season: seasons[0]?.season_number || 1, episode: 1, episodes: [] };
    state.trailer = trailer?.key || null; state.muted = true;
    window.__fp = state.metadata;
    const meta = [year, runtime, ...(data.genres || []).slice(0, 3).map(g => g.name)].filter(Boolean);
    overlay.innerHTML = `<section class="detail-hero" aria-labelledby="detail-title">${back()}<button class="detail-circle detail-mute" type="button" data-action="mute" aria-label="Unmute trailer preview" title="Unmute trailer preview" hidden>${icon('mute')}</button>${backdrop ? `<img class="detail-art" src="${backdrop}" alt="" fetchpriority="high" data-image-fallback>` : ''}<div class="detail-trailer" aria-hidden="true"></div><div class="detail-shade"></div><div class="detail-info"><h1 class="detail-heading" id="detail-title">${logo ? `<img class="detail-logo" src="${image(logo.file_path, 'w500')}" alt="${esc(title)}" data-logo-fallback="${esc(title)}">` : esc(title)}</h1><div class="detail-meta"><span class="detail-rating"><span class="detail-star">★</span>${data.vote_average ? Number(data.vote_average).toFixed(1) : '—'}</span>${meta.map(value => `<span class="detail-dot">·</span><span>${esc(value)}</span>`).join('')}</div><div class="detail-description"><p id="detail-overview">${esc(data.overview || 'No description available.')}</p><button type="button" class="detail-read-more" data-action="description" aria-expanded="false" aria-controls="detail-overview" hidden>Read more</button></div><div class="detail-actions"><button type="button" class="detail-play" data-action="play">${icon('play')}<span>Play</span></button><button type="button" class="detail-circle detail-watchlist" data-action="watchlist" aria-label="Add to My List" aria-pressed="false">${icon('plus')}</button>${type === 'tv' ? `<button type="button" class="detail-pill" data-scroll-to="detail-episodes">${icon('episodes')}Episodes</button>` : ''}<button type="button" class="detail-pill" data-scroll-to="detail-similar">${icon('similar')}Similars</button></div><span class="detail-sr-only" role="status" id="detail-notice"></span></div></section><div class="detail-below">${type === 'tv' ? `<section class="detail-section" id="detail-episodes" tabindex="-1" aria-labelledby="detail-episodes-title"><div class="detail-episode-heading"><h2 class="detail-section-heading" id="detail-episodes-title">Episodes</h2>${seasons.length ? `<label class="detail-season-control">Season<select id="detail-season" aria-label="Select season">${seasons.map(s => `<option value="${s.season_number}">${esc(s.name || `Season ${s.season_number}`)}</option>`).join('')}</select></label>` : ''}</div><div id="detail-episode-list" aria-live="polite"><p class="detail-empty">${seasons.length ? 'Loading episodes…' : 'No episodes are available yet.'}</p></div></section>` : ''}<section class="detail-section" aria-labelledby="detail-cast-title"><h2 class="detail-section-heading" id="detail-cast-title">Actors</h2>${renderCredits(data.credits?.cast)}</section><section class="detail-section" id="detail-similar" tabindex="-1" aria-labelledby="detail-similar-title"><h2 class="detail-section-heading" id="detail-similar-title">You may like</h2><div id="detail-recommendations">${renderRecommendations(data.recommendations?.results?.length ? data.recommendations.results : data.similar?.results || [], type)}</div></section></div>`;
    overlay.setAttribute('aria-labelledby', 'detail-title'); overlay.removeAttribute('aria-label');
    updateWatchlist(); updatePlay(); focusBack();
    requestAnimationFrame(() => {
      if (!valid(token)) return;
      const description = overlay.querySelector('#detail-overview');
      const expand = overlay.querySelector('[data-action="description"]');
      if (expand && description) expand.hidden = description.scrollHeight <= description.clientHeight + 2;
    });
    if (type === 'tv' && seasons.length) void loadSeason(data.id, seasons[0].season_number);
    else if (type === 'movie') window.preparePlayer?.(state.metadata);
    previewTimer = setTimeout(() => void startPreview(token), 700);
  }
  async function openModal(id, type = 'movie') {
    id = Number(id); type = type === 'tv' ? 'tv' : 'movie';
    if (!Number.isSafeInteger(id) || id <= 0 || player()?.classList.contains('open')) return;
    const token = ++version; seasonVersion++; stopPreview(); window.cancelPreparedPlayer?.();
    if (!state) { returnFocus = document.activeElement; lockBackground(); }
    state = { id, type, token, metadata: null, suspended: false };
    overlay.inert = false; overlay.classList.add('open'); overlay.setAttribute('aria-hidden', 'false');
    overlay.removeAttribute('aria-labelledby'); overlay.setAttribute('aria-label', 'Title details');
    overlay.innerHTML = `${back()}<div class="detail-loading" role="status"><span class="detail-spinner" aria-hidden="true"></span><p>Loading title…</p></div>`;
    overlay.scrollTop = 0; focusBack();
    try {
      const data = await window.tmdb(`/${type}/${id}`, { append_to_response: 'credits,images,videos,recommendations,similar', include_image_language: 'en,null' });
      if (!valid(token)) return;
      if (!data?.id || data.success === false) throw new Error('Title unavailable');
      render(data, type, token);
    } catch {
      if (!valid(token)) return;
      overlay.innerHTML = `${back()}<div class="detail-error"><h2>Couldn’t load this title</h2><p>Please check your connection and try again.</p><button type="button" class="detail-pill" data-action="retry">Try again</button></div>`; focusBack();
    }
  }
  async function loadSeason(id, number, selectedEpisode) {
    if (!state?.metadata || state.id !== Number(id) || state.type !== 'tv') return;
    const season = Number(number);
    if (!state.metadata.seasons.some(s => s.season_number === season)) return;
    const token = version, request = ++seasonVersion;
    Object.assign(state.metadata, { season, episode: Number(selectedEpisode) || 1, episodes: [] });
    window.cancelPreparedPlayer?.();
    const select = overlay.querySelector('#detail-season'); if (select) select.value = String(season);
    const list = overlay.querySelector('#detail-episode-list');
    if (!list) return;
    list.innerHTML = '<p class="detail-empty">Loading episodes…</p>'; updatePlay();
    try {
      const data = await window.tmdb(`/tv/${id}/season/${season}`);
      if (!valid(token) || request !== seasonVersion) return;
      if (data.success === false || !Array.isArray(data.episodes)) throw new Error('Episodes unavailable');
      const episodes = data.episodes.filter(ep => Number.isInteger(ep.episode_number) && ep.episode_number > 0);
      state.metadata.episodes = episodes;
      state.metadata.episode = episodes.some(ep => ep.episode_number === Number(selectedEpisode)) ? Number(selectedEpisode) : episodes[0]?.episode_number || 1;
      list.innerHTML = episodes.length ? `<div class="detail-episode-grid">${episodes.map(ep => {
        const art = image(ep.still_path, 'w500') || state.metadata.backdropUrl;
        return `<button type="button" class="detail-episode" data-episode="${ep.episode_number}" aria-label="Play season ${season}, episode ${ep.episode_number}: ${esc(ep.name || '')}"><span class="detail-episode-art">${art ? `<img src="${art}" alt="" loading="lazy" data-image-fallback>` : ''}<span class="detail-episode-play">${icon('play')}</span></span><span class="detail-episode-info"><span class="detail-episode-title">${ep.episode_number}. ${esc(ep.name || `Episode ${ep.episode_number}`)}</span><span class="detail-episode-meta">${esc([ep.runtime ? `${ep.runtime}m` : '', ep.air_date || ''].filter(Boolean).join(' · '))}</span><span class="detail-episode-overview">${esc(ep.overview || '')}</span></span></button>`;
      }).join('')}</div>` : '<p class="detail-empty">No episodes are available for this season yet.</p>';
      updatePlay();
      if (episodes.length && active() && !state.suspended) window.preparePlayer?.(state.metadata);
    } catch {
      if (!valid(token) || request !== seasonVersion) return;
      list.innerHTML = '<p class="detail-empty">Couldn’t load episodes. <button type="button" class="detail-pill" data-action="retry-season">Try again</button></p>';
    }
  }
  function closeModal(event) {
    if (event && event.target !== overlay) return;
    if (!state || state.suspended) return;
    version++; seasonVersion++; stopPreview(); window.cancelPreparedPlayer?.();
    state = null; overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); overlay.inert = true;
    overlay.innerHTML = ''; overlay.removeAttribute('aria-labelledby'); overlay.setAttribute('aria-label', 'Title details');
    document.body.style.overflow = priorOverflow;
    background.forEach(([el, inert]) => { el.inert = inert; }); background = [];
    const target = returnFocus?.isConnected && returnFocus !== document.body ? returnFocus : document.querySelector('main a, main button, nav a, a[href]');
    target?.focus({ preventScroll: true }); returnFocus = null;
  }
  function play(episode, trigger) {
    if (!state?.metadata) return;
    const meta = state.metadata;
    if (meta.mediaType === 'tv') {
      const ep = meta.episodes.find(item => item.episode_number === Number(episode || meta.episode));
      if (!ep) return;
      Object.assign(meta, { episode: ep.episode_number, episodeName: ep.name || `Episode ${ep.episode_number}` }); updatePlay();
    }
    state.playTrigger = trigger || document.activeElement;
    window.openPlayer?.({ ...meta });
  }
  window.FLIXGX_DETAILS = {
    suspendForPlayer() {
      if (!state || !active()) return false;
      state.suspended = true; state.playerFocus = state.playTrigger || document.activeElement; state.playTrigger = null; state.scrollTop = overlay.scrollTop;
      stopPreview(); overlay.setAttribute('aria-hidden', 'true'); return true;
    },
    resumeFromPlayer(title) {
      if (!state?.suspended) return false;
      state.suspended = false; overlay.inert = false; overlay.classList.add('open'); overlay.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden';
      overlay.scrollTop = state.scrollTop || 0;
      if (title?.id === state.id && title.mediaType === 'tv') {
        if (title.season !== state.metadata.season) void loadSeason(state.id, title.season, title.episode);
        else { state.metadata.episode = title.episode; updatePlay(); }
      }
      if (state.playerFocus?.isConnected) state.playerFocus.focus({ preventScroll: true }); else focusBack();
      return true;
    }
  };
  Object.assign(window, { openModal, closeModal, loadSeason, openEpisode: (_season, episode) => play(episode) });
  overlay.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.titleId) { void openModal(button.dataset.titleId, button.dataset.titleType); return; }
    if (button.dataset.episode) { play(button.dataset.episode, button); return; }
    if (button.dataset.scrollTo) {
      const target = document.getElementById(button.dataset.scrollTo);
      target?.scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' }); target?.focus({ preventScroll: true }); return;
    }
    switch (button.dataset.action) {
      case 'back': closeModal(); break;
      case 'retry': if (state) void openModal(state.id, state.type); break;
      case 'retry-season': if (state) void loadSeason(state.id, state.metadata.season); break;
      case 'play': play(undefined, button); break;
      case 'description': {
        const expanded = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(expanded)); button.textContent = expanded ? 'Show less' : 'Read more';
        button.closest('.detail-description').classList.toggle('is-expanded', expanded); break;
      }
      case 'watchlist': {
        if (!state?.metadata) return;
        const { id, mediaType, title, posterUrl } = state.metadata, items = watchlist();
        const exists = items.some(x => x.id === id && x.mediaType === mediaType);
        try {
          localStorage.setItem('flixgx.watchlist', JSON.stringify(exists ? items.filter(x => x.id !== id || x.mediaType !== mediaType) : [...items, { id, mediaType, title, posterUrl }]));
          updateWatchlist(); overlay.querySelector('#detail-notice').textContent = exists ? 'Removed from My List' : 'Added to My List';
        } catch { overlay.querySelector('#detail-notice').textContent = 'Your browser could not save My List.'; }
        break;
      }
      case 'mute': {
        if (!preview || !state) return;
        state.muted = !state.muted;
        if (state.muted) preview.mute(); else preview.unMute();
        const label = state.muted ? 'Unmute trailer preview' : 'Mute trailer preview';
        button.setAttribute('aria-label', label); button.title = label; button.innerHTML = icon(state.muted ? 'mute' : 'sound'); break;
      }
    }
  });
  overlay.addEventListener('change', event => { if (event.target.id === 'detail-season' && state) void loadSeason(state.id, event.target.value); });
  overlay.addEventListener('error', event => {
    if (event.target.dataset?.logoFallback) event.target.replaceWith(document.createTextNode(event.target.dataset.logoFallback));
    else if (event.target.hasAttribute?.('data-image-fallback')) event.target.remove();
  }, true);
  overlay.addEventListener('scroll', updatePreviewVisibility, { passive: true });
  document.addEventListener('visibilitychange', updatePreviewVisibility);
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) stopPreview(); });
  document.addEventListener('keydown', event => {
    if (!active() || player()?.classList.contains('open')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeModal(); }
    if (event.key === 'Tab') {
      const items = Array.from(overlay.querySelectorAll('button:not(:disabled),select:not(:disabled),a[href]')).filter(el => el.getClientRects().length);
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === overlay)) { event.preventDefault(); items.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    }
  });
})();
