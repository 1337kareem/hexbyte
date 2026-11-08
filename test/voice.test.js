import assert from 'node:assert/strict';
import test from 'node:test';

// A stand-in for Chrome's speech recognition that "hears" words on a schedule.
class FakeRecognition {
  static script = [];
  start() {
    let delay = 0;
    for (const step of FakeRecognition.script) {
      delay += step.after;
      setTimeout(() => {
        if (this.stopped) return;
        if (step.text === null) this.onspeechend?.();
        else this.onresult?.({ results: [Object.assign([{ transcript: step.text }], { isFinal: Boolean(step.final) })] });
      }, delay);
    }
  }
  abort() {
    this.stopped = true;
  }
}
globalThis.webkitSpeechRecognition = FakeRecognition;
const { listenOnce, SILENCE_MS } = await import('../src/voice.js');

const timed = async (script) => {
  FakeRecognition.script = script;
  const partials = [];
  const started = Date.now();
  const heard = await listenOnce({ startMs: 1000, onPartial: (text) => partials.push(text) });
  return { heard, partials, ms: Date.now() - started };
};

test('listening ends half a second after the last word, without waiting for a final result', async () => {
  const { heard, partials, ms } = await timed([
    { after: 200, text: 'Flamingo' },
    { after: 300, text: 'Flamingo inferno' },
  ]);
  assert.equal(heard, 'Flamingo inferno');
  assert.deepEqual(partials, ['Flamingo', 'Flamingo inferno'], 'the bubble shows the words as they come');
  assert.ok(ms >= 500 + SILENCE_MS - 50 && ms < 500 + SILENCE_MS + 250, `ended after ${ms} ms`);
});

test('a final result ends listening right away', async () => {
  const { heard, ms } = await timed([{ after: 200, text: 'Burn it all', final: true }]);
  assert.equal(heard, 'Burn it all');
  assert.ok(ms < 400, `ended after ${ms} ms`);
});

test('a long incantation is not cut off once the wizard is talking', async () => {
  const { heard } = await timed([
    { after: 600, text: 'By the neon' },
    { after: 450, text: 'By the neon of Ocean Drive' },
    { after: 450, text: 'By the neon of Ocean Drive, burn' },
  ]);
  assert.equal(heard, 'By the neon of Ocean Drive, burn', 'still listening past the 1 s start window');
});

test('nobody speaking ends at the start window with nothing heard', async () => {
  const { heard, ms } = await timed([]);
  assert.equal(heard, null);
  assert.ok(ms >= 950 && ms < 1300, `ended after ${ms} ms`);
});
