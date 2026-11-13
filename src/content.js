// Content scripts cannot be ES modules, so the shared module is loaded with
// dynamic import() (listed in web_accessible_resources in the manifest).
(async () => {
  const shared = await import(chrome.runtime.getURL('src/shared.js'));
  const { DEFAULT_SETTINGS, normalizeText, sha256, isDomainExcluded, predictInterest, MAX_TEXT_LENGTH } = shared;

  const PANEL_ATTR = 'data-essence-panel';
  const TRIGGER_ATTR = 'data-essence-trigger';
  const ANCHOR_ATTR = 'data-essence-anchor';
  const HIDDEN_ATTR = 'data-essence-hidden';
  const OWN_SELECTOR = `[${PANEL_ATTR}], [${TRIGGER_ATTR}]`;
  // Settings that only change how a finished panel looks; panels are re-rendered, not removed.
  const DISPLAY_KEYS = ['showInterestScore', 'showKeyPoints', 'showTopics', 'showConclusion', 'displayMode'];

  const processed = new Set();
  const panels = new Map(); // hash -> { panel, result, prediction, original }
  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let scanScheduled = false;
  const detector = globalThis.EssenceDetect.createDetector({ getMinimum: () => settings.minimumCharacters });

  async function loadSettings() {
    const stored = await chrome.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  }

  function isActive() { return settings.enabled && !isDomainExcluded(settings.excludedDomains, location.href); }

  function applyActivation() {
    if (!isActive()) { observer?.disconnect(); observer = null; return; }
    if (!observer) {
      observer = new MutationObserver((records) => { if (records.some(isForeignMutation)) scheduleScan(); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    scheduleScan();
  }

  // Ignore mutations caused by Essence itself; otherwise every inserted icon would trigger a rescan.
  function isForeignMutation(record) {
    const target = record.target;
    if (target instanceof Element && target.closest(OWN_SELECTOR)) return false;
    const nodes = [...record.addedNodes, ...record.removedNodes];
    if (!nodes.length) return false;
    return nodes.some((node) => !(node instanceof Element && (node.hasAttribute(PANEL_ATTR) || node.hasAttribute(TRIGGER_ATTR))));
  }

  const debouncedScan = debounce(() => {
    const run = () => { scanScheduled = false; scan().catch(() => {}); };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2000 }); else run();
  }, 1000);
  function scheduleScan() { if (scanScheduled) return; scanScheduled = true; debouncedScan(); }

  function debounce(fn, wait) { let timer; return () => { clearTimeout(timer); timer = setTimeout(fn, wait); }; }

  async function scan() {
    if (!isActive()) return;
    const candidates = detector.collectCandidates();
    for (const element of candidates) {
      if (!element.isConnected || element.hasAttribute(ANCHOR_ATTR) || element.querySelector(OWN_SELECTOR)) continue;
      const text = detector.candidateText(element);
      if (!detector.textLengthOk(text)) continue;
      const hash = await sha256(text);
      if (processed.has(hash) || document.querySelector(`[data-essence-hash="${hash}"]`)) continue;
      processed.add(hash);
      renderTrigger(element, text, hash);
    }
  }

  function renderTrigger(anchor, text, hash) {
    if (anchor.hasAttribute(ANCHOR_ATTR) || anchor.querySelector(OWN_SELECTOR)) return;
    anchor.setAttribute(ANCHOR_ATTR, '');
    const host = document.createElement('span');
    host.dataset.essenceHash = hash; host.setAttribute(TRIGGER_ATTR, '');
    host.style.cssText = 'all:initial !important;display:inline-block !important;position:static !important;vertical-align:middle !important;margin:0 0 0 8px !important;width:28px !important;height:28px !important;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>:host{display:inline-block;vertical-align:middle}button{width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:#2563eb;cursor:pointer;display:grid;place-items:center}button:hover{background:#eff6ff}svg{width:19px;height:19px;display:block}</style><button title="Analyze with Essence" aria-label="Analyze with Essence"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>`;
    const button = root.querySelector('button');
    // Keep the click away from the page: sites attach navigation or player handlers to ancestors.
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'touchend']) host.addEventListener(type, (event) => event.stopPropagation());
    button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); host.remove(); analyze(anchor, text, hash); });
    const firstText = detector.findInsertionPoint(anchor);
    if (firstText?.parentNode) firstText.parentNode.insertBefore(host, firstText);
    else anchor.insertBefore(host, anchor.firstChild);
  }

  async function analyze(element, text, hash) {
    const panel = renderPanel(element, hash);
    try {
      if (!globalThis.chrome?.runtime?.id) throw new Error('Essence was updated or reloaded. Reload the page.');
      const result = await chrome.runtime.sendMessage({ type: 'ANALYZE', text, title: document.title, url: location.href });
      if (!result) throw new Error('No response from Essence. Reload the page.');
      if (result.error) throw new Error(result.error);
      const { feedback = {} } = await chrome.storage.local.get('feedback');
      const prediction = predictInterest(result, Object.values(feedback));
      panels.set(hash, { panel, result, prediction, original: element, rating: feedback[hash]?.rating });
      if (settings.displayMode === 'collapsed') setOriginalHidden(element, true);
      updatePanel(hash);
    } catch (error) {
      const body = panel.shadowRoot.querySelector('.body');
      body.innerHTML = `<span class="muted">${escapeHtml(error.message)}</span> <button data-retry>Retry</button>`;
      body.querySelector('[data-retry]').addEventListener('click', () => { panel.remove(); analyze(element, text, hash); });
    }
  }

  function renderPanel(anchor, hash) {
    const host = document.createElement('div');
    host.dataset.essenceHash = hash; host.setAttribute(PANEL_ATTR, '');
    host.style.cssText = 'all:initial !important;display:block !important;position:static !important;width:auto !important;height:auto !important;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>:host{display:block;margin:12px 0;font:14px/1.5 system-ui;color:#1f2937}.box{border:1px solid #dbe3ef;border-radius:12px;padding:16px;background:#f8fbff;box-shadow:0 2px 10px #102a430d}h3{margin:0 0 8px;font-size:15px}h4{margin:10px 0 4px;font-size:14px}p{margin:4px 0}.muted{color:#64748b}.score{font-weight:700;color:#2563eb}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}button{font:inherit;border:1px solid #cbd5e1;border-radius:8px;background:#fff;padding:6px 10px;cursor:pointer}button:hover:not(:disabled){background:#eff6ff}button:disabled{cursor:default;opacity:.55}button.chosen{opacity:1;border-color:#2563eb;background:#eff6ff}ul{margin:6px 0;padding-left:20px}</style><div class="box"><h3>Essence</h3><div class="body">⏳ Analyzing…</div></div>`;
    anchor.parentNode.insertBefore(host, anchor);
    return host;
  }

  function updatePanel(hash) {
    const entry = panels.get(hash);
    if (!entry || !entry.panel.isConnected) return;
    const { panel, result, prediction, original, rating } = entry;
    const body = panel.shadowRoot.querySelector('.body');
    let score = '';
    if (settings.showInterestScore) {
      score = prediction?.score == null
        ? '<p class="muted">Rate at least 3 texts for a personalized score.</p>'
        : `<p><span class="score">Interest: ${prediction.score}/100</span>${prediction.reasons.length ? ` <span class="muted">(${prediction.reasons.map(escapeHtml).join(', ')})</span>` : ''}</p>`;
    }
    const extras = `${settings.showKeyPoints ? list('Key points', result.key_points) : ''}${settings.showTopics ? list('Topics', result.topics) : ''}${settings.showConclusion && result.conclusion ? `<h4>Conclusion</h4><p>${escapeHtml(result.conclusion)}</p>` : ''}`;
    const hidden = original.hasAttribute(HIDDEN_ATTR);
    body.innerHTML = `${score}<p>${escapeHtml(result.essence || '')}</p>${extras}<div class="actions"><button data-rating="interesting">⭐ Interesting</button><button data-rating="boring">💤 Boring</button><button data-toggle>${hidden ? 'Show original' : 'Hide original'}</button></div><div class="muted" data-status>${rating ? 'Saved locally.' : ''}</div>`;
    const ratingButtons = body.querySelectorAll('[data-rating]');
    ratingButtons.forEach((button) => {
      if (rating) { button.disabled = true; if (button.dataset.rating === rating) button.classList.add('chosen'); }
      button.addEventListener('click', () => rate(hash, button.dataset.rating));
    });
    body.querySelector('[data-toggle]').addEventListener('click', () => {
      setOriginalHidden(original, !original.hasAttribute(HIDDEN_ATTR));
      updatePanel(hash);
    });
  }

  function rerenderPanels() { for (const hash of panels.keys()) updatePanel(hash); }

  // `hidden` is overridden by many site stylesheets and by `display: contents`, so use an important inline style.
  function setOriginalHidden(element, hide) {
    if (hide) {
      if (element.hasAttribute(HIDDEN_ATTR)) return;
      element.setAttribute(HIDDEN_ATTR, element.style.getPropertyValue('display') + '|' + element.style.getPropertyPriority('display'));
      element.style.setProperty('display', 'none', 'important');
    } else {
      if (!element.hasAttribute(HIDDEN_ATTR)) return;
      const [value, priority] = element.getAttribute(HIDDEN_ATTR).split('|');
      element.removeAttribute(HIDDEN_ATTR);
      if (value) element.style.setProperty('display', value, priority); else element.style.removeProperty('display');
      if (!element.getAttribute('style')) element.removeAttribute('style');
    }
  }

  function list(label, values) { return values?.length ? `<h4>${label}</h4><ul>${values.slice(0, 5).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''; }

  async function rate(hash, rating) {
    const entry = panels.get(hash);
    if (!entry || entry.rating) return;
    entry.rating = rating;
    updatePanel(hash); // disables the buttons immediately
    try {
      const response = await chrome.runtime.sendMessage({ type: 'RATE', hash, rating, topics: entry.result.topics, keywords: entry.result.keywords });
      if (response?.error) throw new Error(response.error);
    } catch (error) {
      entry.rating = undefined;
      updatePanel(hash);
      const status = entry.panel.shadowRoot.querySelector('[data-status]');
      if (status) status.textContent = `Could not save: ${error.message}`;
    }
  }

  function removePanels() {
    document.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((el) => setOriginalHidden(el, false));
    document.querySelectorAll(OWN_SELECTOR).forEach((x) => x.remove());
    document.querySelectorAll(`[${ANCHOR_ATTR}]`).forEach((x) => x.removeAttribute(ANCHOR_ATTR));
    processed.clear(); panels.clear();
  }

  function escapeHtml(x) { return String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }

  // Start only after every const/function above is initialized.
  settings = await loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const previous = settings;
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    const changed = Object.keys(settings).filter((key) => JSON.stringify(settings[key]) !== JSON.stringify(previous[key]));
    if (!changed.length) return;
    if (changed.every((key) => DISPLAY_KEYS.includes(key))) { rerenderPanels(); return; }
    removePanels();
    applyActivation();
  });
  applyActivation();
})().catch((error) => console.warn('[Essence] content script failed to start:', error));
