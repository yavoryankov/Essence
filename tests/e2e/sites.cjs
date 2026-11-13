const EXT = require('path').resolve(__dirname, '../..');
const http = require('http'); const { chromium } = require('playwright');
const P = (n) => 'Senate Minority Leader Chuck Schumer faces a challenge after the election sweep, according to several senators. '.repeat(n);
const links = Array.from({length: 25}, (_, i) => `<li><a href="/v/${i}">Recommended video headline number ${i} about politics today</a></li>`).join('');
const pages = {
  '/fox': `<html><head><style>header{position:fixed;top:0;left:0;right:0;height:60px;background:#003;z-index:100}body{margin-top:60px}</style></head><body><header>FOX</header><div class="page">
    <div class="pre-content"><h3>Recommended Videos</h3><ul>${links}</ul></div>
    <div class="article-content"><h1>Van Hollen challenges Schumer</h1><div class="article-body">
      <div class="featured featured-video video-ct"><div class="contain"><div class="info"><div class="caption"><h4 class="title"><a href="/video/123">Several elected Senate Democrats not committed</a></h4><p>${P(1)}</p></div></div></div></div>
      <p class="speakable">${P(3)}</p><p>${P(3)}</p><p>${P(3)}</p></div></div></div></body></html>`,
  '/bbchome': `<html><body><div class="app"><noscript><style>.hide-when-no-script{visibility:hidden}</style></noscript>${Array.from({length: 30}, (_, i) => `<div class="card"><h2><a href="/news/articles/${i}">Headline ${i} that is fairly long for testing</a></h2><span>Summary text for story ${i} which is short-ish and not linked here.</span></div>`).join('')}</div></body></html>`,
  '/blog': `<html><body><main><h1>My blog post</h1><div class="entry-content"><p>${P(6)}</p><p>${P(6)}</p></div></main></body></html>`
};
const server = http.createServer((q, r) => { r.writeHead(200, {'content-type':'text/html; charset=utf-8'}); r.end(pages[q.url] || '<html><body>other page</body></html>'); }).listen(8769);
(async () => {
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', viewport: {width: 1000, height: 800}, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { enabled: true, apiKey: '' } }));
  const p = await ctx.newPage(); const out = {};
  for (const path of ['/fox', '/bbchome', '/blog']) {
    await p.goto('http://localhost:8769' + path); await p.waitForTimeout(3000);
    out[path] = await p.evaluate(() => [...document.querySelectorAll('[data-essence-trigger]')].map(t => ({ next: (t.nextSibling?.textContent || '').trim().slice(0, 40), inLink: !!t.closest('a'), anchor: document.querySelector('[data-essence-anchor]')?.className })));
  }
  // click on Fox: must not navigate; panel must stay under fixed header when scrolled
  await p.goto('http://localhost:8769/fox'); await p.waitForTimeout(3000);
  await p.locator('[data-essence-trigger]').first().evaluate(h => h.shadowRoot.querySelector('button').click());
  await p.waitForTimeout(800);
  const urlAfter = p.url();
  await p.evaluate(() => { const panel = document.querySelector('[data-essence-panel]'); window.scrollTo(0, panel.getBoundingClientRect().top + scrollY - 30); });
  await p.waitForTimeout(200);
  const topAt = await p.evaluate(() => { const el = document.elementFromPoint(500, 30); return el?.tagName; });
  await p.screenshot({ path: require('path').join(require('os').tmpdir(), 'fox-panel.png') });
  out.click = { urlAfter, panel: await p.locator('[data-essence-panel]').count(), elementUnderHeaderArea: topAt };
  console.log(JSON.stringify(out, null, 1)); await ctx.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
