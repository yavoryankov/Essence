import {
  getSettings, sha256, normalizeText, todayKey, parseModelJson, buildPrompt, maxTokensFor,
  MAX_CACHE_ENTRIES, MAX_FEEDBACK_ENTRIES, pruneNewest
} from './shared.js';

// Serialize read-modify-write operations on chrome.storage to avoid lost updates
// when several analyses finish at the same time.
let storageQueue = Promise.resolve();
function withStorageLock(fn) {
  const run = storageQueue.then(fn, fn);
  storageQueue = run.catch(() => {});
  return run;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ANALYZE') {
    analyze(message).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === 'GET_SETTINGS') { getSettings().then(sendResponse); return true; }
  if (message?.type === 'RATE') {
    saveRating(message).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  return false;
});

async function analyze({ text, title, url }) {
  const settings = await getSettings();
  if (!settings.apiKey || !settings.endpoint) throw new Error('Configure an AI provider in Settings.');
  const contentHash = await sha256(normalizeText(text));
  const outputProfile = [settings.showKeyPoints, settings.showConclusion].map(Boolean).map(Number).join('');
  const prompt = buildPrompt(settings, title, text);
  // Any change to the instructions, language or requested fields produces a new cache entry.
  const promptHash = (await sha256(prompt.system)).slice(0, 16);
  const cacheKey = `analysis:${contentHash}:${settings.provider}:${settings.model}:${promptHash}:${outputProfile}`;
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey]) {
    await withStorageLock(() => bumpUsage({ cachedRequests: 1 }));
    return { ...cached[cacheKey], cached: true };
  }

  await withStorageLock(() => reserveDailyRequest(settings));

  const { raw, usage, truncated } = await callProvider(settings, prompt.system, prompt.user);

  await withStorageLock(() => recordUsage(usage, settings));
  let parsed;
  try { parsed = parseModelJson(raw); }
  catch (error) {
    if (truncated) throw new Error('The AI response was cut off (token limit reached). Try a model without long reasoning, or fewer panel fields.');
    throw error;
  }
  const result = { ...parsed, contentHash, url, title, modelId: settings.model, createdAt: Date.now() };
  await withStorageLock(() => storeCached(cacheKey, result));
  return result;
}

async function callProvider(settings, system, userText) {
  const maxTokens = maxTokensFor(settings);
  const provider = settings.provider;
  const isClaude = provider === 'claude';
  let headers; let body;
  if (isClaude) {
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      // Required: the service worker request carries a chrome-extension:// Origin.
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    body = { model: settings.model, max_tokens: maxTokens, temperature: 0.1, system, messages: [{ role: 'user', content: userText }] };
  } else {
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` };
    body = { model: settings.model, messages: [{ role: 'system', content: system }, { role: 'user', content: userText }] };
    const isOpenAI = provider === 'openai';
    // OpenAI reasoning models (o-series, gpt-5*) reject custom temperature and max_tokens.
    const openAIReasoning = isOpenAI && /^(o\d|gpt-5)/i.test(settings.model);
    if (!openAIReasoning) body.temperature = 0.1;
    if (isOpenAI) body.max_completion_tokens = maxTokens; else body.max_tokens = maxTokens;
    // JSON mode is not supported by every "OpenAI-compatible" server.
    if (provider === 'openai' || provider === 'grok') body.response_format = { type: 'json_object' };
  }

  let response;
  try { response = await fetch(settings.endpoint, { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch (error) { throw new Error(`Could not reach the AI provider (${error.message}).`); }
  if (!response.ok) throw new Error(await describeHttpError(response));

  const payload = await response.json();
  const raw = isClaude ? payload.content?.find((block) => block.type === 'text')?.text : payload.choices?.[0]?.message?.content;
  const truncated = isClaude ? payload.stop_reason === 'max_tokens' : payload.choices?.[0]?.finish_reason === 'length';
  if (!raw) {
    if (truncated) throw new Error('The AI response was empty because the token limit was reached (often caused by long reasoning). Try a non-reasoning model.');
    throw new Error('The AI provider returned no result.');
  }
  return { raw, usage: payload.usage, truncated };
}

async function describeHttpError(response) {
  let detail = '';
  try {
    const textBody = await response.text();
    try {
      const json = JSON.parse(textBody);
      detail = json?.error?.message || (typeof json?.error === 'string' ? json.error : '') || json?.message || '';
    } catch { detail = textBody; }
  } catch { /* ignore */ }
  detail = normalizeText(detail).slice(0, 300);
  const hint = response.status === 401 || response.status === 403 ? ' Check the API key.'
    : response.status === 404 ? ' Check the endpoint and model name.'
    : response.status === 429 ? ' Rate limit or quota exceeded.' : '';
  return `The AI provider returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}${hint}`;
}

async function reserveDailyRequest(settings) {
  const limit = Number(settings.dailyRequestLimit) || 0;
  const today = todayKey();
  const { dailyUsage } = await chrome.storage.local.get('dailyUsage');
  const current = dailyUsage?.day === today ? dailyUsage : { day: today, count: 0 };
  if (limit > 0 && current.count >= limit) throw new Error(`Daily limit of ${limit} AI requests reached. Change it in Settings.`);
  await chrome.storage.local.set({ dailyUsage: { day: today, count: current.count + 1 } });
}

const EMPTY_USAGE = { requests: 0, cachedRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0, updatedAt: 0 };

async function bumpUsage(delta) {
  const stored = await chrome.storage.local.get('usage');
  const current = { ...EMPTY_USAGE, ...(stored.usage || {}) };
  for (const [key, value] of Object.entries(delta)) current[key] = (current[key] || 0) + value;
  current.updatedAt = Date.now();
  await chrome.storage.local.set({ usage: current });
}

async function recordUsage(usage, settings) {
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  const totalTokens = Number(usage?.total_tokens ?? inputTokens + outputTokens);
  const inputCost = Number(settings.inputCostPerMillion || 0) * inputTokens / 1_000_000;
  const outputCost = Number(settings.outputCostPerMillion || 0) * outputTokens / 1_000_000;
  await bumpUsage({ requests: 1, inputTokens, outputTokens, totalTokens, estimatedCost: inputCost + outputCost });
}

async function storeCached(cacheKey, result) {
  const { analysisIndex = {} } = await chrome.storage.local.get('analysisIndex');
  analysisIndex[cacheKey] = { createdAt: result.createdAt };
  const kept = pruneNewest(analysisIndex, MAX_CACHE_ENTRIES, 'createdAt');
  const removed = Object.keys(analysisIndex).filter((key) => !(key in kept));
  await chrome.storage.local.set({ [cacheKey]: result, analysisIndex: kept });
  if (removed.length) await chrome.storage.local.remove(removed);
}

async function saveRating({ hash, rating, topics, keywords }) {
  if (!['interesting', 'boring'].includes(rating)) throw new Error('Invalid rating.');
  await withStorageLock(async () => {
    const { feedback = {} } = await chrome.storage.local.get('feedback');
    feedback[hash] = { contentHash: hash, rating, topics: topics || [], keywords: keywords || [], ratedAt: Date.now() };
    await chrome.storage.local.set({ feedback: pruneNewest(feedback, MAX_FEEDBACK_ENTRIES, 'ratedAt') });
  });
}

// One-time migration: drop cache entries created before the index existed.
chrome.runtime.onInstalled.addListener(async () => {
  const all = await chrome.storage.local.get(null);
  const index = all.analysisIndex || {};
  const orphans = Object.keys(all).filter((key) => key.startsWith('analysis:') && !(key in index));
  if (orphans.length) await chrome.storage.local.remove(orphans);
});
