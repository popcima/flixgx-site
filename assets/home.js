/* Home catalog and controls; details and playback use the shared window.tmdb. */
(() => {
  'use strict';
  const API_KEY = '76f5b20391ff39408d52881f31d48412';
  const BASE = 'https://api.themoviedb.org/3', IMAGE = 'https://image.tmdb.org/t/p/';
  const WATCHLIST = 'flixgx.watchlist', WATCH_REGION = 'US';
  const $ = id => document.getElementById(id);
  const requestCache = new Map(), detailCache = new Map(), heroCache = new Map(), curatedCache = new Map();
  const icons = {
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>'
  };
  const rows = [
    { id: 'row-top10', title: 'TOP 10 Today', kind: 'ranked', version: 0 },
    { id: 'row-trending', title: 'Trending Today', kind: 'trending', type: 'movie', version: 0 },
    { id: 'row-provider', title: 'On', kind: 'provider', providerId: 8, version: 0 },
    { id: 'row-toprated', title: 'Top Rated', kind: 'toprated', type: 'movie', version: 0 },
    { id: 'row-genre', title: 'Comedy', kind: 'genre', type: 'movie', genreId: null, genreName: 'Comedy', version: 0 }
  ];
  let configuration = { custom: {}, sections: {} }, heroItems = [], heroIndex = 0, heroVersion = 0, selected = null;
  let providerOptions = null, listState = null;

  async function tmdb(path, params = {}) {
    const url = new URL(BASE + path); url.searchParams.set('api_key', API_KEY);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Title information unavailable (${response.status}).`);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  window.tmdb = tmdb;
  function cached(path, params = {}) {
    const key = path + JSON.stringify(params);
    if (!requestCache.has(key)) requestCache.set(key, tmdb(path, params).catch(error => { requestCache.delete(key); throw error; }));
    return requestCache.get(key);
  }
  function imageURL(path, size = 'w780') { return typeof path === 'string' && /^\/[a-zA-Z0-9._-]+$/.test(path) ? IMAGE + size + path : ''; }
  function savedImageURL(url) { return typeof url === 'string' && /^https:\/\/image\.tmdb\.org\/t\/p\/(?:w\d+|original)\/[a-zA-Z0-9._-]+$/.test(url) ? url : ''; }
  function mediaType(item) {
    if (item?.media_type && !['movie', 'tv'].includes(item.media_type)) return null;
    return item?.media_type || (item?.first_air_date != null ? 'tv' : 'movie');
  }
  function validItem(item) { return item && Number.isSafeInteger(item.id) && item.id > 0 && mediaType(item); }
  function titleOf(item) { return item.title || item.name || 'Untitled'; }
  function yearOf(item) { return (item.release_date || item.first_air_date || '').slice(0, 4); }
  function ratingOf(item) { return Number(item.vote_average) > 0 ? Number(item.vote_average).toFixed(1) : '—'; }
  function span(className, text) { const node = document.createElement('span'); node.className = className; node.textContent = text; return node; }
  function addMeta(parent, parts) {
    parts.filter(Boolean).forEach((part, index) => {
      if (index) parent.append(span('home-dot', '·'));
      parent.append(typeof part === 'string' ? span('', part) : part);
    });
  }
  function rating(item, hero = false) {
    const node = span(hero ? 'home-rating' : '', ''); node.append(span('home-star', '★'), document.createTextNode(ratingOf(item)));
    node.setAttribute('aria-label', `Rating ${ratingOf(item)}`); return node;
  }
  function getTitle(id, type) {
    const key = `${type}/${id}`;
    if (!detailCache.has(key)) detailCache.set(key, tmdb(`/${key}`).then(data => ({ ...data, media_type: type })).catch(error => { detailCache.delete(key); throw error; }));
    return detailCache.get(key);
  }
  function getHeroTitle(item) {
    const type = mediaType(item), key = `${type}/${item.id}`;
    if (!heroCache.has(key)) {
      const promise = detailCache.has(key)
        ? Promise.all([getTitle(item.id, type), tmdb(`/${key}/images`, { include_image_language: 'en,null' })]).then(([details, images]) => ({ ...details, images }))
        : tmdb(`/${key}`, { append_to_response: 'images', include_image_language: 'en,null' }).then(details => ({ ...details, media_type: type }));
      heroCache.set(key, promise.then(details => { detailCache.set(key, Promise.resolve(details)); return details; }).catch(error => { heroCache.delete(key); throw error; }));
    }
    return heroCache.get(key);
  }
  async function results(path, type, params = {}) {
    const response = await cached(path, params);
    return (response.results || []).map(item => ({ ...item, media_type: type || mediaType(item) })).filter(validItem);
  }
  async function resolveReferences(references, supabase = false, type = null) {
    if (!Array.isArray(references) || !references.length) return null;
    const valid = references.map(item => ({ id: Number(supabase ? item.content_id : item.id), type: supabase ? item.content_type : item.media_type }))
      .filter(item => Number.isSafeInteger(item.id) && item.id > 0 && ['movie', 'tv'].includes(item.type) && (!type || item.type === type));
    const items = await Promise.all(valid.map(item => getTitle(item.id, item.type).catch(() => null)));
    return items.filter(validItem);
  }
  function curated(key, type = null) {
    const cacheKey = `${key}/${type || 'all'}`;
    if (!curatedCache.has(cacheKey)) {
      const promise = (async () => {
        const remote = await resolveReferences(configuration.sections[key], true, type);
        if (remote?.length) return remote;
        const local = await resolveReferences(configuration.custom[key], false, type);
        return local?.length ? local : null;
      })();
      curatedCache.set(cacheKey, promise.then(items => { if (!items) curatedCache.delete(cacheKey); return items; }));
    }
    return curatedCache.get(cacheKey);
  }
  async function loadConfiguration() {
    const local = fetch('./data.json').then(response => response.ok ? response.json() : {}).catch(() => ({}));
    let timeout;
    const remote = Promise.race([Promise.resolve().then(() => window.NXSections?.load() || {}), new Promise(resolve => { timeout = setTimeout(() => resolve({}), 10000); })])
      .catch(() => ({})).finally(() => clearTimeout(timeout));
    const [custom, sections] = await Promise.all([local, remote]); return { custom: custom || {}, sections: sections || {} };
  }

  function skeletons() {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 7; index++) {
      const node = document.createElement('div'); node.className = 'home-skeleton'; node.setAttribute('aria-hidden', 'true');
      node.innerHTML = '<div class="home-skeleton-art"></div><div class="home-skeleton-line"></div><div class="home-skeleton-line"></div>'; fragment.append(node);
    }
    return fragment;
  }
  function selectControl(row, label, accessibleLabel) {
    const wrap = span('home-select-wrap', ''), visible = span('home-select-label', label); visible.id = `${row.id}-selection`; visible.setAttribute('aria-hidden', 'true');
    const chevron = span('', ''); chevron.innerHTML = icons.down;
    const select = document.createElement('select'); select.id = `${row.id}-select`; select.dataset.filter = row.id; select.setAttribute('aria-label', accessibleLabel); select.disabled = true;
    const option = document.createElement('option'); option.textContent = label; select.append(option); wrap.append(visible, chevron, select); return wrap;
  }
  function createSections() {
    rows.forEach(row => {
      const section = document.createElement('section'); section.className = 'home-section home-container'; section.setAttribute('aria-labelledby', `${row.id}-heading`);
      const head = document.createElement('div'); head.className = 'home-section-heading';
      const heading = document.createElement('h2'); heading.id = `${row.id}-heading`;
      if (row.kind === 'provider') { heading.append(document.createTextNode('On '), selectControl(row, 'Netflix', 'Streaming service in the United States')); }
      else if (row.kind === 'genre') heading.append(selectControl(row, 'Comedy', 'Genre'));
      else heading.textContent = row.title;
      head.append(heading);
      if (row.type) {
        const tabs = document.createElement('div'); tabs.className = 'home-tabs'; tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', `${row.kind === 'genre' ? 'Genre' : row.title} media type`);
        [['movie', 'Movies'], ['tv', 'Series']].forEach(([type, title]) => {
          const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'home-tab'; tab.textContent = title; tab.dataset.row = row.id; tab.dataset.type = type;
          tab.setAttribute('aria-pressed', String(row.type === type)); tab.setAttribute('aria-controls', row.id); tabs.append(tab);
        }); head.append(tabs);
      }
      const outer = document.createElement('div'); outer.className = 'home-rail-wrap';
      const rail = document.createElement('div'); rail.className = 'home-rail' + (row.kind === 'ranked' ? ' home-rail-ranked' : ''); rail.id = row.id; rail.setAttribute('aria-busy', 'true'); rail.append(skeletons());
      rail.addEventListener('scroll', () => updateRailControls(rail), { passive: true });
      ['left', 'right'].forEach((direction, index) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'home-rail-arrow'; button.disabled = true;
        button.setAttribute('aria-label', `${index ? 'Next' : 'Previous'} ${row.kind === 'provider' ? 'provider' : row.title.toLowerCase()} titles`); button.setAttribute('aria-controls', row.id);
        button.dataset.rail = row.id; button.dataset.direction = index ? '1' : '-1'; button.innerHTML = icons[direction]; outer.append(button);
      });
      outer.append(rail); section.append(head, outer); $('main-content').append(section);
      if (row.id === 'row-top10') { const ad = document.createElement('aside'); ad.dataset.ad = 'wide'; $('main-content').append(ad); }
    });
  }
  function createCard(item, rank = null) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'home-card'; button.dataset.id = item.id; button.dataset.type = mediaType(item);
    button.setAttribute('aria-label', `${rank ? `Number ${rank}. ` : ''}More about ${titleOf(item)}`);
    const art = span('home-card-art', ''), backdrop = imageURL(item.backdrop_path), poster = imageURL(item.poster_path, 'w342');
    const first = rank ? poster || backdrop : backdrop || poster, fallback = rank ? backdrop : poster;
    if (first) {
      const img = new Image(); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = first;
      if (!rank && !backdrop) art.classList.add('is-poster');
      img.addEventListener('error', () => {
        if (fallback && img.src !== fallback) { img.src = fallback; if (!rank) art.classList.add('is-poster'); }
        else { img.remove(); art.classList.add('is-missing'); }
      }); art.append(img);
    } else art.classList.add('is-missing');
    if (rank) { const ribbon = span('home-rank', 'TOP'), number = document.createElement('strong'); number.textContent = String(rank).padStart(2, '0'); ribbon.setAttribute('aria-hidden', 'true'); ribbon.append(number); art.append(ribbon); }
    const meta = span('home-card-meta', ''); addMeta(meta, [rating(item), yearOf(item), mediaType(item) === 'tv' ? 'TV Show' : 'Movie']);
    button.append(art, span('home-card-title', titleOf(item)), meta); return button;
  }
  function updateRailControls(rail) {
    const remaining = rail.scrollWidth - rail.clientWidth, outer = rail.parentElement;
    outer.querySelector('[data-direction="-1"]').disabled = rail.scrollLeft <= 2;
    outer.querySelector('[data-direction="1"]').disabled = remaining <= 2 || rail.scrollLeft >= remaining - 2;
  }
  function rowState(rail, message, retry = false) {
    const state = document.createElement('p'); state.className = 'home-row-state'; state.textContent = message;
    if (retry) { const button = document.createElement('button'); button.type = 'button'; button.className = 'home-retry'; button.dataset.retry = rail.id; button.textContent = 'Try again'; state.append(button); }
    rail.replaceChildren(state);
  }
  function setSelectOptions(row, options, selectedId) {
    const select = $(`${row.id}-select`);
    select.replaceChildren(...options.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; return option; }));
    select.value = String(selectedId); select.disabled = false;
    $(`${row.id}-selection`).textContent = options.find(item => item.id === selectedId)?.name || '';
  }
  async function providers() {
    if (providerOptions) return providerOptions;
    const catalogs = await Promise.all(['movie', 'tv'].map(type => cached(`/watch/providers/${type}`, { watch_region: WATCH_REGION })));
    const catalog = catalogs.flatMap(data => data.results || []);
    // IDs are verified against the current provider catalog, not assumed from a name.
    const preferred = [8, 9, 337, 350, 1899];
    providerOptions = preferred.map(id => catalog.find(item => item.provider_id === id)).filter(Boolean)
      .map(item => ({ id: item.provider_id, name: item.provider_name }));
    if (!providerOptions.length) { providerOptions = null; throw new Error('Streaming services are unavailable.'); }
    return providerOptions;
  }
  function interleave(left, right) {
    const items = [];
    for (let index = 0; index < Math.max(left.length, right.length); index++) { if (left[index]) items.push(left[index]); if (right[index]) items.push(right[index]); }
    return items;
  }
  async function fetchRow(row, version) {
    const type = row.type;
    if (row.kind === 'ranked') {
      const controlled = await curated('trending_week');
      if (controlled?.length >= 10) return controlled.slice(0, 10);
      const daily = await results('/trending/all/day');
      const seen = new Set();
      return [...(controlled || []), ...daily].filter(item => { const key = `${mediaType(item)}/${item.id}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 10);
    }
    if (row.kind === 'trending') return await curated('trending_today', type) || results(`/trending/${type}/day`, type);
    if (row.kind === 'toprated') return results(`/${type}/top_rated`, type);
    if (row.kind === 'provider') {
      const wanted = row.providerId, options = await providers();
      if (version !== row.version) return [];
      const selectedProvider = options.find(item => item.id === wanted) || options[0]; row.providerId = selectedProvider.id;
      setSelectOptions(row, options, selectedProvider.id);
      const params = { with_watch_providers: selectedProvider.id, watch_region: WATCH_REGION, with_watch_monetization_types: 'flatrate', sort_by: 'popularity.desc' };
      const [movies, shows] = await Promise.all([results('/discover/movie', 'movie', params), results('/discover/tv', 'tv', params)]);
      return interleave(movies, shows);
    }
    if (row.kind === 'genre') {
      const desiredId = row.genreId, desiredName = row.genreName, priorType = row.genreType;
      const data = await cached(`/genre/${type}/list`), genres = (data.genres || []).filter(item => Number.isSafeInteger(item.id) && typeof item.name === 'string');
      if (!genres.length) throw new Error('Genres are unavailable.');
      if (version !== row.version) return [];
      const genre = (priorType === type && genres.find(item => item.id === desiredId)) || genres.find(item => item.name === desiredName) || genres.find(item => item.name === 'Comedy') || genres[0];
      row.genreId = genre.id; row.genreName = genre.name; row.genreType = type; setSelectOptions(row, genres, genre.id);
      return results(`/discover/${type}`, type, { with_genres: genre.id, sort_by: 'popularity.desc' });
    }
    return [];
  }
  async function loadRow(row) {
    const version = ++row.version, rail = $(row.id); rail.setAttribute('aria-busy', 'true'); rail.replaceChildren(skeletons()); rail.scrollLeft = 0;
    if (row.kind === 'genre') $(`${row.id}-select`).disabled = true;
    updateRailControls(rail);
    try {
      const items = (await fetchRow(row, version)).filter(validItem).slice(0, row.kind === 'ranked' ? 10 : 20);
      if (version !== row.version) return [];
      if (items.length) rail.replaceChildren(...items.map((item, index) => createCard(item, row.kind === 'ranked' ? index + 1 : null)));
      else rowState(rail, row.kind === 'provider' ? 'No titles are available for this service in the United States.' : 'No titles are available for this selection yet.');
      return items;
    } catch {
      if (version === row.version) rowState(rail, 'These titles could not load. Please try again.', true);
      return [];
    } finally {
      if (version === row.version) { rail.setAttribute('aria-busy', 'false'); updateRailControls(rail); }
    }
  }

  function setHeroBusy(busy) {
    $('hero').setAttribute('aria-busy', String(busy));
    ['hero-play', 'hero-info'].forEach(id => { $(id).disabled = busy || !selected; });
  }
  function renderHeroCopy(item) {
    $('hero-heading').replaceChildren(document.createTextNode(titleOf(item)));
    $('hero-description').textContent = item.overview || '';
    const metadata = $('hero-meta'); metadata.replaceChildren();
    const genres = (item.genres || []).slice(0, 2).map(genre => genre.name).filter(Boolean);
    addMeta(metadata, [rating(item, true), yearOf(item), ...genres]);
  }
  function renderHeroArt(item, version) {
    const art = $('hero-bg'), backdrop = imageURL(item.backdrop_path, 'original'), poster = imageURL(item.poster_path, 'original');
    art.classList.remove('is-loaded'); art.onload = null; art.onerror = null;
    if (!backdrop && !poster) { art.removeAttribute('src'); return; }
    art.onload = () => { if (version === heroVersion) art.classList.add('is-loaded'); };
    art.onerror = () => { if (version !== heroVersion) return; if (poster && art.src !== poster) art.src = poster; else { art.removeAttribute('src'); art.classList.remove('is-loaded'); } };
    art.src = backdrop || poster; if (art.complete && art.naturalWidth) art.classList.add('is-loaded');
  }
  function createHeroDots() {
    $('hero-dots').replaceChildren(...heroItems.map((item, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'home-featured-dot'; button.dataset.slide = index;
      button.setAttribute('aria-label', `Show featured title ${index + 1}: ${titleOf(item)}`); button.setAttribute('aria-current', String(index === heroIndex)); return button;
    }));
  }
  async function setHero(index) {
    if (!heroItems.length) return;
    const version = ++heroVersion; heroIndex = (index + heroItems.length) % heroItems.length;
    const item = heroItems[heroIndex]; selected = null; setHeroBusy(true);
    $('hero-notice').textContent = ''; $('hero-error').hidden = true; $('hero-actions').hidden = false;
    $('hero-dots').querySelectorAll('button').forEach((button, dot) => button.setAttribute('aria-current', String(dot === heroIndex)));
    ['hero-previous', 'hero-next'].forEach(id => { $(id).disabled = heroItems.length < 2; });
    renderHeroCopy(item); renderHeroArt(item, version);
    const details = await getHeroTitle(item).catch(() => item);
    if (version !== heroVersion) return;
    renderHeroCopy(details);
    const logos = details.images?.logos || [], logo = logos.find(image => image.iso_639_1 === 'en') || logos.find(image => !image.iso_639_1), logoURL = imageURL(logo?.file_path, 'w500');
    if (logoURL) {
      const image = new Image(); image.className = 'home-hero-logo'; image.alt = titleOf(details); image.decoding = 'async';
      image.onload = () => { if (version === heroVersion) $('hero-heading').replaceChildren(image); }; image.src = logoURL;
    }
    selected = { id: item.id, mediaType: mediaType(item), title: titleOf(details), subtitle: yearOf(details), backdropUrl: imageURL(details.backdrop_path, 'original'), posterUrl: imageURL(details.poster_path, 'w500'), seasons: details.seasons || [] };
    setHeroBusy(false); $('hero-announcement').textContent = `Featured ${heroIndex + 1} of ${heroItems.length}: ${selected.title}`;
  }
  function heroError() {
    selected = null; setHeroBusy(false); $('hero-actions').hidden = true; $('hero-heading').textContent = 'Discover your next watch.';
    $('hero-description').textContent = ''; $('hero-meta').replaceChildren(); $('hero-error').hidden = false; $('hero-previous').disabled = true; $('hero-next').disabled = true;
  }
  async function loadFeatured(rankedPromise) {
    $('hero-retry').disabled = true;
    try {
      const controlled = await resolveReferences(configuration.sections.hero, true);
      const items = controlled?.length ? controlled : await (rankedPromise || fetchRow(rows[0], rows[0].version));
      heroItems = items.filter(validItem).slice(0, 6); heroIndex = 0; createHeroDots();
      if (heroItems.length) await setHero(0); else heroError();
    } catch { heroError(); }
    finally { $('hero-retry').disabled = false; }
  }

  function watchlist() {
    try {
      const items = JSON.parse(localStorage.getItem(WATCHLIST) || '[]');
      return Array.isArray(items) ? items.filter(item => item && Number.isSafeInteger(item.id) && item.id > 0 && ['movie', 'tv'].includes(item.mediaType)) : [];
    } catch { return []; }
  }
  function renderList() {
    const items = watchlist(), container = $('home-list-items'); container.replaceChildren();
    $('home-list-count').textContent = `${items.length} saved ${items.length === 1 ? 'title' : 'titles'}`;
    $('home-list-empty').hidden = items.length > 0; container.hidden = !items.length;
    items.forEach(item => {
      const row = document.createElement('li'); row.className = 'home-list-item';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'home-list-open'; open.dataset.savedOpen = item.id; open.dataset.type = item.mediaType;
      const title = typeof item.title === 'string' ? item.title : 'Untitled'; open.setAttribute('aria-label', `Open ${title}`);
      const art = span('home-list-art', ''), url = savedImageURL(item.posterUrl);
      if (url) { const image = new Image(); image.alt = ''; image.src = url; image.loading = 'lazy'; image.onerror = () => image.remove(); art.append(image); }
      const copy = span('', ''); copy.append(span('home-list-title', title), span('home-list-type', item.mediaType === 'tv' ? 'TV Show' : 'Movie')); open.append(art, copy);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'home-list-remove'; remove.dataset.savedRemove = item.id; remove.dataset.type = item.mediaType; remove.setAttribute('aria-label', `Remove ${title} from My List`); remove.innerHTML = icons.close;
      row.append(open, remove); container.append(row);
    });
  }
  function restoreList() {
    if (!listState) return;
    document.body.style.overflow = listState.overflow;
    const focus = listState.focus; listState = null;
    $('home-list-toggle').setAttribute('aria-expanded', 'false');
    if (focus?.isConnected) focus.focus({ preventScroll: true });
  }
  function closeList() { if ($('home-list').open) $('home-list').close(); restoreList(); }
  function openList() {
    if ($('home-list').open) return;
    listState = { overflow: document.body.style.overflow, focus: document.activeElement };
    renderList(); $('home-list-notice').textContent = ''; document.body.style.overflow = 'hidden';
    $('home-list').showModal(); $('home-list-toggle').setAttribute('aria-expanded', 'true'); $('home-list-close').focus();
  }
  $('home-list-toggle').addEventListener('click', openList);
  $('home-list-close').innerHTML = icons.close; $('home-list-close').addEventListener('click', closeList);
  $('home-list').addEventListener('cancel', event => { event.preventDefault(); closeList(); });
  $('home-list').addEventListener('close', () => { if (!$('home-list').open) restoreList(); });
  $('home-list').addEventListener('click', event => {
    const dialog = $('home-list');
    if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeList(); }
    const open = event.target.closest('[data-saved-open]');
    if (open) { const id = Number(open.dataset.savedOpen), type = open.dataset.type; closeList(); window.openModal?.(id, type); return; }
    const remove = event.target.closest('[data-saved-remove]');
    if (remove) {
      const items = watchlist(), id = Number(remove.dataset.savedRemove), type = remove.dataset.type, index = items.findIndex(item => item.id === id && item.mediaType === type);
      try {
        localStorage.setItem(WATCHLIST, JSON.stringify(items.filter(item => item.id !== id || item.mediaType !== type))); renderList(); $('home-list-notice').textContent = 'Removed from My List';
        const buttons = $('home-list-items').querySelectorAll('[data-saved-remove]'); (buttons[Math.min(index, buttons.length - 1)] || $('home-list-close')).focus();
      } catch { $('home-list-notice').textContent = 'Your browser could not update My List.'; }
    }
  });
  window.addEventListener('storage', event => { if ((event.key === WATCHLIST || event.key === null) && $('home-list').open) renderList(); });
  let detailsWasOpen = $('modal-backdrop').classList.contains('open');
  new MutationObserver(() => {
    const detailsOpen = $('modal-backdrop').classList.contains('open');
    if (!detailsOpen && detailsWasOpen) { $('hero-notice').textContent = ''; if ($('home-list').open) renderList(); }
    detailsWasOpen = detailsOpen;
  }).observe($('modal-backdrop'), { attributes: true, attributeFilter: ['class'] });

  $('hero-previous').innerHTML = icons.left; $('hero-next').innerHTML = icons.right;
  $('hero-previous').addEventListener('click', () => setHero(heroIndex - 1)); $('hero-next').addEventListener('click', () => setHero(heroIndex + 1));
  $('hero-dots').addEventListener('click', event => { const button = event.target.closest('[data-slide]'); if (button) setHero(Number(button.dataset.slide)); });
  $('hero-info').addEventListener('click', () => { if (selected) window.openModal?.(selected.id, selected.mediaType); });
  $('hero-play').addEventListener('click', () => {
    if (!selected) return;
    if (typeof window.openPlayer !== 'function') { $('hero-notice').textContent = 'The player is still loading. Please try again.'; return; }
    window.__fp = { ...selected }; window.openPlayer(window.__fp);
  });
  $('hero-retry').addEventListener('click', () => loadFeatured());
  $('main-content').addEventListener('click', event => {
    const card = event.target.closest('.home-card');
    if (card) { window.openModal?.(Number(card.dataset.id), card.dataset.type); return; }
    const tab = event.target.closest('.home-tab');
    if (tab) {
      const row = rows.find(item => item.id === tab.dataset.row);
      if (row.type === tab.dataset.type) return;
      row.type = tab.dataset.type; tab.parentElement.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button === tab))); loadRow(row); return;
    }
    const arrow = event.target.closest('[data-rail]');
    if (arrow) { const rail = $(arrow.dataset.rail); rail.scrollBy({ left: Number(arrow.dataset.direction) * rail.clientWidth * .9, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); return; }
    const retry = event.target.closest('[data-retry]'); if (retry) loadRow(rows.find(row => row.id === retry.dataset.retry));
  });
  $('main-content').addEventListener('change', event => {
    const select = event.target.closest('[data-filter]'); if (!select) return;
    const row = rows.find(item => item.id === select.dataset.filter);
    if (row.kind === 'provider') row.providerId = Number(select.value);
    else { row.genreId = Number(select.value); row.genreName = select.selectedOptions[0]?.textContent || 'Comedy'; }
    loadRow(row);
  });
  function updateHeader() { $('home-header').classList.toggle('is-scrolled', window.scrollY > 24); }
  window.addEventListener('scroll', updateHeader, { passive: true }); updateHeader();
  window.addEventListener('resize', () => document.querySelectorAll('.home-rail').forEach(updateRailControls), { passive: true });
  async function init() {
    createSections(); configuration = await loadConfiguration();
    const loading = rows.map(loadRow); await loadFeatured(loading[0]);
  }
  init().catch(() => {
    heroError(); document.querySelectorAll('.home-rail').forEach(rail => { rail.setAttribute('aria-busy', 'false'); rowState(rail, 'The catalog could not load. Please reload this page.'); });
  });
})();
