import { getSettings, saveSettings, domainOf, isDomainExcluded, todayKey } from './shared.js';

const enabled = document.querySelector('#enabled');
const minimum = document.querySelector('#minimumCharacters');
const mode = document.querySelector('#displayMode');
const siteButton = document.querySelector('#site');
const status = document.querySelector('#status');

let settings = await getSettings();
enabled.checked = settings.enabled; minimum.value = settings.minimumCharacters; mode.value = settings.displayMode;

const { usage = {}, dailyUsage } = await chrome.storage.local.get(['usage', 'dailyUsage']);
const today = dailyUsage?.day === todayKey() ? dailyUsage.count : 0;
const limit = Number(settings.dailyRequestLimit) || 0;
document.querySelector('#usage').textContent = `Today: ${today}${limit ? `/${limit}` : ''} requests · Tokens: ${(usage.totalTokens || 0).toLocaleString()} · Cost: $${Number(usage.estimatedCost || 0).toFixed(4)}`;

enabled.onchange = async () => { settings = await saveSettings({ enabled: enabled.checked }); };
minimum.onchange = async () => {
  const value = Number(minimum.value);
  const clamped = Number.isFinite(value) && value > 0 ? Math.max(300, Math.min(20000, Math.round(value))) : settings.minimumCharacters;
  minimum.value = clamped;
  settings = await saveSettings({ minimumCharacters: clamped });
};
mode.onchange = async () => { settings = await saveSettings({ displayMode: mode.value }); };
document.querySelector('#options').onclick = () => chrome.runtime.openOptionsPage();

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const domain = domainOf(tab?.url || '');
function renderSiteButton() {
  if (!domain) { siteButton.disabled = true; siteButton.textContent = 'Not available on this page'; return; }
  siteButton.textContent = isDomainExcluded(settings.excludedDomains, tab.url) ? `Enable for ${domain}` : `Disable for ${domain}`;
}
renderSiteButton();
siteButton.onclick = async () => {
  if (!domain) return;
  const excluded = settings.excludedDomains.map((d) => String(d).toLowerCase().replace(/^www\./, ''));
  const next = excluded.includes(domain) ? excluded.filter((x) => x !== domain) : [...excluded, domain];
  settings = await saveSettings({ excludedDomains: next });
  status.textContent = next.includes(domain) ? `Disabled on ${domain}` : `Enabled on ${domain}`;
  renderSiteButton();
};
