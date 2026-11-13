import { getSettings, saveSettings, PROVIDER_PRESETS, todayKey, DEFAULT_SYSTEM_PROMPT, MAX_CUSTOM_PROMPT_LENGTH, buildPrompt } from './shared.js';

const $ = (selector) => document.querySelector(selector);
const TEXT_KEYS = ['endpoint', 'model', 'apiKey'];
const NUMBER_KEYS = ['inputCostPerMillion', 'outputCostPerMillion', 'dailyRequestLimit'];
const CHECK_KEYS = ['showInterestScore', 'showKeyPoints', 'showTopics', 'showConclusion'];

const settings = await getSettings();
// Keys are kept per provider so an OpenAI key is never sent to xAI/Anthropic after switching.
const apiKeys = { ...(settings.apiKeys || {}) };
if (settings.apiKey && !apiKeys[settings.provider]) apiKeys[settings.provider] = settings.apiKey;

const provider = $('#provider');
provider.value = settings.provider || 'openai';
let currentProvider = provider.value;
for (const key of TEXT_KEYS) $(`#${key}`).value = settings[key] || '';
for (const key of NUMBER_KEYS) $(`#${key}`).value = settings[key] ?? 0;
for (const key of CHECK_KEYS) $(`#${key}`).checked = Boolean(settings[key]);
$('#customSystemPrompt').value = String(settings.customSystemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;
$('#outputLanguage').value = settings.outputLanguage || 'bg';

function promptSettingsFromForm() {
  return {
    customSystemPrompt: $('#customSystemPrompt').value.trim(),
    outputLanguage: $('#outputLanguage').value,
    ...Object.fromEntries(CHECK_KEYS.map((key) => [key, $(`#${key}`).checked]))
  };
}
function renderPreview() {
  const draft = promptSettingsFromForm();
  const { system, user } = buildPrompt(draft, '{page title}', '{article text}');
  $('#previewSystem').textContent = system;
  $('#previewUser').textContent = user;
  const length = draft.customSystemPrompt.length;
  const count = $('#promptCount');
  count.textContent = `${length} / ${MAX_CUSTOM_PROMPT_LENGTH} characters${draft.customSystemPrompt === DEFAULT_SYSTEM_PROMPT ? ' · default' : ' · custom'}`;
  count.classList.toggle('over', length > MAX_CUSTOM_PROMPT_LENGTH);
}
for (const id of ['customSystemPrompt', 'outputLanguage', ...CHECK_KEYS]) $(`#${id}`).addEventListener('input', renderPreview);
$('#resetPrompt').onclick = () => { $('#customSystemPrompt').value = DEFAULT_SYSTEM_PROMPT; renderPreview(); };
renderPreview();

provider.onchange = () => {
  apiKeys[currentProvider] = $('#apiKey').value.trim();
  currentProvider = provider.value;
  $('#apiKey').value = apiKeys[currentProvider] || '';
  const preset = PROVIDER_PRESETS[currentProvider];
  if (preset && currentProvider !== 'custom') { $('#endpoint').value = preset.endpoint; $('#model').value = preset.model; }
  // Prices differ between providers; do not silently keep the old ones.
  $('#inputCostPerMillion').value = 0; $('#outputCostPerMillion').value = 0;
  showMessage('Provider changed. Check the model and prices, then save.');
};

function showMessage(text, isError = false) { const el = $('#saved'); el.textContent = ` ${text}`; el.style.color = isError ? '#b91c1c' : ''; }

function validEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}

async function refresh() {
  const { feedback = {}, usage = {}, dailyUsage } = await chrome.storage.local.get(['feedback', 'usage', 'dailyUsage']);
  const values = Object.values(feedback);
  $('#stats').textContent = `Rated texts: ${values.length} · Interesting: ${values.filter((x) => x.rating === 'interesting').length} · Boring: ${values.filter((x) => x.rating === 'boring').length}`;
  const today = dailyUsage?.day === todayKey() ? dailyUsage.count : 0;
  $('#usage').textContent = `Today: ${today} requests · All time: ${usage.requests || 0} requests, ${usage.cachedRequests || 0} served from cache · Input tokens: ${(usage.inputTokens || 0).toLocaleString()} · Output tokens: ${(usage.outputTokens || 0).toLocaleString()} · Total: ${(usage.totalTokens || 0).toLocaleString()} · Estimated cost: $${Number(usage.estimatedCost || 0).toFixed(4)}`;
}
await refresh();

$('#save').onclick = async () => {
  const text = Object.fromEntries(TEXT_KEYS.map((key) => [key, $(`#${key}`).value.trim()]));
  if (text.endpoint && !validEndpoint(text.endpoint)) { showMessage('Endpoint must be an https:// URL (http:// only for localhost).', true); return; }
  const numbers = Object.fromEntries(NUMBER_KEYS.map((key) => [key, Math.max(0, Number($(`#${key}`).value) || 0)]));
  numbers.dailyRequestLimit = Math.round(numbers.dailyRequestLimit);
  const promptDraft = promptSettingsFromForm();
  if (promptDraft.customSystemPrompt.length > MAX_CUSTOM_PROMPT_LENGTH) { showMessage(`Instructions are longer than ${MAX_CUSTOM_PROMPT_LENGTH} characters.`, true); return; }
  // Store '' for the default so future improvements to the default prompt reach existing users.
  if (!promptDraft.customSystemPrompt || promptDraft.customSystemPrompt === DEFAULT_SYSTEM_PROMPT) promptDraft.customSystemPrompt = '';
  apiKeys[provider.value] = text.apiKey;
  await saveSettings({
    customSystemPrompt: promptDraft.customSystemPrompt, outputLanguage: promptDraft.outputLanguage,
    provider: provider.value, ...text, ...numbers, apiKeys,
    ...Object.fromEntries(CHECK_KEYS.map((key) => [key, $(`#${key}`).checked]))
  });
  showMessage('Saved.');
};
$('#clear').onclick = async () => { await chrome.storage.local.remove('feedback'); await refresh(); };
$('#clearUsage').onclick = async () => { await chrome.storage.local.remove(['usage', 'dailyUsage']); await refresh(); };
$('#clearCache').onclick = async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove([...Object.keys(all).filter((key) => key.startsWith('analysis:')), 'analysisIndex']);
  showMessage('Cache cleared.');
};
