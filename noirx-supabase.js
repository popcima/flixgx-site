/**
 * NoirX ↔ Supabase bridge (public, read-only usage on site pages)
 * Requires the supabase-js UMD build to be loaded first, e.g.:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
 *   <script src="noirx-supabase.js"></script>
 *
 * Exposes:
 *   window.nxsb                     — the Supabase client
 *   window.NXIntro.loadIntroConfig()      — loads intro tables into memory
 *   window.NXIntro.resolveOverride(id,type,companies) — DB override URL or null
 *   window.NXIntro.resolveIntroUrl(id,type,companies) — full resolve incl. default
 *   window.NXSections.load()        — { section_key: [rows...] } ordered by sort_order
 */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://rpzsyxwbqcxyhzaoipft.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_STYoS0fJcDv_KEfzHk22sQ_5S5UlQxn';

  window.NX_SUPABASE = { url: SUPABASE_URL, key: SUPABASE_KEY };

  var sb = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;
  window.nxsb = sb;

  // ─── Intro resolver ────────────────────────────────────────────────
  var contentMap = {};   // "movie-123" → url
  var companyMap = {};   // "marvel studios" → url
  var defaultUrl = null; // from default_intro table (may be null)
  var loaded = false;

  async function loadIntroConfig() {
    if (!sb) return;
    try {
      var res = await Promise.all([
        sb.from('content_intros').select('*'),
        sb.from('company_intros').select('*'),
        sb.from('default_intro').select('*').eq('id', 1).single()
      ]);
      var c = res[0], co = res[1], d = res[2];
      if (c.data) {
        contentMap = {};
        c.data.forEach(function (r) { contentMap[r.content_type + '-' + r.content_id] = r.intro_url; });
      }
      if (co.data) {
        companyMap = {};
        co.data.forEach(function (r) { companyMap[(r.company_name || '').toLowerCase()] = r.intro_url; });
      }
      if (d.data && d.data.intro_url) defaultUrl = d.data.intro_url;
      loaded = true;
    } catch (e) {
      console.warn('[NoirX] intro config load failed:', e && e.message);
    }
  }

  // Returns a DB override (content-specific, then company match) or null.
  // Deliberately does NOT fall back to default — the caller keeps its own
  // local fallback (NoirX's pickSrc studio clips).
  function resolveOverride(id, type, companies) {
    if (id != null && type) {
      var k = type + '-' + id;
      if (contentMap[k]) return contentMap[k];
    }
    var list = companies || [];
    for (var i = 0; i < list.length; i++) {
      var name = (list[i] && list[i].name || '').toLowerCase();
      if (!name) continue;
      if (companyMap[name]) return companyMap[name];
      for (var key in companyMap) {
        if (name.indexOf(key) !== -1 || key.indexOf(name) !== -1) return companyMap[key];
      }
    }
    return null;
  }

  // Full resolve incl. DB default — used by the admin's Content Preview.
  function resolveIntroUrl(id, type, companies) {
    return resolveOverride(id, type, companies) || defaultUrl || null;
  }

  window.NXIntro = {
    loadIntroConfig: loadIntroConfig,
    resolveOverride: resolveOverride,
    resolveIntroUrl: resolveIntroUrl,
    isLoaded: function () { return loaded; },
    getDefault: function () { return defaultUrl; }
  };

  // ─── Home sections ─────────────────────────────────────────────────
  async function loadHomeSections() {
    if (!sb) return {};
    try {
      var r = await sb.from('home_sections').select('*').order('sort_order', { ascending: true });
      var out = {};
      (r.data || []).forEach(function (row) {
        (out[row.section_key] = out[row.section_key] || []).push(row);
      });
      return out;
    } catch (e) {
      console.warn('[NoirX] home_sections load failed:', e && e.message);
      return {};
    }
  }

  window.NXSections = { load: loadHomeSections };

})();
