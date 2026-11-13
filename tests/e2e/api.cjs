const EXT = process.env.EXT || require('path').resolve(__dirname, '../..');
// Background messaging: cache hits, daily limit, GET_SETTINGS, OpenAI-compatible request shape.
const http = require('http'); const { chromium } = require('playwright');
let apiCalls = 0; let lastBody;
const server = http.createServer((q, r) => { let b=''; q.on('data',c=>b+=c); q.on('end',()=>{ apiCalls++; lastBody = JSON.parse(b);
  r.writeHead(200,{'content-type':'application/json'}); r.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"essence":"ok","topics":["a"],"keywords":[]}'}}],usage:{prompt_tokens:10,completion_tokens:5}})); }); }).listen(8771);
(async () => {
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { provider: 'custom', endpoint: 'http://localhost:8771/v1/chat/completions', model: 'm', apiKey: 'k', dailyRequestLimit: 2 } }));
  const p = await ctx.newPage(); await p.goto(`chrome-extension://${sw.url().split('/')[2]}/src/options.html`);
  const send = (t) => p.evaluate((t) => chrome.runtime.sendMessage({ type: 'ANALYZE', text: t, title: 't', url: '' }), t);
  const a = await send('text one'); const shape = { hasResponseFormat: 'response_format' in lastBody, maxTokens: lastBody.max_tokens };
  const aCached = await send('text one'); const b = await send('text two'); const c = await send('text three');
  const getS = await p.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }));
  const { usage, dailyUsage } = await sw.evaluate(() => chrome.storage.local.get(['usage', 'dailyUsage']));
  const r = { apiCalls, shape, cached: aCached.cached === true, b: b.error || 'ok', c: c.error || 'ok', getSettings: getS?.model, usage, dailyUsage };
  r.pass = !a.error && r.cached && r.b === 'ok' && /Daily limit/.test(r.c) && apiCalls === 2 && !shape.hasResponseFormat && shape.maxTokens >= 800 && r.getSettings === 'm' && usage.cachedRequests === 1 && usage.requests === 2;
  console.log(JSON.stringify(r, null, 1)); await ctx.close(); server.close(); process.exit(r.pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
