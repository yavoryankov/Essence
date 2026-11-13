// Shared logic. Loaded as an ES module by the service worker, popup and options
// pages, and via dynamic import() by the content script.

export const DEFAULT_SETTINGS = {
  enabled: false, minimumCharacters: 1000, outputLanguage: 'bg', displayMode: 'above',
  showInterestScore: false, showKeyPoints: false, showTopics: false, showConclusion: false,
  inputCostPerMillion: 0, outputCostPerMillion: 0,
  provider: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4o-mini', apiKey: '', excludedDomains: [], dailyRequestLimit: 50, promptVersion: '2'
};

export const PROVIDER_PRESETS = {
  openai: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  grok: { label: 'Grok (xAI)', endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-4.7' },
  claude: { label: 'Claude (Anthropic)', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-5-20250929' },
  custom: { label: 'Other OpenAI-compatible', endpoint: '', model: '' }
};

export const MAX_TEXT_LENGTH = 120000;
export const MAX_CACHE_ENTRIES = 300;
export const MAX_FEEDBACK_ENTRIES = 2000;

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeText(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }

/** Hostname without a leading "www.", or '' for non-web URLs (chrome://, file:// ...). */
export function domainOf(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
}

export function isDomainExcluded(excludedDomains, url) {
  const domain = domainOf(url);
  if (!domain) return false;
  return (excludedDomains || []).some((entry) => {
    const d = String(entry).toLowerCase().replace(/^www\./, '');
    return d && (domain === d || domain.endsWith(`.${d}`));
  });
}

export function todayKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function parseModelJson(raw) {
  const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI provider returned an incomplete JSON response.');
  let parsed;
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)); }
  catch { throw new Error('The AI provider returned invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The AI provider returned an unexpected JSON shape.');
  return sanitizeResult(parsed);
}

/** Coerce model output to the expected types so the UI never renders "[object Object]". */
export function sanitizeResult(obj) {
  const str = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? (v.text ?? v.point ?? v.name ?? JSON.stringify(v)) : String(v));
  const arr = (v, max) => (Array.isArray(v) ? v : v ? [v] : []).map(str).map((s) => s.trim()).filter(Boolean).slice(0, max);
  return {
    essence: str(obj.essence).trim(),
    key_points: arr(obj.key_points, 5),
    conclusion: str(obj.conclusion).trim(),
    topics: arr(obj.topics, 5),
    keywords: arr(obj.keywords, 8),
    language: str(obj.language).trim()
  };
}

/** Topics and keywords are always requested: they are cheap and the interest model depends on them. */
export function responseShape(settings) {
  const shape = { essence: '1-2 concise sentences' };
  if (settings.showKeyPoints) shape.key_points = ['up to 3 concise points'];
  if (settings.showConclusion) shape.conclusion = 'short conclusion or empty';
  shape.topics = ['up to 3 short, general topics (1-2 words each)'];
  shape.keywords = ['up to 5 keywords'];
  shape.language = 'source language';
  return JSON.stringify(shape);
}

export function maxTokensFor(settings) {
  // Cyrillic output is token-heavy and reasoning models spend part of the budget
  // before answering, so keep generous headroom.
  return settings.showKeyPoints || settings.showConclusion ? 1500 : 900;
}

// --- Interest prediction ---------------------------------------------------

/** Lowercase word stems (first 5 letters) of words with 3+ letters, Unicode aware. */
export function stems(value) {
  return (String(value).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).map((w) => w.slice(0, 5));
}

function termsOf(item) { return new Set([...(item.topics || []), ...(item.keywords || [])].flatMap(stems)); }

/**
 * Score 0-100 from local ratings. Compares stemmed topics+keywords so that
 * "Изкуствен интелект" and "изкуствения интелект" still match.
 */
export function predictInterest(result, feedbackList) {
  if (feedbackList.length < 3) return { score: null, confidence: 0, reasons: [] };
  const weights = new Map();
  for (const item of feedbackList) {
    const delta = item.rating === 'interesting' ? 1 : item.rating === 'boring' ? -1 : 0;
    if (!delta) continue;
    for (const term of termsOf(item)) weights.set(term, (weights.get(term) || 0) + delta);
  }
  const terms = termsOf(result);
  let total = 0;
  for (const term of terms) total += Math.max(-3, Math.min(3, weights.get(term) || 0));
  const score = Math.max(0, Math.min(100, Math.round(50 + total * 8)));
  const reasons = (result.topics || []).filter((topic) => stems(topic).some((s) => (weights.get(s) || 0) > 0)).slice(0, 3);
  return { score, confidence: Math.min(1, feedbackList.length / 20), reasons };
}

/** Keep only the newest `max` entries of an object keyed by id, using `field` as timestamp. */
export function pruneNewest(obj, max, field) {
  const entries = Object.entries(obj || {});
  if (entries.length <= max) return obj || {};
  entries.sort((a, b) => (b[1]?.[field] || 0) - (a[1]?.[field] || 0));
  return Object.fromEntries(entries.slice(0, max));
}
