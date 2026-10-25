/* Shared public-page ad slots. Each visible placement loads once, near the viewport. */
(() => {
  'use strict';
  if (window.FLIXGX_ADS) return;
  const units = {
    leaderboard: { key: 'd6bdd987fa30fc0cd51e296c2a3ef3ef', width: 728, height: 90 },
    banner: { key: '6842132aa1ac9daec13e889425128969', width: 468, height: 60 },
    rectangle: { key: '5772c798161f08cbc63abda3369a0ffa', width: 300, height: 250 },
    smallTower: { key: '80642cfe67d5b48825c82225597e8e8f', width: 160, height: 300 },
    tower: { key: 'c1280c54d14f852c666738edb62dcc0b', width: 160, height: 600 }
  };
  const nativeKey = '2c3f092b8cbfda1beb23dadb49511a6d';
  const pending = new Set(), initialized = new WeakSet(), nativeFrames = new Map();
  let serial = 0;
  function visible(slot) {
    return slot.isConnected && slot.getClientRects().length && getComputedStyle(slot).display !== 'none' && !slot.closest('[inert]');
  }
  function chosen(slot) {
    if (slot.dataset.ad === 'wide') return slot.clientWidth >= 728 ? 'leaderboard' : slot.clientWidth >= 468 ? 'banner' : 'rectangle';
    if (slot.dataset.ad === 'compact') return slot.clientWidth >= 468 ? 'banner' : 'rectangle';
    return slot.dataset.ad;
  }
  function size(slot) {
    if (slot.dataset.adLoaded) return;
    const type = chosen(slot), unit = units[type];
    slot.dataset.adSize = type;
    slot.style.setProperty('--ad-height', `${unit?.height || 300}px`);
  }
  function mount(slot) {
    if (!visible(slot) || slot.dataset.adLoaded) return;
    const type = chosen(slot), unit = units[type];
    if (!unit && type !== 'native') return;
    slot.dataset.adLoaded = type; pending.delete(slot); observer?.unobserve(slot);
    const stage = slot.querySelector('.site-ad-stage'), frame = document.createElement('iframe');
    frame.title = 'Advertisement'; frame.setAttribute('scrolling', 'no');
    const base = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}*{box-sizing:border-box}</style></head><body>';
    if (unit) {
      frame.width = String(unit.width); frame.height = String(unit.height);
      frame.style.maxWidth = '100%';
      frame.srcdoc = `${base}<div id="ad" style="width:${unit.width}px;height:${unit.height}px;transform-origin:top left"><script>atOptions=${JSON.stringify({ ...unit, format: 'iframe', params: {} })};<\/script><script src="https://bancadeltempoidea.org/22/${unit.key}"><\/script></div><script>function fit(){document.getElementById('ad').style.transform='scale('+Math.min(1,innerWidth/${unit.width})+')'}addEventListener('resize',fit);fit();<\/script></body></html>`;
    } else {
      const id = `flixgx-ad-${++serial}`;
      frame.width = '100%'; frame.height = '300'; nativeFrames.set(frame, id);
      frame.srcdoc = `${base}<style>body{font-family:system-ui,sans-serif;color:#eef1f6}#container-${nativeKey} a,#container-${nativeKey} a *,#container-${nativeKey} p{color:#eef1f6!important;font-family:system-ui,sans-serif!important}#container-${nativeKey} a{text-decoration:none}#container-${nativeKey} a:focus-visible{outline:2px solid #fff;outline-offset:3px}</style><div id="container-${nativeKey}"></div><script async="async" data-cfasync="false" src="https://bancadeltempoidea.org/21/${nativeKey}"><\/script><script>new ResizeObserver(()=>parent.postMessage({kind:'flixgx-ad-height',id:'${id}',height:document.body.scrollHeight},'*')).observe(document.body);<\/script></body></html>`;
    }
    stage.append(frame);
  }
  const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    entries.forEach(entry => { if (entry.isIntersecting) mount(entry.target); });
  }, { rootMargin: '120px 0px' }) : null;
  function scan(root = document) {
    checkPending();
    root.querySelectorAll('[data-ad]').forEach(slot => {
      if (initialized.has(slot)) return;
      initialized.add(slot); pending.add(slot);
      slot.classList.add('site-ad'); slot.setAttribute('aria-label', 'Advertisement');
      const label = document.createElement('span'); label.className = 'site-ad-label'; label.textContent = 'Advertisement';
      const stage = document.createElement('div'); stage.className = 'site-ad-stage';
      slot.append(label, stage); size(slot);
      if (observer) observer.observe(slot); else mount(slot);
    });
  }
  function checkPending() {
    pending.forEach(slot => {
      if (!slot.isConnected) { observer?.unobserve(slot); pending.delete(slot); return; }
      size(slot);
      const box = slot.getBoundingClientRect();
      if (box.bottom > -120 && box.top < innerHeight + 120) mount(slot);
    });
    nativeFrames.forEach((_id, frame) => { if (!frame.isConnected) nativeFrames.delete(frame); });
  }
  addEventListener('resize', checkPending, { passive: true });
  addEventListener('message', event => {
    if (event.data?.kind !== 'flixgx-ad-height') return;
    nativeFrames.forEach((id, frame) => {
      if (event.source !== frame.contentWindow || event.data.id !== id || !frame.isConnected) return;
      const height = Number(event.data.height);
      if (Number.isFinite(height)) frame.height = String(Math.min(1600, Math.max(300, Math.ceil(height))));
    });
  });
  window.FLIXGX_ADS = { scan, refresh: checkPending };
  scan();
})();
