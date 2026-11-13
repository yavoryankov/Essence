import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  domainOf, isDomainExcluded, parseModelJson, responseShape, maxTokensFor,
  predictInterest, pruneNewest, normalizeText, sha256, todayKey, stems
} from '../src/shared.js';

test('domainOf strips www and rejects non-web URLs', () => {
  assert.equal(domainOf('https://www.Faktor.bg/a'), 'faktor.bg');
  assert.equal(domainOf('chrome://extensions'), '');
  assert.equal(domainOf('not a url'), '');
});

test('isDomainExcluded matches www, subdomains and legacy www entries', () => {
  assert.ok(isDomainExcluded(['example.com'], 'https://www.example.com/x'));
  assert.ok(isDomainExcluded(['www.example.com'], 'https://example.com/'));
  assert.ok(isDomainExcluded(['example.com'], 'https://news.example.com/'));
  assert.ok(!isDomainExcluded(['example.com'], 'https://notexample.com/'));
  assert.ok(!isDomainExcluded([''], 'chrome://newtab'));
});

test('parseModelJson handles fences and coerces shapes', () => {
  const r = parseModelJson('```json\n{"essence":"x","topics":"AI","key_points":[{"text":"a"},2]}\n```');
  assert.equal(r.essence, 'x');
  assert.deepEqual(r.topics, ['AI']);
  assert.deepEqual(r.key_points, ['a', '2']);
  assert.deepEqual(r.keywords, []);
});

test('parseModelJson rejects truncated or non-object JSON', () => {
  assert.throws(() => parseModelJson('{"essence": "cut'), /incomplete/);
  assert.throws(() => parseModelJson('{"a":}'), /invalid/);
});

test('responseShape always requests topics and keywords', () => {
  const shape = JSON.parse(responseShape({}));
  assert.ok(shape.topics && shape.keywords);
  assert.ok(!shape.key_points);
});

test('maxTokensFor leaves room for Cyrillic output', () => {
  assert.ok(maxTokensFor({}) >= 800);
  assert.ok(maxTokensFor({ showKeyPoints: true }) > maxTokensFor({}));
});

test('stems match inflected forms and non-ASCII letters', () => {
  assert.deepEqual(stems('Election results'), stems('elections result'));
  assert.deepEqual(stems('naïveté'), stems('naïvetés'));
});

test('predictInterest needs 3 ratings and uses stemmed overlap', () => {
  const fb = [
    { rating: 'interesting', topics: ['Artificial intelligence'], keywords: [] },
    { rating: 'interesting', topics: ['artificial intelligence'], keywords: ['models'] },
    { rating: 'boring', topics: ['Football'], keywords: [] }
  ];
  assert.equal(predictInterest({ topics: ['AI'] }, fb.slice(0, 2)).score, null);
  const ai = predictInterest({ topics: ['Artificial intelligence'], keywords: [] }, fb);
  const sport = predictInterest({ topics: ['football league'], keywords: [] }, fb);
  assert.ok(ai.score > 50, `ai ${ai.score}`);
  assert.ok(sport.score < 50, `sport ${sport.score}`);
  assert.deepEqual(ai.reasons, ['Artificial intelligence']);
});

test('pruneNewest keeps newest entries', () => {
  const kept = pruneNewest({ a: { t: 1 }, b: { t: 3 }, c: { t: 2 } }, 2, 't');
  assert.deepEqual(Object.keys(kept).sort(), ['b', 'c']);
});

test('normalizeText, sha256 and todayKey', async () => {
  assert.equal(normalizeText('  a \n\t b '), 'a b');
  assert.equal(normalizeText(undefined), '');
  assert.equal((await sha256('abc')).slice(0, 8), 'ba7816bf');
  assert.equal(todayKey(new Date(2026, 0, 5)), '2026-01-05');
});

import { buildPrompt, DEFAULT_SYSTEM_PROMPT, MAX_CUSTOM_PROMPT_LENGTH } from '../src/shared.js';

test('buildPrompt uses default instructions and always appends the JSON format', () => {
  const { system, user } = buildPrompt({ outputLanguage: 'bg' }, 'T', 'x'.repeat(20000));
  assert.ok(system.startsWith(DEFAULT_SYSTEM_PROMPT));
  assert.match(system, /Return exactly this JSON shape/);
  assert.match(system, /Output language: Bulgarian\./);
  assert.equal(user.length, 'Title: T\n\nText:\n'.length + 12000);
});

test('buildPrompt uses custom instructions, caps their length and maps languages', () => {
  const { system } = buildPrompt({ customSystemPrompt: '  My prompt  ', outputLanguage: 'source' }, '', '');
  assert.ok(system.startsWith('My prompt\n'));
  assert.match(system, /Return exactly this JSON shape/);
  assert.match(system, /same as the source text/);
  const long = buildPrompt({ customSystemPrompt: 'a'.repeat(MAX_CUSTOM_PROMPT_LENGTH + 50) }, '', '').system;
  assert.ok(long.startsWith('a'.repeat(MAX_CUSTOM_PROMPT_LENGTH) + '\n'));
});

import { DEFAULT_SETTINGS } from '../src/shared.js';

test('summaries default to the language of the article', () => {
  assert.equal(DEFAULT_SETTINGS.outputLanguage, 'source');
  assert.match(buildPrompt({}, '', '').system, /Output language: same as the source text\./);
});
