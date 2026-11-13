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

test('stems match inflected Bulgarian forms', () => {
  assert.deepEqual(stems('Изкуствен интелект'), stems('изкуствения интелекта'));
});

test('predictInterest needs 3 ratings and uses stemmed overlap', () => {
  const fb = [
    { rating: 'interesting', topics: ['Изкуствен интелект'], keywords: [] },
    { rating: 'interesting', topics: ['изкуствения интелект'], keywords: ['модели'] },
    { rating: 'boring', topics: ['Футбол'], keywords: [] }
  ];
  assert.equal(predictInterest({ topics: ['AI'] }, fb.slice(0, 2)).score, null);
  const ai = predictInterest({ topics: ['Изкуствен интелект'], keywords: [] }, fb);
  const sport = predictInterest({ topics: ['футбола'], keywords: [] }, fb);
  assert.ok(ai.score > 50, `ai ${ai.score}`);
  assert.ok(sport.score < 50, `sport ${sport.score}`);
  assert.deepEqual(ai.reasons, ['Изкуствен интелект']);
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
