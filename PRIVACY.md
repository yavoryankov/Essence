# Essence – Privacy Policy

_Last updated: November 13, 2026_

Essence is a browser extension that summarizes articles with an AI provider chosen by you. This policy explains what data it handles.

## What Essence does not do

- It has no server of its own. The author of Essence does not receive, collect, store or sell any of your data.
- It does not track your browsing, show ads or use analytics.
- It never sends anything until you click the Essence icon next to an article.

## Data sent to your AI provider

When you click the Essence icon, the extension sends the following to the AI provider endpoint you configured in Settings (for example OpenAI, Anthropic or xAI):

- the title of the page;
- up to 12,000 characters of the article text;
- the instructions (prompt) shown in Settings.

The request is authenticated with your own API key. How the provider handles this data is governed by that provider's own privacy policy and terms.

## Data stored in your browser

Essence uses `chrome.storage.local` in your Chrome profile. This storage stays on your device and is not synced. It holds:

- your settings, including your API keys (stored unencrypted);
- cached summaries (the newest 300);
- your *Interesting* / *Boring* ratings with the topics and keywords of rated articles (the newest 2,000);
- request and token counters used for the daily limit and cost estimate.

You can delete the ratings, the usage counters and the cached summaries from the Settings page. Removing the extension deletes all of this data.

## Permissions

- **storage**: to keep the settings, cache and ratings listed above.
- **Access to all websites**: to detect long articles on the pages you visit and to call the AI endpoint you choose. Page content is read locally and is sent only as described above.

## Contact

Questions or concerns: open an issue at https://github.com/yavoryankov/Essence/issues
