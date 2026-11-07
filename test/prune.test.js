import assert from 'node:assert/strict';
import test from 'node:test';
import { rawObjectAfter, readJson, replyText, tamperWith } from '../server/prune.js';

test('reads replies in both Gemini and OpenAI formats', () => {
  assert.equal(replyText({ candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }] }), '{"a":1}');
  assert.equal(replyText({ choices: [{ message: { content: 'hi' } }] }), 'hi');
  assert.equal(replyText({}), '');
});

test('pulls JSON out of fenced or chatty replies', () => {
  assert.deepEqual(readJson('```json\n{"power": 7}\n```'), { power: 7 });
  assert.deepEqual(readJson('Sure! {"name":"Bolt"} hope that helps'), { name: 'Bolt' });
  assert.equal(readJson('no json here'), null);
  assert.equal(readJson('{broken'), null);
});

test('keeps the receipt text exactly as sent, including 0.0 and braces inside strings', () => {
  const body = '{"candidates":[],"prune_metadata":{"cost":0.0,"note":"a } and a \\" quote {","inner":{"x":1}},"z":2}';
  assert.equal(rawObjectAfter(body, 'prune_metadata'), '{"cost":0.0,"note":"a } and a \\" quote {","inner":{"x":1}}');
  assert.equal(rawObjectAfter('{"a":1}', 'prune_metadata'), null);
});

test('the tamper test changes the cost and nothing else', () => {
  const raw = '{"cost_with_prune_usd": 0.000012,"model":"m"}';
  assert.equal(tamperWith(raw), '{"cost_with_prune_usd": 0.5,"model":"m"}');
});
