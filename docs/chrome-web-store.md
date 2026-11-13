# Chrome Web Store submission kit

Everything needed to publish Essence in the Chrome Web Store, ready to copy into the
[Developer Dashboard](https://chrome.google.com/webstore/devconsole).

## 1. Package

```bash
npm run package        # creates dist/essence-<version>.zip
```

The ZIP contains only `manifest.json`, `LICENSE`, `src/` and `icons/`. Upload it under **Package**.

## 2. Store listing

**Name:** Essence

**Summary** (max 132 characters):

> Summarizes long articles with AI on demand, in a popup. The page is never changed. Bring your own OpenAI, Claude or Grok key.

**Description:**

> Essence adds a small icon next to long articles. Click it and a short AI summary of the article appears in a popup. Nothing on the page is inserted, hidden or rearranged.
>
> • On demand only: nothing is sent until you click the icon.
> • Bring your own AI provider: OpenAI, Claude (Anthropic), Grok (xAI) or any OpenAI-compatible API.
> • Optional key points, topics, a conclusion and a personal interest score.
> • Learns locally from your Interesting / Boring ratings.
> • Edit the exact prompt sent to the AI, with a live preview.
> • Daily request limit, token and cost tracking, and a cache so the same text is never paid for twice.
> • Turn it off on any site with one click.
>
> Essence has no server of its own. Your API key and ratings stay in your browser.
>
> Open source (MIT): https://github.com/yavoryankov/Essence

**Category:** Productivity (Tools)

**Language:** English

## 3. Graphics

| Asset | Size | File |
|---|---|---|
| Store icon | 128×128 | `icons/target-128.png` |
| Screenshot 1 | 1280×800 | `docs/store/screenshot-1-icon.png` |
| Screenshot 2 | 1280×800 | `docs/store/screenshot-2-popup.png` |
| Small promo tile | 440×280 | `docs/store/promo-small-440x280.png` |

## 4. Privacy practices tab

**Single purpose:**

> Summarize the article on the current page with an AI provider chosen by the user, when the user clicks the Essence icon.

**Permission justifications:**

- `storage`: Saves the user's settings, API keys, cached summaries, ratings and usage counters locally.
- Host permission (`<all_urls>`): Detects long articles on the pages the user visits to show the Essence icon, and sends the article to the AI endpoint the user configured when the icon is clicked. Users can choose any provider URL, so access cannot be limited to fixed hosts.

**Remote code:** No, I am not using remote code.

**Data usage** (what to tick):

- **Website content**: yes. Article text and title are sent to the user's chosen AI provider when the user clicks the icon.
- Everything else (personally identifiable information, health, financial, authentication, personal communications, location, web history, user activity): no.

Certify all three statements:

- not sold to third parties;
- not used or transferred for purposes unrelated to the item's single purpose;
- not used or transferred to determine creditworthiness or for lending purposes.

**Privacy policy URL:**

```
https://github.com/yavoryankov/Essence/blob/main/PRIVACY.md
```

## 5. Before you submit

- Developer account: one-time $5 registration fee. Your publisher name and contact email are shown publicly.
- Test the exact ZIP: unzip it, choose **Load unpacked** in `chrome://extensions`, and try one or two articles.
- Review usually takes from a few days to a few weeks. Broad host permissions can make it take longer.
