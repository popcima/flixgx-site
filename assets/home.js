/* Catalog data stays shared with the existing details page and player. */
(() => {
  'use strict';
  const API_KEY = '76f5b20391ff39408d52881f31d48412';
  const BASE = 'https://api.themoviedb.org/3';
  const IMAGE = 'https://image.tmdb.org/t/p/';
  const WATCHLIST = 'flixgx.watchlist';
  const detailCache = new Map(), heroCache = new Map(), rowLoaders = new Map();
  const $ = id => document.getElementById(id);
  const icons = {
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>'
  };
  const sectionDefinitions = [
    { id: 'row-trending-week', title: 'Trending This Week', key: 'trending_week', path: '/trending/all/week' },
    { id: 'row-trending-today', title: 'Trending Today', key: 'trending_today', path: '/trending/all/day' },
    { id: 'row-popular', title: 'Popular Movies', key: 'popular_movies', path: '/movie/popular', type: 'movie' },
    { id: 'row-new', title: 'New Releases', path: '/movie/now_playing', type: 'movie' },
    { id: 'row-top', title: 'Top Rated', path: '/movie/top_rated', type: 'movie' },
    { id: 'row-horror', title: 'Horror', path: '/discover/movie', genre: '27', type: 'movie' },
    { id: 'row-thriller', title: 'Thriller', path: '/discover/movie', genre: '53', type: 'movie' },
    { id: 'row-crime', title: 'Crime', path: '/discover/movie', genre: '80', type: 'movie' },
    { id: 'row-doc', title: 'Documentary', path: '/discover/movie', genre: '99', type: 'movie' }
  ];
  let heroItems = [], heroIndex = 0, heroVersion = 0, selected = null;

  async function tmdb(path, params = {}) {
    const url = new URL(BASE + path);
    url.searchParams.set('api_key', API_KEY);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Title information unavailable (${response.status}).`);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  window.tmdb = tmdb;

  function imageURL(path, size = 'w780') {
    return typeof path === 'string' && /^\/[a-zA-Z0-9._-]+$/.test(path) ? IMAGE + size + path : '';
  }
  function mediaType(item) {
    if (item?.media_type && !['movie', 'tv'].includes(item.media_type)) return null;
    return item?.media_type || (item?.first_air_date != null ? 'tv' : 'movie');
  }
  function validItem(item) { return item && Number.isSafeInteger(item.id) && item.id > 0 && mediaType(item); }
  function titleOf(item) { return item.title || item.name || 'Untitled'; }
  function yearOf(item) { return (item.release_date || item.first_air_date || '').slice(0, 4); }
  function ratingOf(item) { return Number(item.vote_average) > 0 ? Number(item.vote_average).toFixed(1) : '—'; }
  function runtimeOf(item) {
    const minutes = Number(item.runtime || item.episode_run_time?.[0]);
    if (!Number.isFinite(minutes) || minutes <= 0) return '';
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
  }
  function span(className, text) {
    const node = document.createElement('span'); node.className = className; node.textContent = text; return node;
  }
  function addMeta(parent, parts) {
    parts.filter(Boolean).forEach((part, index) => {
      if (index) parent.append(span('home-dot', '·'));
      parent.append(typeof part === 'string' ? span('', part) : part);
    });
  }
  function rating(item, hero = false) {
    const node = span(hero ? 'home-rating' : '', '');
    node.append(span('home-star', '★'), document.createTextNode(ratingOf(item)));
    node.setAttribute('aria-label', `Rating ${ratingOf(item)}`); return node;
  }
  function getTitle(id, type) {
    const key = `${type}/${id}`;
    if (!detailCache.has(key)) {
      detailCache.set(key, tmdb(`/${key}`).then(data => ({ ...data, media_type: type })).catch(error => { detailCache.delete(key); throw error; }));
    }
    return detailCache.get(key);
  }
  function getHeroTitle(item) {
    const type = mediaType(item), key = `${type}/${item.id}`;
    if (!heroCache.has(key)) {
      // Curated titles already have details; fetch only their missing artwork.
      const promise = detailCache.has(key)
        ? Promise.all([getTitle(item.id, type), tmdb(`/${key}/images`, { include_image_language: 'en,null' })]).then(([details, images]) => ({ ...details, images }))
        : tmdb(`/${key}`, { append_to_response: 'images', include_image_language: 'en,null' }).then(details => ({ ...details, media_type: type }));
      heroCache.set(key, promise.then(details => { detailCache.set(key, Promise.resolve(details)); return details; }).catch(error => { heroCache.delete(key); throw error; }));
    }
    return heroCache.get(key);
  }

  function watchlist() {
    try {
      const items = JSON.parse(localStorage.getItem(WATCHLIST) || '[]');
      return Array.isArray(items) ? items.filter(item => item && Number.isSafeInteger(item.id) && ['movie', 'tv'].includes(item.mediaType)) : [];
    } catch { return []; }
  }
  function refreshWatchlist() {
    const saved = selected && watchlist().some(item => item.id === selected.id && item.mediaType === selected.mediaType);
    const button = $('hero-watchlist'), label = saved ? 'Remove from My List' : 'Add to My List';
    button.setAttribute('aria-pressed', String(Boolean(saved))); button.setAttribute('aria-label', label); button.title = label;
    button.innerHTML = icons[saved ? 'check' : 'plus'];
  }
  function toggleWatchlist() {
    if (!selected) return;
    const items = watchlist(), { id, mediaType: type, title, posterUrl } = selected;
    const exists = items.some(item => item.id === id && item.mediaType === type);
    try {
      localStorage.setItem(WATCHLIST, JSON.stringify(exists ? items.filter(item => item.id !== id || item.mediaType !== type) : [...items, { id, mediaType: type, title, posterUrl }]));
      refreshWatchlist(); $('hero-notice').textContent = exists ? 'Removed from My List' : 'Added to My List';
    } catch { $('hero-notice').textContent = 'Your browser could not save My List.'; }
  }

  function skeletons() {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 4; index++) {
      const node = document.createElement('div'); node.className = 'home-skeleton'; node.setAttribute('aria-hidden', 'true');
      node.innerHTML = '<div class="home-skeleton-art"></div><div class="home-skeleton-line"></div><div class="home-skeleton-line"></div>'; fragment.append(node);
    }
    return fragment;
  }
  function createSections() {
    sectionDefinitions.forEach(definition => {
      const section = document.createElement('section'); section.className = 'home-section'; section.setAttribute('aria-labelledby', `${definition.id}-heading`);
      const head = document.createElement('div'); head.className = 'home-section-heading';
      const heading = document.createElement('h2'); heading.id = `${definition.id}-heading`; heading.textContent = definition.title;
      const controls = document.createElement('div'); controls.className = 'home-rail-controls';
      ['left', 'right'].forEach((direction, index) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'home-rail-arrow'; button.disabled = true;
        button.setAttribute('aria-label', `${index ? 'Next' : 'Previous'} ${definition.title.toLowerCase()} titles`); button.setAttribute('aria-controls', definition.id);
        button.dataset.rail = definition.id; button.dataset.direction = index ? '1' : '-1'; button.innerHTML = icons[direction]; controls.append(button);
      });
      head.append(heading, controls);
      const rail = document.createElement('div'); rail.className = 'home-rail'; rail.id = definition.id; rail.setAttribute('aria-busy', 'true');
      rail.append(skeletons()); rail.addEventListener('scroll', () => updateRailControls(rail), { passive: true });
      section.append(head, rail); $('main-content').append(section);
    });
  }
  function createCard(item) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'home-card';
    button.dataset.id = item.id; button.dataset.type = mediaType(item); button.setAttribute('aria-label', `More about ${titleOf(item)}`);
    const art = span('home-card-art', ''), backdrop = imageURL(item.backdrop_path), poster = imageURL(item.poster_path, 'w500');
    if (backdrop || poster) {
      const img = new Image(); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = backdrop || poster;
      if (!backdrop) art.classList.add('is-poster');
      img.addEventListener('error', () => {
        if (poster && img.src !== poster) { img.src = poster; art.classList.add('is-poster'); }
        else { img.remove(); art.classList.add('is-missing'); }
      }); art.append(img);
    } else art.classList.add('is-missing');
    const meta = span('home-card-meta', ''); addMeta(meta, [rating(item), yearOf(item), mediaType(item) === 'tv' ? 'Series' : 'Movie']);
    button.append(art, span('home-card-title', titleOf(item)), meta); return button;
  }
  function updateRailControls(rail) {
    const remaining = rail.scrollWidth - rail.clientWidth;
    const section = rail.closest('.home-section');
    section.querySelector('[data-direction="-1"]').disabled = rail.scrollLeft <= 2;
    section.querySelector('[data-direction="1"]').disabled = remaining <= 2 || rail.scrollLeft >= remaining - 2;
  }
  function rowState(rail, message, retry = false) {
    const state = document.createElement('p'); state.className = 'home-row-state'; state.textContent = message;
    if (retry) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'home-retry'; button.dataset.retry = rail.id; button.textContent = 'Try again'; state.append(button);
    }
    rail.replaceChildren(state);
  }
  async function loadRow(definition) {
    const rail = $(definition.id); rail.setAttribute('aria-busy', 'true'); rail.replaceChildren(skeletons());
    try {
      const items = (await rowLoaders.get(definition.id)()).filter(validItem).slice(0, 14);
      if (items.length) rail.replaceChildren(...items.map(createCard)); else rowState(rail, 'No titles are available in this section yet.');
      return items;
    } catch {
      rowState(rail, 'These titles could not load. Please try again.', true); return [];
    } finally { rail.setAttribute('aria-busy', 'false'); updateRailControls(rail); }
  }

  function setHeroBusy(busy) {
    $('hero').setAttribute('aria-busy', String(busy));
    ['hero-play', 'hero-info', 'hero-watchlist'].forEach(id => { $(id).disabled = busy || !selected; });
  }
  function renderHeroCopy(item) {
    const title = titleOf(item), heading = $('hero-heading');
    heading.replaceChildren(document.createTextNode(title));
    $('hero-description').textContent = item.overview || 'Open the title details to explore this title.';
    const metadata = $('hero-meta'); metadata.replaceChildren();
    const genres = (item.genres || []).slice(0, 2).map(genre => genre.name).filter(Boolean);
    addMeta(metadata, [rating(item, true), yearOf(item), runtimeOf(item), ...(genres.length ? genres : [mediaType(item) === 'tv' ? 'Series' : 'Movie'])]);
  }
  function renderHeroArt(item, version) {
    const art = $('hero-bg'), backdrop = imageURL(item.backdrop_path, 'original'), poster = imageURL(item.poster_path, 'original');
    art.classList.remove('is-loaded'); art.onload = null; art.onerror = null;
    if (!backdrop && !poster) { art.removeAttribute('src'); return; }
    art.onload = () => { if (version === heroVersion) art.classList.add('is-loaded'); };
    art.onerror = () => {
      if (version !== heroVersion) return;
      if (poster && art.src !== poster) art.src = poster;
      else { art.removeAttribute('src'); art.classList.remove('is-loaded'); }
    };
    art.src = backdrop || poster;
    if (art.complete && art.naturalWidth) art.classList.add('is-loaded');
  }
  async function setHero(index) {
    if (!heroItems.length) return;
    const version = ++heroVersion;
    heroIndex = (index + heroItems.length) % heroItems.length;
    const item = heroItems[heroIndex]; selected = null; setHeroBusy(true); refreshWatchlist();
    $('hero-notice').textContent = ''; $('hero-error').hidden = true; $('hero-actions').hidden = false;
    $('hero-count-current').textContent = String(heroIndex + 1).padStart(2, '0');
    $('hero-count-total').textContent = String(heroItems.length).padStart(2, '0');
    ['hero-previous', 'hero-next'].forEach(id => { $(id).disabled = heroItems.length < 2; });
    renderHeroCopy(item); renderHeroArt(item, version);
    const details = await getHeroTitle(item).catch(() => item);
    if (version !== heroVersion) return;
    renderHeroCopy(details);
    const logos = details.images?.logos || [], logo = logos.find(image => image.iso_639_1 === 'en') || logos.find(image => !image.iso_639_1);
    const logoURL = imageURL(logo?.file_path, 'w500');
    if (logoURL) {
      const image = new Image(); image.className = 'home-hero-logo'; image.alt = titleOf(details); image.decoding = 'async';
      image.onload = () => { if (version === heroVersion) $('hero-heading').replaceChildren(image); };
      image.src = logoURL;
    }
    selected = { id: item.id, mediaType: mediaType(item), title: titleOf(details), subtitle: yearOf(details), backdropUrl: imageURL(details.backdrop_path, 'original'), posterUrl: imageURL(details.poster_path, 'w500'), seasons: details.seasons || [] };
    setHeroBusy(false); refreshWatchlist();
    $('hero-announcement').textContent = `Featured ${heroIndex + 1} of ${heroItems.length}: ${selected.title}`;
  }
  async function resolveReferences(references, supabase = false) {
    if (!Array.isArray(references) || !references.length) return null;
    const valid = references.map(item => ({ id: Number(supabase ? item.content_id : item.id), type: supabase ? item.content_type : item.media_type }))
      .filter(item => Number.isSafeInteger(item.id) && item.id > 0 && ['movie', 'tv'].includes(item.type));
    const items = await Promise.all(valid.map(item => getTitle(item.id, item.type).catch(() => null)));
    return items.filter(validItem);
  }
  async function curated(key, sections, custom) {
    const remote = await resolveReferences(sections[key], true);
    if (remote?.length) return remote;
    const local = await resolveReferences(custom[key]);
    return local?.length ? local : null;
  }
  async function loadConfiguration() {
    const local = fetch('./data.json').then(response => response.ok ? response.json() : {}).catch(() => ({}));
    let timeout;
    const remote = Promise.race([
      Promise.resolve().then(() => window.NXSections?.load() || {}),
      new Promise(resolve => { timeout = setTimeout(() => resolve({}), 10000); })
    ]).catch(() => ({})).finally(() => clearTimeout(timeout));
    const [custom, sections] = await Promise.all([local, remote]); return { custom: custom || {}, sections: sections || {} };
  }
  function heroError() {
    selected = null; setHeroBusy(false); $('hero-actions').hidden = true;
    $('hero-heading').textContent = 'Discover your next watch.'; $('hero-description').textContent = '';
    $('hero-meta').replaceChildren(); $('hero-error').hidden = false;
    $('hero-previous').disabled = true; $('hero-next').disabled = true;
  }
  async function init() {
    createSections();
    const { custom, sections } = await loadConfiguration();
    sectionDefinitions.forEach(definition => {
      rowLoaders.set(definition.id, async () => {
        const controlled = definition.key ? await curated(definition.key, sections, custom) : null;
        if (controlled) return controlled;
        const params = definition.genre ? { with_genres: definition.genre, sort_by: 'popularity.desc' } : {};
        const response = await tmdb(definition.path, params);
        return (response.results || []).map(item => ({ ...item, media_type: definition.type || mediaType(item) }));
      });
    });
    const rows = sectionDefinitions.map(loadRow);
    const loadFeatured = async (trendingPromise) => {
      $('hero-retry').disabled = true;
      try {
        const controlled = await resolveReferences(sections.hero, true);
        const items = controlled?.length ? controlled : await (trendingPromise || rowLoaders.get('row-trending-week')());
        heroItems = items.filter(validItem).slice(0, 5);
        if (heroItems.length) await setHero(0); else heroError();
      } catch { heroError(); }
      finally { $('hero-retry').disabled = false; }
    };
    $('hero-retry').addEventListener('click', () => loadFeatured());
    await loadFeatured(rows[0]);
  }

  $('hero-previous').innerHTML = icons.left; $('hero-next').innerHTML = icons.right;
  $('hero-previous').addEventListener('click', () => setHero(heroIndex - 1));
  $('hero-next').addEventListener('click', () => setHero(heroIndex + 1));
  $('hero-watchlist').addEventListener('click', toggleWatchlist);
  $('hero-info').addEventListener('click', () => {
    if (selected) window.openModal?.(selected.id, selected.mediaType);
  });
  $('hero-play').addEventListener('click', () => {
    if (!selected) return;
    if (typeof window.openPlayer !== 'function') { $('hero-notice').textContent = 'The player is still loading. Please try again.'; return; }
    window.__fp = { ...selected }; window.openPlayer(window.__fp);
  });
  $('main-content').addEventListener('click', event => {
    const card = event.target.closest('.home-card');
    if (card) { window.openModal?.(Number(card.dataset.id), card.dataset.type); return; }
    const arrow = event.target.closest('[data-rail]');
    if (arrow) {
      const rail = $(arrow.dataset.rail);
      rail.scrollBy({ left: Number(arrow.dataset.direction) * rail.clientWidth * .95, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); return;
    }
    const retry = event.target.closest('[data-retry]');
    if (retry) loadRow(sectionDefinitions.find(definition => definition.id === retry.dataset.retry));
  });
  window.addEventListener('resize', () => document.querySelectorAll('.home-rail').forEach(updateRailControls), { passive: true });
  window.addEventListener('storage', event => { if (event.key === WATCHLIST) refreshWatchlist(); });
  // Details shares this storage key, and a same-tab edit does not emit storage.
  let detailsWasOpen = $('modal-backdrop').classList.contains('open');
  new MutationObserver(() => {
    const detailsOpen = $('modal-backdrop').classList.contains('open');
    if (!detailsOpen) {
      refreshWatchlist();
      if (detailsWasOpen) $('hero-notice').textContent = '';
    }
    detailsWasOpen = detailsOpen;
  })
    .observe($('modal-backdrop'), { attributes: true, attributeFilter: ['class'] });
  refreshWatchlist();
  init().catch(() => {
    heroError(); document.querySelectorAll('.home-rail').forEach(rail => { rail.setAttribute('aria-busy', 'false'); rowState(rail, 'The catalog could not load. Please reload this page.'); });
  });
})();
