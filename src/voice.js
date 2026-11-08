// Listens for one incantation at a time with the browser's speech recognition
// (Chrome and Edge). Returns null when speech isn't available or nobody spoke,
// and the duel then uses a stock incantation so the spell still casts.
//
// The spell fires the moment listening ends, so listening ends as soon as the
// wizard stops talking: half a second after the last word, not when Chrome gets
// around to a "final" result.
const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

export const voiceAvailable = Boolean(Recognition);

// How long after the last word listening stops.
export const SILENCE_MS = 500;
// Nobody spoke within this long: cast with a stock incantation.
const START_MS = 3000;
// Nobody can talk forever.
const MAX_MS = 6000;

let queue = Promise.resolve();
// Ends whatever is listening right now (the face login stops it when someone clicks).
let stopCurrent = null;
export function stopListening() {
  stopCurrent?.();
}

// onPartial(text) hears the words as they come in, for the speech bubble.
export function listenOnce({ startMs = START_MS, onPartial } = {}) {
  const turn = queue.then(() => listen(startMs, onPartial));
  // Two players can't share one microphone, so they take turns.
  queue = turn.catch(() => null);
  return turn;
}

function listen(startMs, onPartial) {
  if (!Recognition) return Promise.resolve(null);
  return new Promise((resolve) => {
    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    let heard = null;
    let speaking = false;
    let finished = false;
    let silence = null;
    const timers = [];
    const finish = () => {
      if (finished) return;
      finished = true;
      if (stopCurrent === finish) stopCurrent = null;
      clearTimeout(silence);
      timers.forEach(clearTimeout);
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
      resolve(heard);
    };
    stopCurrent = finish;
    const quietSoon = (ms = SILENCE_MS) => {
      clearTimeout(silence);
      silence = setTimeout(finish, ms);
    };
    timers.push(
      setTimeout(() => {
        if (!speaking) finish();
      }, startMs),
      setTimeout(finish, MAX_MS),
    );
    recognition.onspeechstart = () => {
      speaking = true;
    };
    recognition.onresult = (event) => {
      speaking = true;
      let text = '';
      let final = false;
      for (const result of event.results) {
        text += result[0]?.transcript ?? '';
        if (result.isFinal) final = true;
      }
      heard = text.trim() || heard;
      if (heard) onPartial?.(heard);
      if (final) finish();
      else quietSoon();
    };
    recognition.onspeechend = () => quietSoon(250);
    recognition.onerror = finish;
    recognition.onend = finish;
    try {
      recognition.start();
    } catch {
      finish();
    }
  });
}
