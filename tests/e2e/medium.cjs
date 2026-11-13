const EXT = require('path').resolve(__dirname, '../..');
const http = require('http'); const { chromium } = require('playwright');
const para = 'Software engineering is changing quickly as AI tools take over routine work. '.repeat(10);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta property="al:android:app_name" content="Medium"><title>M</title></head><body>
<article class="meteredContent"><div style="position:relative"><aside style="position:absolute;right:0"><div style="position:absolute"><button><p>2</p></button></div></aside></div>
<p>Member-only story</p><h1>The Real Title</h1>${Array(4).fill(`<p>${para}</p>`).join('')}</article></body></html>`;
const server = http.createServer((q, r) => { r.writeHead(200, {'content-type':'text/html; charset=utf-8'}); r.end(html); }).listen(8768);
(async () => {
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { enabled: true } }));
  const p = await ctx.newPage(); await p.goto('http://localhost:8768/'); await p.waitForTimeout(3500);
  console.log(await p.evaluate(() => { const t = document.querySelectorAll('[data-essence-trigger]'); return { count: t.length, parent: t[0]?.parentElement.tagName, next: t[0]?.nextSibling?.textContent }; }));
  await ctx.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
