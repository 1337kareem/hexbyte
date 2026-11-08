// Names for face login, used by the lobby (what the wizard said) and the server (who they are).

// "kAREEM   smith!" becomes "Kareem Smith".
export function cleanName(name) {
  return String(name ?? '')
    .replace(/[^\p{L}\p{M}' -]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .split(' ')
    .filter((word) => /\p{L}/u.test(word))
    .map((word) => word.toLowerCase().replace(/(^|[-'])(\p{L})/gu, (_, mark, letter) => mark + letter.toUpperCase()))
    .join(' ');
}

// What people actually say: "Hi, my name is Kareem Smith." becomes "Kareem Smith".
const LEAD_IN =
  /^(?:(?:hi|hey|hello|yo|okay|ok|um+|uh+|so|well)[\s,.!]+)*(?:my name is|my name's|the name is|name's|i am|i'm|im|it is|it's|its|this is|call me)\s+/i;

export function nameFromSpeech(text) {
  const said = String(text ?? '').trim().replace(LEAD_IN, '');
  // A first name, or a first and last name.
  return cleanName(said).split(' ').slice(0, 2).join(' ');
}

// How a name sounds, so spellings that sound alike match: Jaden, Jadyn, Jayden and
// Jaiden are all "jdn"; Kareem and Karim are "krm"; Sean, Shawn and Shaun are "sn".
// A small take on Soundex: unify letters that sound alike, then keep the consonants.
export function soundKey(word) {
  const w = String(word ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z]/g, '')
    .replace(/^kn/, 'n')
    .replace(/^wr/, 'r')
    .replace(/^ps/, 's')
    .replace(/ph/g, 'f')
    .replace(/sch/g, 'sk')
    .replace(/ch/g, 'k')
    .replace(/sh/g, 's')
    .replace(/th/g, 't')
    .replace(/dg/g, 'j')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/g(?=[eiy])/g, 'j')
    .replace(/[cq]/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's');
  if (!w) return '';
  // A name starting with a vowel sound keeps that it did (Aidan, Eden), but not which one.
  const first = /[aeiou]/.test(w[0]) ? 'a' : w[0];
  return (first + w.slice(1).replace(/[aeiouyhw]/g, '')).replace(/(.)\1+/g, '$1');
}

// "Kareem" matches "Kareem Smith" and "Karim". "Kareem Smith" does not match "Kareem Jones".
export function namesMatch(stored, spoken) {
  const a = cleanName(stored).split(' ').filter(Boolean).map(soundKey);
  const b = cleanName(spoken).split(' ').filter(Boolean).map(soundKey);
  if (!a.length || !b.length) return false;
  const words = Math.min(a.length, b.length);
  return a.slice(0, words).every((key, i) => key === b[i]);
}

// The answer to "Are you sure that's your name?", said out loud.
export function answerFromSpeech(text) {
  const said = String(text ?? '').toLowerCase();
  if (/\b(no|nope|nah|wrong|incorrect|not)\b/.test(said)) return 'no';
  if (/\b(yes|yeah|yep|yup|yah|correct|right|sure|true|exactly)\b/.test(said)) return 'yes';
  return null;
}
