// Essence content script.
// Principle: the page's own DOM is never modified. Icons and the result popup live in a
// single overlay element (shadow DOM) appended to <html>, positioned over the page.
// detect.js runs before this file (see manifest) and provides globalThis.EssenceDetect.
(async () => {
  const shared = await import(chrome.runtime.getURL('src/shared.js'));
  const { DEFAULT_SETTINGS, sha256, isDomainExcluded, predictInterest } = shared;

  const ROOT_ATTR = 'data-essence-root';
  const ICON_SIZE = 26;
  // Settings that only change what the popup shows.
  const DISPLAY_KEYS = ['showInterestScore', 'showKeyPoints', 'showTopics', 'showConclusion'];

  let settings = { ...DEFAULT_SETTINGS };
  let anchored = new WeakSet();       // page elements that already have an icon
  const processed = new Set();        // content hashes that already have an icon
  const entries = new Map();          // hash -> { anchor, textNode, text, icon, result, prediction, rating, error, loading }
  let activeHash = null;              // hash shown in the popup
  let observer = null; let scanScheduled = false; let positionTimer = null; let frameRequested = false;
  let host = null; let layer = null; let popupEl = null;

  const detector = globalThis.EssenceDetect.createDetector({ getMinimum: () => settings.minimumCharacters, isAnchored: (el) => anchored.has(el) });

  async function loadSettings() {
    const stored = await chrome.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  }

  function isActive() { return settings.enabled && !isDomainExcluded(settings.excludedDomains, location.href); }

  function applyActivation() {
    if (!isActive()) {
      observer?.disconnect(); observer = null;
      removeAll();
      return;
    }
    if (!observer) {
      observer = new MutationObserver((records) => { if (records.some(isForeignMutation)) scheduleScan(); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    scheduleScan();
  }

  // Our overlay is a direct child of <html>; adding or removing it must not trigger a rescan.
  function isForeignMutation(record) {
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return nodes.length > 0 && nodes.some((node) => !(node instanceof Element && node.hasAttribute(ROOT_ATTR)));
  }

  const debouncedScan = debounce(() => {
    const run = () => { scanScheduled = false; scan().catch(() => {}); };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2000 }); else run();
  }, 1000);
  function scheduleScan() { if (scanScheduled) return; scanScheduled = true; debouncedScan(); }
  function debounce(fn, wait) { let timer; return () => { clearTimeout(timer); timer = setTimeout(fn, wait); }; }

  async function scan() {
    if (!isActive()) return;
    for (const element of detector.collectCandidates()) {
      if (!element.isConnected || anchored.has(element)) continue;
      const text = detector.candidateText(element);
      if (!detector.textLengthOk(text)) continue;
      const hash = await sha256(text);
      if (processed.has(hash)) continue;
      processed.add(hash); anchored.add(element);
      addIcon(hash, element, text);
    }
    schedulePosition();
  }

  // --- Overlay ---------------------------------------------------------------

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement('essence-overlay');
    host.setAttribute(ROOT_ATTR, '');
    host.style.cssText = 'all:initial !important;position:absolute !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;overflow:visible !important;z-index:2147483647 !important;pointer-events:none !important;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial}
      .icon{position:absolute;width:${ICON_SIZE}px;height:${ICON_SIZE}px;padding:0;border:1px solid #dbe3ef;border-radius:50%;background:#fff;color:#2563eb;cursor:pointer;display:grid;place-items:center;pointer-events:auto;box-shadow:0 1px 4px #0f172a26}
      .icon:hover,.icon.active{background:#eff6ff;border-color:#2563eb}
      .icon[hidden]{display:none}
      .icon svg{width:17px;height:17px;display:block}
      .popup{position:fixed;top:16px;right:16px;width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;pointer-events:auto;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2937;background:#f8fbff;border:1px solid #dbe3ef;border-radius:12px;box-shadow:0 12px 40px #0f172a33;padding:14px 16px 16px}
      .popup[hidden]{display:none}
      header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
      header h3{margin:0;font-size:15px;flex:1}
      .close{border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#64748b;padding:2px 6px;border-radius:6px}
      .close:hover{background:#e2e8f0}
      .source{font-size:12px;color:#64748b;margin:0 0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      h4{margin:10px 0 4px;font-size:14px} p{margin:4px 0} ul{margin:6px 0;padding-left:20px}
      .muted{color:#64748b}.score{font-weight:700;color:#2563eb}
      .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
      .actions button,.retry{font:inherit;border:1px solid #cbd5e1;border-radius:8px;background:#fff;padding:6px 10px;cursor:pointer}
      .actions button:hover:not(:disabled),.retry:hover{background:#eff6ff}
      .actions button:disabled{cursor:default;opacity:.55}
      .actions button.chosen{opacity:1;border-color:#2563eb;background:#eff6ff}
    </style><div class="layer"></div><section class="popup" role="dialog" aria-label="Essence" hidden></section>`;
    layer = root.querySelector('.layer');
    popupEl = root.querySelector('.popup');
    // Keep every interaction with the overlay away from the page's own handlers.
    for (const type of ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown']) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
    document.documentElement.appendChild(host);
    window.addEventListener('scroll', schedulePosition, { capture: true, passive: true });
    window.addEventListener('resize', schedulePosition, { passive: true });
    document.addEventListener('keydown', onKeydown, true);
    // Content moves when images or ads load; keep icons aligned.
    positionTimer = setInterval(schedulePosition, 1500);
  }

  function addIcon(hash, anchor, text) {
    const textNode = detector.findInsertionPoint(anchor);
    if (!textNode) return false;
    ensureHost();
    const icon = document.createElement('button');
    icon.className = 'icon'; icon.title = 'Analyze with Essence'; icon.setAttribute('aria-label', 'Analyze with Essence');
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    icon.addEventListener('click', (event) => { event.preventDefault(); openEntry(hash); });
    layer.appendChild(icon);
    // Short label for the popup: the paragraph (or title) the icon points at.
    const block = textNode?.parentElement?.closest('h1, h2, p, li, blockquote') || anchor;
    const snippet = globalThis.EssenceDetect.normalizeText(block.textContent).slice(0, 120) || text.slice(0, 120);
    entries.set(hash, { anchor, textNode, text, snippet, icon });
    return true;
  }

  function schedulePosition() {
    if (frameRequested || !entries.size) return;
    frameRequested = true;
    requestAnimationFrame(() => { frameRequested = false; positionIcons(); });
  }

  function positionIcons() {
    for (const [hash, entry] of entries) {
      if (!entry.anchor.isConnected) { // the article was removed (e.g. SPA navigation)
        entry.icon.remove(); entries.delete(hash); processed.delete(hash);
        if (activeHash === hash) closePopup();
        continue;
      }
      const rect = startRect(entry);
      // Show the icon only while the start of its text is actually visible: not scrolled out of
      // the viewport or out of an inner scroll container, and not covered by a sticky header.
      if (!rect || !isStartVisible(rect, entry.anchor)) { entry.icon.hidden = true; continue; }
      entry.icon.hidden = false;
      // To the left of the first line when there is room, otherwise just above it.
      let x = rect.left - ICON_SIZE - 8; let y = rect.top + (Math.min(rect.height, 40) - ICON_SIZE) / 2;
      if (x < 4) { x = rect.left; y = rect.top - ICON_SIZE - 4; }
      entry.icon.style.left = `${Math.round(x + window.scrollX)}px`;
      entry.icon.style.top = `${Math.round(y + window.scrollY)}px`;
    }
  }

  function isStartVisible(rect, anchor) {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const x = rect.left + Math.min(rect.width / 2, 4);
    const y = rect.top + Math.min(rect.height / 2, 10);
    if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (hit === host || anchor.contains(hit)));
  }

  function startRect(entry) {
    const node = entry.textNode;
    if (node?.isConnected && entry.anchor.contains(node)) {
      const offset = node.nodeValue.search(/\S/);
      if (offset >= 0) {
        const range = document.createRange();
        range.setStart(node, offset); range.setEnd(node, Math.min(node.nodeValue.length, offset + 1));
        const rect = range.getClientRects()[0];
        if (rect && (rect.width || rect.height)) return rect;
      }
    }
    const rect = entry.anchor.getBoundingClientRect();
    return rect.width || rect.height ? rect : null;
  }

  // --- Popup -----------------------------------------------------------------

  function onKeydown(event) { if (event.key === 'Escape' && activeHash) closePopup(); }

  function closePopup() {
    if (!popupEl) return;
    popupEl.hidden = true; popupEl.innerHTML = '';
    entries.get(activeHash)?.icon.classList.remove('active');
    activeHash = null;
  }

  function openEntry(hash) {
    const entry = entries.get(hash);
    if (!entry) return;
    if (activeHash && activeHash !== hash) entries.get(activeHash)?.icon.classList.remove('active');
    activeHash = hash; entry.icon.classList.add('active');
    if (!entry.result && !entry.loading) analyze(hash);
    renderPopup();
  }

  async function analyze(hash) {
    const entry = entries.get(hash);
    entry.loading = true; entry.error = null;
    try {
      if (!globalThis.chrome?.runtime?.id) throw new Error('Essence was updated or reloaded. Reload the page.');
      const result = await chrome.runtime.sendMessage({ type: 'ANALYZE', text: entry.text, title: document.title, url: location.href });
      if (!result) throw new Error('No response from Essence. Reload the page.');
      if (result.error) throw new Error(result.error);
      const { feedback = {} } = await chrome.storage.local.get('feedback');
      entry.result = result;
      entry.prediction = predictInterest(result, Object.values(feedback));
      entry.rating = feedback[hash]?.rating;
    } catch (error) {
      entry.error = error.message;
    } finally {
      entry.loading = false;
      if (activeHash === hash) renderPopup();
    }
  }

  function renderPopup() {
    const entry = entries.get(activeHash);
    if (!entry || !popupEl) return;
    const snippet = escapeHtml(entry.snippet);
    let body;
    if (entry.loading) body = '<p class="muted">⏳ Analyzing…</p>';
    else if (entry.error) body = `<p class="muted">${escapeHtml(entry.error)}</p><button class="retry" data-retry>Retry</button>`;
    else body = resultHtml(entry);
    popupEl.innerHTML = `<header><h3>Essence</h3><button class="close" data-close aria-label="Close" title="Close (Esc)">×</button></header><p class="source" title="${snippet}">${snippet}…</p>${body}`;
    popupEl.hidden = false;
    popupEl.querySelector('[data-close]').addEventListener('click', closePopup);
    popupEl.querySelector('[data-retry]')?.addEventListener('click', () => { analyze(activeHash); renderPopup(); });
    popupEl.querySelectorAll('[data-rating]').forEach((button) => {
      if (entry.rating) { button.disabled = true; if (button.dataset.rating === entry.rating) button.classList.add('chosen'); }
      button.addEventListener('click', () => rate(activeHash, button.dataset.rating));
    });
  }

  function resultHtml(entry) {
    const { result, prediction, rating } = entry;
    let score = '';
    if (settings.showInterestScore) {
      score = prediction?.score == null
        ? '<p class="muted">Rate at least 3 texts for a personalized score.</p>'
        : `<p><span class="score">Interest: ${prediction.score}/100</span>${prediction.reasons.length ? ` <span class="muted">(${prediction.reasons.map(escapeHtml).join(', ')})</span>` : ''}</p>`;
    }
    const extras = `${settings.showKeyPoints ? list('Key points', result.key_points) : ''}${settings.showTopics ? list('Topics', result.topics) : ''}${settings.showConclusion && result.conclusion ? `<h4>Conclusion</h4><p>${escapeHtml(result.conclusion)}</p>` : ''}`;
    return `${score}<p>${escapeHtml(result.essence || '')}</p>${extras}<div class="actions"><button data-rating="interesting">⭐ Interesting</button><button data-rating="boring">💤 Boring</button></div><p class="muted" data-status>${rating ? 'Saved locally.' : ''}</p>`;
  }

  function list(label, values) { return values?.length ? `<h4>${label}</h4><ul>${values.slice(0, 5).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''; }

  async function rate(hash, rating) {
    const entry = entries.get(hash);
    if (!entry?.result || entry.rating) return;
    entry.rating = rating;
    if (activeHash === hash) renderPopup();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'RATE', hash, rating, topics: entry.result.topics, keywords: entry.result.keywords });
      if (response?.error) throw new Error(response.error);
    } catch (error) {
      entry.rating = undefined;
      if (activeHash === hash) { renderPopup(); const status = popupEl.querySelector('[data-status]'); if (status) status.textContent = `Could not save: ${error.message}`; }
    }
  }

  function removeAll() {
    host?.remove(); host = null; layer = null; popupEl = null;
    clearInterval(positionTimer); positionTimer = null;
    window.removeEventListener('scroll', schedulePosition, { capture: true });
    window.removeEventListener('resize', schedulePosition);
    document.removeEventListener('keydown', onKeydown, true);
    entries.clear(); processed.clear(); anchored = new WeakSet(); activeHash = null;
  }

  function escapeHtml(x) { return String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }

  // Start only after everything above is initialized.
  settings = await loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const previous = settings;
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    const changed = Object.keys(settings).filter((key) => JSON.stringify(settings[key]) !== JSON.stringify(previous[key]));
    if (!changed.length) return;
    if (changed.every((key) => DISPLAY_KEYS.includes(key))) { if (activeHash) renderPopup(); return; }
    removeAll();
    applyActivation();
  });
  applyActivation();
})().catch((error) => console.warn('[Essence] content script failed to start:', error));
