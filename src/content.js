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
  const BLOCKED_ANCESTORS = `${OWN_SELECTOR}, nav, header, footer, aside, form, [role="navigation"], [role="banner"], [role="complementary"]`;
  // Settings that only change how a finished panel looks; panels are re-rendered, not removed.
  const DISPLAY_KEYS = ['showInterestScore', 'showKeyPoints', 'showTopics', 'showConclusion', 'displayMode'];

  const processed = new Set();
  const panels = new Map(); // hash -> { panel, result, prediction, original }
  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let scanScheduled = false;
  let textCache = new WeakMap(); // per-scan memo of normalized innerText

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
    textCache = new WeakMap();
    const candidates = collectCandidates();
    for (const element of candidates) {
      if (!element.isConnected || element.hasAttribute(ANCHOR_ATTR) || element.querySelector(OWN_SELECTOR)) continue;
      const text = candidateText(element);
      if (!textLengthOk(text)) continue;
      const hash = await sha256(text);
      if (processed.has(hash) || document.querySelector(`[data-essence-hash="${hash}"]`)) continue;
      processed.add(hash);
      renderTrigger(element, text, hash);
    }
  }

  function textLengthOk(text) { return text.length >= settings.minimumCharacters && text.length <= MAX_TEXT_LENGTH; }

  // Cheap upper-bound check before the expensive innerText/getComputedStyle calls.
  function roughlyLongEnough(el) { return (el.textContent?.length || 0) >= settings.minimumCharacters * 0.8; }

  function collectCandidates() {
    // Faktor.bg: the article is explicitly marked with itemprop="articleBody".
    // Do not run the generic detector here; it can choose related-news blocks.
    if (isFaktorDomain()) {
      return [...document.querySelectorAll('[itemprop~="articleBody"]')]
        .filter((el) => roughlyLongEnough(el) && !el.hasAttribute(ANCHOR_ATTR) && !el.querySelector(OWN_SELECTOR) && textLengthOk(candidateText(el)))
        .slice(0, 1);
    }
    // Medium: prefer the dedicated post-content container so the icon is placed once.
    if (isMediumDomain()) {
      const isPost = (el) => el.matches('[data-testid="postContent"]');
      const mediumCandidates = [...document.querySelectorAll('[data-testid="postContent"], article')]
        .filter((el) => roughlyLongEnough(el) && !el.hasAttribute(ANCHOR_ATTR) && !el.querySelector(OWN_SELECTOR) && textLengthOk(candidateText(el)))
        .sort((a, b) => Number(isPost(b)) - Number(isPost(a)));
      if (mediumCandidates.length) return mediumCandidates.slice(0, 1);
    }
    // Prefer the site's explicit article body. Its wrapper can be `display: contents`.
    const articleBodies = [...document.querySelectorAll('[itemprop~="articleBody"]')].filter((el) =>
      roughlyLongEnough(el) && !excludedClass(el) && !el.closest(BLOCKED_ANCESTORS) && textLengthOk(candidateText(el)));
    if (articleBodies.length) return articleBodies.slice(0, 20);

    const semanticSelector = 'article, [role="article"], .article-body, .article-content, .post-content, .entry-content, .news-content, div[class*="article"], div[class*="content"], div[class*="post"], div[class*="entry"]';
    const semantic = [...document.querySelectorAll(semanticSelector)].filter((el) => !excludedClass(el) && candidateContainer(el));
    const semanticRoots = semantic.filter((el) => !semantic.some((other) => other !== el && el.contains(other)));
    if (semanticRoots.length) return semanticRoots.slice(0, 20);

    // A single h1 followed by the body: use the smallest article-sized ancestor of that h1.
    const title = document.querySelector('main h1, article h1, h1');
    if (title) {
      const container = smallestContainerAbove(title);
      if (container) return [container];
    }

    // Plain sequence of <p> elements: smallest article-sized ancestor per paragraph.
    const roots = new Set();
    const visited = new WeakSet();
    for (const paragraph of document.querySelectorAll('p')) {
      const container = smallestContainerAbove(paragraph, visited);
      if (container) roots.add(container);
    }
    const paragraphRoots = [...roots].filter((el) => ![...roots].some((other) => other !== el && el.contains(other)));
    if (paragraphRoots.length) return paragraphRoots.slice(0, 20);

    // Generic fallback: the largest content containers, without nesting.
    const generic = [...document.querySelectorAll('main, [role="main"], section, div')]
      .filter((el) => !excludedClass(el) && candidateContainer(el))
      .sort((a, b) => candidateText(b).length - candidateText(a).length);
    const selected = [];
    for (const element of generic) {
      if (selected.some((parent) => parent.contains(element) || element.contains(parent))) continue;
      selected.push(element);
      if (selected.length >= 20) break;
    }
    return selected;
  }

  function smallestContainerAbove(node, visited) {
    let parent = node.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      if (visited) {
        if (visited.has(parent)) return null; // already evaluated via another paragraph
        visited.add(parent);
      }
      if (!excludedClass(parent) && candidateContainer(parent)) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  function isFaktorDomain() { return /(^|\.)faktor\.bg$/i.test(location.hostname); }
  // Medium also serves publications on custom domains (e.g. levelup.gitconnected.com), so check its meta tags too.
  function isMediumDomain() {
    if (/(^|\.)medium\.com$/i.test(location.hostname)) return true;
    return Boolean(document.querySelector('meta[property="al:android:app_name"][content="Medium"], meta[name="twitter:app:name:iphone"][content="Medium"], meta[property="al:android:package"][content="com.medium.reader"]'));
  }

  function candidateText(el) {
    let text = textCache.get(el);
    if (text === undefined) { text = normalizeText(el.innerText || el.textContent || ''); textCache.set(el, text); }
    return text;
  }

  function candidateContainer(el) {
    if (el === document.body || el === document.documentElement || el.isContentEditable) return false;
    if (!roughlyLongEnough(el)) return false;
    if (el.closest(BLOCKED_ANCESTORS) || !visible(el)) return false;
    return textLengthOk(candidateText(el));
  }

  // Word-boundary-ish match so "shared-layout" or "navigation-free" class names are less likely to be excluded by accident.
  const EXCLUDED_CLASS = /(^|[\s_-])(sidebar|header|footer|nav|navbar|navigation|menu|comments?|related|advert|ads?|banner|social|share|sharing)($|[\s_-])/i;
  function excludedClass(el) { return EXCLUDED_CLASS.test(typeof el.className === 'string' ? el.className : ''); }

  function visible(el) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
    // `display: contents` wrappers have no box of their own while their children are visible.
    return [...el.children].some((child) => {
      const childStyle = getComputedStyle(child);
      if (childStyle.display === 'none' || childStyle.visibility === 'hidden') return false;
      const childRect = child.getBoundingClientRect();
      return childRect.width > 0 && childRect.height > 0;
    });
  }

  function renderTrigger(anchor, text, hash) {
    if (anchor.hasAttribute(ANCHOR_ATTR) || anchor.querySelector(OWN_SELECTOR)) return;
    anchor.setAttribute(ANCHOR_ATTR, '');
    const host = document.createElement('span');
    host.dataset.essenceHash = hash; host.setAttribute(TRIGGER_ATTR, '');
    host.style.cssText = 'all:initial !important;display:inline-block !important;position:relative !important;z-index:2147483646 !important;vertical-align:middle !important;margin:0 0 0 8px !important;width:28px !important;height:28px !important;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>:host{display:inline-block;vertical-align:middle}button{width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:#2563eb;cursor:pointer;display:grid;place-items:center}button:hover{background:#eff6ff}svg{width:19px;height:19px;display:block}</style><button title="Analyze with Essence" aria-label="Analyze with Essence"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>`;
    root.querySelector('button').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); host.remove(); analyze(anchor, text, hash); });
    const firstText = isMediumDomain() ? findMediumInsertionText(anchor) : findFirstTextNode(anchor);
    if (firstText?.parentNode) firstText.parentNode.insertBefore(host, firstText);
    else anchor.insertBefore(host, anchor.firstChild);
  }

  function findMediumInsertionText(root) {
    const title = root.querySelector('h1');
    return (title && findFirstTextNode(title)) || findFirstTextNode(root);
  }

  // Never place the icon inside floating toolbars, buttons, hidden or out-of-flow widgets
  // that sites render inside the article (e.g. Medium's clap/response bar).
  const NON_CONTENT = 'aside, nav, button, footer, form, figcaption, svg, [role="button"], [role="toolbar"], [role="navigation"], [aria-hidden="true"], [hidden]';
  function isContentText(node, root) {
    const parent = node.parentElement;
    if (!parent) return false;
    const blocker = parent.closest(NON_CONTENT);
    if (blocker && (blocker === root || root.contains(blocker))) return false;
    for (let el = parent; el && el !== root; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'absolute' || style.position === 'fixed') return false;
    }
    return true;
  }
  function findFirstTextNode(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) { return node.nodeValue?.trim() && isContentText(node, root) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
    });
    return walker.nextNode();
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
    host.style.cssText = 'all:initial !important;display:block !important;position:relative !important;z-index:2147483646 !important;width:auto !important;height:auto !important;';
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
