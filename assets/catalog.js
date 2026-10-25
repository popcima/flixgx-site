/* Shared Movies / Series catalog; detail and player implementations stay independent. */
(() => {
  'use strict';
  const type = document.body.dataset.catalog === 'tv' ? 'tv' : 'movie';
  const grid = document.getElementById('movie-grid'), count = document.getElementById('results-count');
  const more = document.getElementById('lm-btn'), moreWrap = document.getElementById('lm-wrap');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const image = path => /^\/[a-zA-Z0-9._-]+$/.test(path || '') ? `https://image.tmdb.org/t/p/w780${path}` : '';
  let genre = '', sort = 'popularity.desc', status = '', page = 1, totalPages = 1, busy = false, request = 0, items = [];
  window.tmdb = async (path, params = {}) => {
    const url = new URL('https://api.themoviedb.org/3' + path);
    url.searchParams.set('api_key', '76f5b20391ff39408d52881f31d48412');
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url);
    if (!response.ok) throw new Error('Catalog unavailable');
    return response.json();
  };
  function render() {
    grid.innerHTML = items.map(item => {
      const id = Number(item.id); if (!Number.isSafeInteger(id) || id < 1) return '';
      const title = item.title || item.name || 'Untitled', art = image(item.backdrop_path) || image(item.poster_path), fallback = image(item.poster_path);
      const year = (item.release_date || item.first_air_date || '').slice(0, 4);
      const rating = Number(item.vote_average) > 0 ? Number(item.vote_average).toFixed(1) : '—';
      return `<button type="button" class="movie-card" data-title-id="${id}" aria-label="More about ${esc(title)}"><span class="card-thumb">${art ? `<img src="${art}" alt="" loading="lazy" ${fallback && fallback !== art ? `data-fallback="${fallback}"` : ''}>` : ''}</span><span class="card-info"><span class="card-name">${esc(title)}</span><span class="card-meta"><span class="card-star" aria-hidden="true">★</span><span>${rating}</span>${year ? `<span class="card-dot">·</span><span>${esc(year)}</span>` : ''}<span class="card-dot">·</span><span>${type === 'tv' ? 'TV Show' : 'Movie'}</span></span><span class="card-overview">${esc(item.overview || '')}</span></span></button>`;
    }).join('');
    if (!items.length) grid.innerHTML = '<div class="catalog-message"><p>No titles match these filters. Try another genre or sort order.</p></div>';
  }
  async function load(reset = false) {
    if (busy && !reset) return;
    const token = ++request; busy = true;
    if (reset) { page = 1; items = []; grid.innerHTML = Array.from({length: 9}, () => '<div class="catalog-skeleton" aria-hidden="true"></div>').join(''); count.textContent = 'Loading titles…'; moreWrap.style.display = 'none'; }
    grid.setAttribute('aria-busy', 'true'); more.disabled = true; more.querySelector('.lm-text').textContent = 'Loading…';
    const params = { sort_by: sort, page, 'vote_count.gte': type === 'tv' ? 20 : 30 };
    if (genre) params.with_genres = genre;
    const statuses = { 'Returning Series': 0, Ended: 3, Canceled: 4 };
    if (type === 'tv' && status in statuses) params.with_status = statuses[status];
    if (type === 'tv' && status === 'Miniseries') params.with_type = 2;
    try {
      const data = await window.tmdb(`/discover/${type}`, params);
      if (token !== request) return;
      if (!Array.isArray(data.results)) throw new Error('Invalid catalog response');
      const seen = new Set(items.map(item => item.id));
      items.push(...data.results.filter(item => !seen.has(item.id)));
      totalPages = Math.min(Number(data.total_pages) || 1, 500); page++;
      count.innerHTML = `<strong>${Number(data.total_results || 0).toLocaleString()}</strong> ${type === 'tv' ? 'series' : 'movies'}`;
      render(); moreWrap.style.display = page <= totalPages ? 'flex' : 'none';
    } catch {
      if (token !== request) return;
      count.textContent = 'Couldn’t load titles';
      if (reset) grid.innerHTML = '<div class="catalog-message"><p>Check your connection and try again.</p><button class="catalog-retry" type="button">Try again</button></div>';
      else more.querySelector('.lm-text').textContent = 'Try loading more again';
    } finally {
      if (token === request) { busy = false; grid.setAttribute('aria-busy', 'false'); more.disabled = false; if (more.querySelector('.lm-text').textContent === 'Loading…') more.querySelector('.lm-text').textContent = 'Load More'; }
    }
  }
  function activate(selector, target) {
    document.querySelectorAll(selector).forEach(button => { const active = button === target; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  }
  window.selectGenre = (button, value) => { activate('.genre-chip', button); genre = value; void load(true); };
  window.selectStatus = (button, value) => { activate('.status-chip', button); status = value; void load(true); };
  window.onSort = () => { sort = document.getElementById('sort-select').value; void load(true); };
  window.setView = (view, button) => { activate('.view-btn', button); grid.classList.toggle('is-list', view === 'list'); };
  window.loadMore = () => void load(false);
  grid.addEventListener('click', event => {
    const card = event.target.closest('[data-title-id]');
    if (card) window.openModal?.(Number(card.dataset.titleId), type);
    else if (event.target.closest('.catalog-retry')) void load(true);
  });
  grid.addEventListener('error', event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.dataset.fallback) { img.src = img.dataset.fallback; delete img.dataset.fallback; } else img.remove();
  }, true);
  void load(true);
})();
