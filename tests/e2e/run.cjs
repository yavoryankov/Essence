const EXT = require('path').resolve(__dirname, '../..');
const http = require('http');
const { chromium } = require('playwright');
const para = 'Изкуственият интелект променя начина, по който работят редакциите. ' .repeat(12);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Тест</title></head><body>
<header><nav>Menu</nav></header><main><article><h1>Заглавие</h1>${Array(5).fill(`<p>${para}</p>`).join('')}</article></main>
<aside class="related">${'Related '.repeat(300)}</aside></body></html>`;
let apiCalls = 0; let lastBody;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/')) {
    let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ apiCalls++; lastBody=JSON.parse(b);
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"essence":"Кратко резюме <b>x</b>","key_points":["a","b"],"topics":["Изкуствен интелект"],"keywords":["редакции"],"language":"bg"}'}}],usage:{prompt_tokens:100,completion_tokens:20}})); });
    return;
  }
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); res.end(html);
}).listen(8765);
(async () => {
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', args: ['--headless=new',`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { enabled: true, provider: 'custom', endpoint: 'http://localhost:8765/v1/chat/completions', model: 'm', apiKey: 'k', displayMode: 'collapsed', showKeyPoints: true, dailyRequestLimit: 2, minimumCharacters: 1000 } }));
  const page = await ctx.newPage(); const errors=[]; page.on('console', m => { if (m.type()==='error'||m.type()==='warning') errors.push(m.text()); });
  await page.goto('http://localhost:8765/');
  await page.waitForTimeout(4000); console.log('DBG', await page.evaluate(() => document.querySelectorAll('[data-essence-trigger]').length), errors);
  const triggers = await page.locator('[data-essence-trigger]').count();
  const anchorTag = await page.evaluate(() => document.querySelector('[data-essence-anchor]')?.tagName);
  // mutation storm: our own inserts must not cause rescans; add foreign nodes to check stability
  await page.evaluate(() => { for (let i=0;i<50;i++) document.body.appendChild(document.createElement('span')); });
  await page.waitForTimeout(2500);
  const triggersAfter = await page.locator('[data-essence-trigger]').count();
  await page.locator('[data-essence-trigger]').first().evaluate(h => h.shadowRoot.querySelector('button').click());
  await page.waitForFunction(() => document.querySelector('[data-essence-panel]')?.shadowRoot.querySelector('[data-rating]'), null, { timeout: 8000 });
  const panelText = await page.evaluate(() => document.querySelector('[data-essence-panel]').shadowRoot.querySelector('.body').innerHTML);
  const hiddenAfter = await page.evaluate(() => getComputedStyle(document.querySelector('article')).display);
  await page.evaluate(() => document.querySelector('[data-essence-panel]').shadowRoot.querySelector('[data-toggle]').click());
  const shownAfterToggle = await page.evaluate(() => getComputedStyle(document.querySelector('article')).display);
  await page.evaluate(() => document.querySelector('[data-essence-panel]').shadowRoot.querySelector('[data-rating="interesting"]').click());
  await page.waitForTimeout(500);
  const ratingState = await page.evaluate(() => [...document.querySelector('[data-essence-panel]').shadowRoot.querySelectorAll('[data-rating]')].map(b=>b.disabled));
  const store = await sw.evaluate(() => chrome.storage.local.get(null));
  // display-only change rerenders, keeps panel
  await sw.evaluate(async () => { const {settings} = await chrome.storage.local.get('settings'); await chrome.storage.local.set({settings:{...settings, showTopics:true}}); });
  await page.waitForTimeout(500);
  const panelStill = await page.evaluate(() => !!document.querySelector('[data-essence-panel]') && document.querySelector('[data-essence-panel]').shadowRoot.innerHTML.includes('Topics'));
  // hide original then disable: original must be restored
  await page.evaluate(() => document.querySelector('[data-essence-panel]').shadowRoot.querySelector('[data-toggle]').click());
  await sw.evaluate(async () => { const {settings} = await chrome.storage.local.get('settings'); await chrome.storage.local.set({settings:{...settings, enabled:false}}); });
  await page.waitForTimeout(500);
  const afterDisable = await page.evaluate(() => ({ panels: document.querySelectorAll('[data-essence-panel],[data-essence-trigger]').length, display: getComputedStyle(document.querySelector('article')).display, attr: document.querySelector('article').getAttribute('style') }));
  // cache hit + daily limit: re-enable, analyze again (cache), then different text twice
  await sw.evaluate(async () => { const {settings} = await chrome.storage.local.get('settings'); await chrome.storage.local.set({settings:{...settings, enabled:true}}); });
  const extId = sw.url().split('/')[2];
  const opt = await ctx.newPage(); const optErrors=[]; opt.on('pageerror', e => optErrors.push(e.message));
  await opt.goto(`chrome-extension://${extId}/src/options.html`); await opt.waitForTimeout(500);
  const optUsage = await opt.locator('#usage').textContent();
  const send = (text) => opt.evaluate((t) => chrome.runtime.sendMessage({ type: 'ANALYZE', text: t, title: 't', url: 'http://x' }), text);
  const cachedRes = await send(await page.evaluate(() => document.querySelector('article').innerText));
  const a = await send('нов текст едно'); const b = await send('нов текст две');
  const getS = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }));
  const limits = { cached: !!cachedRes.cached, a: a.error || 'ok', b: b.error || 'ok', getSettingsWorks: getS?.model === 'm', optErrors, optUsage };
  
  const usage = await sw.evaluate(() => chrome.storage.local.get(['usage','dailyUsage']));
  console.log(JSON.stringify({ triggers, anchorTag, triggersAfter, apiCalls, sentResponseFormat: 'response_format' in lastBody, maxTokens: lastBody.max_tokens, panelEscaped: panelText.includes('&lt;b&gt;'), hiddenAfter, shownAfterToggle, ratingState, feedback: Object.values(store.feedback||{}), indexKeys: Object.keys(store.analysisIndex||{}).length, panelStill, afterDisable, usage, limits, errors }, null, 1));
  await ctx.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
