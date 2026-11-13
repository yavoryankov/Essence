const EXT = require('path').resolve(__dirname, '../..');
const http = require('http'); const { chromium } = require('playwright');
let seen = {};
const server = http.createServer((req, res) => {
  seen = { url: req.url, direct: req.headers['anthropic-dangerous-direct-browser-access'], key: req.headers['x-api-key'] };
  let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ seen.body = JSON.parse(b);
    if (seen.body.messages[0].content.includes('fail')) { res.writeHead(400,{'content-type':'application/json'}); res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'model: not-a-model'}})); return; }
    if (seen.body.messages[0].content.includes('cut')) { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({content:[{type:'text',text:'{"essence":"tru'}],stop_reason:'max_tokens',usage:{input_tokens:5,output_tokens:5}})); return; }
    res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({content:[{type:'text',text:'Here:\n```json\n{"essence":"ok","topics":["a"],"keywords":[]}\n```'}],stop_reason:'end_turn',usage:{input_tokens:5,output_tokens:5}})); });
}).listen(8766);
(async () => {
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ settings: { provider: 'claude', endpoint: 'http://localhost:8766/v1/messages', model: 'claude-x', apiKey: 'sk', dailyRequestLimit: 0 } }));
  const p = await ctx.newPage(); await p.goto(`chrome-extension://${sw.url().split('/')[2]}/src/options.html`);
  const send = (t) => p.evaluate((t) => chrome.runtime.sendMessage({ type: 'ANALYZE', text: t, title: '', url: '' }), t);
  const ok = await send('good text'); const okSeen = { ...seen, body: undefined, hasTemp: 'temperature' in seen.body, maxTokens: seen.body.max_tokens };
  const fail = await send('fail text'); const cut = await send('cut text');
  console.log(JSON.stringify({ ok, okSeen, fail, cut }, null, 1));
  await ctx.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
