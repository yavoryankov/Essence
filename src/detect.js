// Article detection and icon placement. A classic script (no imports/exports) so it can run
// as a content script before content.js, in Node tests, and pasted into a page for diagnostics.
(() => {
  const MAX_TEXT_LENGTH = 120000;
  const BLOCKED_ANCESTORS = `nav, header, footer, aside, form, [role="navigation"], [role="banner"], [role="complementary"]`;
  // Containers whose class names mark them as non-article widgets.
  const EXCLUDED_CLASS = /(^|[\s_-])(sidebar|header|footer|nav|navbar|navigation|menu|comments?|related|recommended|recommendations?|trending|promo|newsletter|sponsored|advert|ads?|banner|social|share|sharing|carousel|outbrain|taboola)($|[\s_-])/i;
  // Never put the icon inside these: links and controls navigate or react to clicks,
  // media blocks and floating toolbars are not the start of the text.
  const NON_CONTENT = 'script, style, noscript, template, a, button, label, summary, select, textarea, aside, nav, footer, form, figure, figcaption, picture, video, audio, iframe, svg, [role="button"], [role="link"], [role="toolbar"], [role="navigation"], [aria-hidden="true"], [hidden], [contenteditable="true"]';
  const MEDIA_CLASS = /(^|[\s_-])(video|player|caption|media|gallery|slideshow|embed|ad|promo)($|[\s_-])/i;
  const MAX_LINK_DENSITY = 0.4;
  const MIN_PARAGRAPH_CHARS = 60;
  const MIN_PROSE_DENSITY = 0.4;

  const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  function createDetector({ doc = document, getMinimum = () => 1000, isMedium, isFaktor, isAnchored = () => false } = {}) {
    const win = doc.defaultView;
    let textCache = new WeakMap();
    const minimum = () => getMinimum();
    const hostname = () => win?.location?.hostname || '';
    const isFaktorSite = isFaktor || (() => /(^|\.)faktor\.bg$/i.test(hostname()));
    // Medium also serves publications on custom domains (e.g. levelup.gitconnected.com).
    const isMediumSite = isMedium || (() => /(^|\.)medium\.com$/i.test(hostname()) || Boolean(doc.querySelector('meta[property="al:android:app_name"][content="Medium"], meta[name="twitter:app:name:iphone"][content="Medium"], meta[property="al:android:package"][content="com.medium.reader"]')));

    function resetCache() { textCache = new WeakMap(); }
    function candidateText(el) {
      let text = textCache.get(el);
      if (text === undefined) { text = normalizeText(el.innerText || el.textContent || ''); textCache.set(el, text); }
      return text;
    }
    function textLengthOk(text) { return text.length >= minimum() && text.length <= MAX_TEXT_LENGTH; }
    function roughlyLongEnough(el) { return (el.textContent?.length || 0) >= minimum() * 0.8; }
    function excludedClass(el) { return EXCLUDED_CLASS.test(typeof el.className === 'string' ? el.className : ''); }

    /** Share of the text that sits inside links. Lists of headlines ("Recommended articles") score high. */
    function linkDensity(el) {
      const total = normalizeText(el.textContent).length;
      if (!total) return 1;
      let linked = 0;
      for (const a of el.querySelectorAll('a')) if (!a.parentElement?.closest('a')) linked += normalizeText(a.textContent).length;
      return linked / total;
    }

    /** Share of the text in prose blocks. Article bodies are mostly paragraphs; home pages and link hubs are not. */
    function proseDensity(el) {
      const total = normalizeText(el.textContent).length;
      if (!total) return 0;
      let prose = 0;
      for (const p of el.querySelectorAll('p, blockquote')) if (!p.parentElement?.closest('p, blockquote')) prose += normalizeText(p.textContent).length;
      return prose / total;
    }

    function isStyleHidden(style) { return style.display === 'none' || style.visibility === 'hidden'; }
    function visible(el) {
      if (isStyleHidden(win.getComputedStyle(el))) return false;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
      // `display: contents` wrappers have no box of their own while their children are visible.
      return [...el.children].some((child) => {
        if (isStyleHidden(win.getComputedStyle(child))) return false;
        const rect = child.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    }

    function isArticleLike(el) {
      return roughlyLongEnough(el) && !isAnchored(el)
        && textLengthOk(candidateText(el)) && linkDensity(el) <= MAX_LINK_DENSITY;
    }

    function candidateContainer(el) {
      if (el === doc.body || el === doc.documentElement || el.isContentEditable) return false;
      if (!roughlyLongEnough(el) || excludedClass(el)) return false;
      if (el.closest(BLOCKED_ANCESTORS) || !visible(el)) return false;
      return textLengthOk(candidateText(el)) && linkDensity(el) <= MAX_LINK_DENSITY && proseDensity(el) >= MIN_PROSE_DENSITY;
    }

    function smallestContainerAbove(node, visited) {
      let parent = node.parentElement;
      while (parent && parent !== doc.body && parent !== doc.documentElement) {
        if (visited) { if (visited.has(parent)) return null; visited.add(parent); }
        if (candidateContainer(parent)) return parent;
        parent = parent.parentElement;
      }
      return null;
    }

    function withoutNested(list) { return list.filter((el) => !list.some((other) => other !== el && el.contains(other))); }

    function collectCandidates() {
      resetCache();
      // Faktor.bg: the article is explicitly marked; the generic detector picks related-news blocks.
      if (isFaktorSite()) return [...doc.querySelectorAll('[itemprop~="articleBody"]')].filter(isArticleLike).slice(0, 1);
      // Medium: one icon per story.
      if (isMediumSite()) {
        const isPost = (el) => el.matches('[data-testid="postContent"]');
        const found = [...doc.querySelectorAll('[data-testid="postContent"], article')].filter(isArticleLike).sort((a, b) => Number(isPost(b)) - Number(isPost(a)));
        if (found.length) return found.slice(0, 1);
      }
      // The site's explicit article body (its wrapper may be `display: contents`).
      const articleBodies = [...doc.querySelectorAll('[itemprop~="articleBody"]')].filter((el) => !excludedClass(el) && !el.closest(BLOCKED_ANCESTORS) && isArticleLike(el));
      if (articleBodies.length) return withoutNested(articleBodies).slice(0, 20);

      const semanticSelector = 'article, [role="article"], .article-body, .article-content, .post-content, .entry-content, .news-content, div[class*="article"], div[class*="content"], div[class*="post"], div[class*="entry"]';
      const semantic = [...doc.querySelectorAll(semanticSelector)].filter(candidateContainer);
      const semanticRoots = withoutNested(semantic);
      if (semanticRoots.length) return semanticRoots.slice(0, 20);

      // A single h1 followed by the body.
      const title = doc.querySelector('main h1, article h1, h1');
      if (title) { const container = smallestContainerAbove(title); if (container) return [container]; }

      // Plain sequence of <p> elements.
      const roots = new Set(); const visited = new WeakSet();
      for (const paragraph of doc.querySelectorAll('p')) { const c = smallestContainerAbove(paragraph, visited); if (c) roots.add(c); }
      const paragraphRoots = withoutNested([...roots]);
      if (paragraphRoots.length) return paragraphRoots.slice(0, 20);

      // Generic fallback: the largest content containers, without nesting.
      const generic = [...doc.querySelectorAll('main, [role="main"], section, div')].filter(candidateContainer)
        .sort((a, b) => candidateText(b).length - candidateText(a).length);
      const selected = [];
      for (const el of generic) {
        if (selected.some((p) => p.contains(el) || el.contains(p))) continue;
        selected.push(el);
        if (selected.length >= 20) break;
      }
      return selected;
    }

    function isContentElement(el, root) {
      const blocker = el.closest(NON_CONTENT);
      if (blocker && (blocker === root || root.contains(blocker))) return false;
      for (let node = el; node && node !== root; node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (isStyleHidden(style) || style.position === 'absolute' || style.position === 'fixed') return false;
        if (node !== el && MEDIA_CLASS.test(typeof node.className === 'string' ? node.className : '')) return false;
      }
      return true;
    }

    function firstTextNode(root, scope = root) {
      const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
        acceptNode(node) { return node.nodeValue?.trim() && node.parentElement && isContentElement(node.parentElement, scope) ? 1 : 3; }
      });
      return walker.nextNode();
    }

    /**
     * Text node before which the icon is inserted: the article title if it is inside the
     * container, otherwise the first real paragraph, otherwise the first content text.
     */
    function findInsertionPoint(anchor) {
      const title = anchor.querySelector('h1');
      if (title && isContentElement(title, anchor)) { const t = firstTextNode(title, anchor); if (t) return t; }
      for (const p of anchor.querySelectorAll('p')) {
        if (normalizeText(p.textContent).length < MIN_PARAGRAPH_CHARS || !isContentElement(p, anchor)) continue;
        const t = firstTextNode(p, anchor); if (t) return t;
      }
      // No title or <p> (feeds, div-based layouts): start of the first real block of prose,
      // skipping short metadata lines such as author names, job titles and dates.
      const walker = doc.createTreeWalker(anchor, 4 /* NodeFilter.SHOW_TEXT */, {
        acceptNode(node) { return node.nodeValue?.trim() && node.parentElement && isContentElement(node.parentElement, anchor) ? 1 : 3; }
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const block = blockOf(node.parentElement, anchor);
        if (normalizeText(block.textContent).length >= MIN_PARAGRAPH_CHARS && linkDensity(block) <= 0.5) return node;
      }
      return null; // no sensible place: better no icon than a misplaced one
    }

    function blockOf(el, root) {
      for (let node = el; node && node !== root; node = node.parentElement) {
        const display = win.getComputedStyle(node).display;
        if (display === 'block' || display === 'flex' || display === 'grid' || display === 'list-item' || display === 'table-cell') return node;
      }
      return root;
    }

    return { collectCandidates, findInsertionPoint, candidateText, textLengthOk, linkDensity, proseDensity, isMediumSite, resetCache };
  }

  globalThis.EssenceDetect = { createDetector, normalizeText };
})();
