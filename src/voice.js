// Listens for one incantation at a time with the browser's speech recognition
// (Chrome and Edge). Returns null when speech isn't available or nobody spoke,
// and the duel then uses a stock incantation so the spell still casts.
const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

export const voiceAvailable = Boolean(Recognition);

let queue = Promise.resolve();

export function listenOnce({ timeoutMs = 3500 } = {}) {
  const turn = queue.then(() => listen(timeoutMs));
  // Two players can't share one microphone, so they take turns.
  queue = turn.catch(() => null);
  return turn;
}

function listen(timeoutMs) {
  if (!Recognition) return Promise.resolve(null);
  return new Promise((resolve) => {
    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    let heard = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
      resolve(heard);
    };
    const timer = setTimeout(finish, timeoutMs);
    recognition.onresult = (event) => {
      heard = event.results[0]?.[0]?.transcript?.trim() || null;
      finish();
    };
    recognition.onerror = finish;
    recognition.onend = finish;
    try {
      recognition.start();
    } catch {
      finish();
    }
  });
}
