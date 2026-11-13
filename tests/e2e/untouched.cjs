const EXT = process.env.EXT || require('path').resolve(__dirname, '../..');
const http = require('http'); const { chromium } = require('playwright');
const P = (n) => 'Nvidia chief Jensen Huang said demand for AI chips remains strong as investors debate whether the boom can last. '.repeat(n);
const links = Array.from({length: 25}, (_, i) => `<li><a href="/v/${i}">Recommended video headline number ${i} about markets</a></li>`).join('');
const pages = {
  '/medium': `<html><head><meta property="al:android:app_name" content="Medium"></head><body><article class="meteredContent"><div style="position:relative"><aside style="position:absolute;right:0"><button><p>2</p></button></aside></div>
    <p>Member-only story</p><h1 class="title">The Real Title</h1><p class="paragraph">${P(3)}</p><p>${P(3)}</p><p>${P(3)}</p></article></body></html>`,
  '/home': `<html><body><div class="app"><noscript><style>.x{visibility:hidden}</style></noscript>${Array.from({length: 30}, (_, i) => `<div class="card"><h2><a href="/a/${i}">Headline ${i} that is fairly long for testing</a></h2><span>Summary text for story ${i} which is short and not linked.</span></div>`).join('')}</div></body></html>`,
  '/cnn': `<html><head><style>header{position:sticky;top:0;height:56px;background:#c00}.article__content{max-width:700px;margin:0 auto}</style></head><body><header>CNN</header>
    <main><h1 class="headline__text">AI boom: Jensen Huang and Nvidia</h1><div class="related-content"><ul>${links}</ul></div>
    <div class="article__content" data-editable="content"><div class="image"><figure><img alt=""><figcaption><a href="/photo">Photo credit link</a></figcaption></figure></div>
    <p class="paragraph">${P(3)}</p><p class="paragraph">${P(3)}</p><p class="paragraph">${P(3)}</p><p class="paragraph">${P(3)}</p></div></main></body></html>`,
  '/fox': `<html><body><div class="page"><div class="pre-content"><h3>Recommended Videos</h3><ul>${links}</ul></div>
    <div class="article-content"><h1>Van Hollen challenges Schumer</h1><div class="article-body">
      <div class="featured featured-video video-ct"><div class="info"><div class="caption"><h4 class="title"><a href="/video/123">Video title link</a></h4><p>${P(1)}</p></div></div></div>
      <p class="speakable">${P(3)}</p><p>${P(3)}</p><p>${P(3)}</p></div></div></div></body></html>`
};
let apiCalls = 0;
const server = http.createServer((q, r) => {
  if (q.url.startsWith('/v1/')) { let b=''; q.on('data',c=>b+=c); q.on('end',()=>{ apiCalls++; r.writeHead(200,{'content-type':'application/json'}); r.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"essence":"Резюме <i>x</i>","topics":["AI"],"keywords":["Nvidia"]}'}}],usage:{}})); }); return; }
  r.writeHead(200, {'content-type':'text/html; charset=utf-8'}); r.end(pages[q.url] || '<html><body>other page</body></html>');
}).listen(8770);
(async () => {
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', viewport: {width: 1200, height: 800}, deviceScaleFactor: 1, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { enabled: true, provider: 'custom', endpoint: 'http://localhost:8770/v1/chat/completions', model: 'm', apiKey: 'k', dailyRequestLimit: 0, showTopics: true } }));
  const results = {}; let ok = true;
  // Home page: no icons at all.
  { const p = await ctx.newPage(); await p.goto('http://localhost:8770/home'); await p.waitForTimeout(3000);
    const n = await p.evaluate(() => document.querySelector('essence-overlay')?.shadowRoot.querySelectorAll('.icon').length || 0);
    results['/home'] = { icons: n, pass: n === 0 }; ok = ok && n === 0; await p.close(); }
  for (const path of ['/cnn', '/fox', '/medium']) {
    const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.goto('http://localhost:8770' + path);
    const before = await p.evaluate(() => document.body.outerHTML);
    await p.waitForTimeout(3000);
    const icons = await p.evaluate(() => { const root = document.querySelector('essence-overlay')?.shadowRoot; return root ? [...root.querySelectorAll('.icon')].filter(i => !i.hidden).map(i => { const r = i.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y + scrollY)]; }) : []; });
    const firstP = await p.evaluate(() => { const el = document.querySelector('h1.title, .paragraph, .speakable'); const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y + scrollY)]; });
    await p.evaluate(() => document.querySelector('essence-overlay').shadowRoot.querySelector('.icon').click());
    await p.waitForTimeout(800);
    const popup = await p.evaluate(() => { const el = document.querySelector('essence-overlay').shadowRoot.querySelector('.popup'); return { hidden: el.hidden, text: el.innerText.slice(0, 160), escaped: el.innerHTML.includes('&lt;i&gt;') }; });
    await p.screenshot({ path: require('path').join(require('os').tmpdir(), `essence${path.replace('/', '-')}.png`) });
    await p.evaluate(() => document.querySelector('essence-overlay').shadowRoot.querySelector('[data-rating="interesting"]').click());
    await p.waitForTimeout(300);
    await p.keyboard.press('Escape'); await p.waitForTimeout(100);
    const closed = await p.evaluate(() => document.querySelector('essence-overlay').shadowRoot.querySelector('.popup').hidden);
    const after = await p.evaluate(() => document.body.outerHTML);
    const r = { url: p.url(), icons, firstP, popup, closed, bodyUnchanged: before === after, errors };
    r.pass = r.icons.length === 1 && (/* left of the paragraph */ (r.icons[0][0] < r.firstP[0] && Math.abs(r.icons[0][1] - r.firstP[1]) <= 30) || /* or just above it when there is no margin */ (r.icons[0][1] < r.firstP[1] && r.firstP[1] - r.icons[0][1] <= 40)) && !popup.hidden && popup.escaped && closed && r.bodyUnchanged && r.url.endsWith(path) && !errors.length;
    ok = ok && r.pass; results[path] = r;
  }
  console.log(JSON.stringify({ apiCalls, results }, null, 1));
  await ctx.close(); server.close(); process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
