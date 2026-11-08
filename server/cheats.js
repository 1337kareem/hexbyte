// HexByte's own cheat check, the last of three. An incantation is a spell, not a message
// to the game, so anything that talks to the referee or tries to set a score is a cheat:
// 1. Prune's injection shield blocks the classic prompt injections before the AI sees them.
// 2. The AI judge flags cheats in its reply (the "cheat" field of the rubric).
// 3. These patterns catch the rest, the same way every time, even if the AI misses one.
// A cheat backfires: the spell hits the wizard who cast it.
//
// They're written for what speech-to-text produces (lowercase, few commas) and checked
// against ordinary incantations, so "the full power of ten suns" is still a spell.
const PATTERNS = [
  // "ignore all previous instructions", "forget the rubric", "override the rules"
  /\b(ignore|forget|disregard|override|overrule|bypass|skip)\b[^.!?]{0,40}\b(instructions?|rules?|rubric|prompt|system|referee|judge|limits?|scoring)\b/,
  // Talking to the game or the AI instead of casting.
  /\b(referee|judge|rubric|system prompt|prompt|jailbreak|developer mode|language model|chatbot|json|system override)\b/,
  /\b(you are now|act as|pretend (to be|you are)|new instructions|from now on you)\b/,
  // "10 out of 10", "10/10", "100 out of 100"
  /\b(\d+|ten|hundred)\s*(\/|out of)\s*(\d+|ten|hundred)\b/,
  // "power to 10", "creativity 100", "damage = 9999", "points to max"
  /\b(power|damage|points?|score|creativity|rating|hp|health|mana)\s*(to|=|:|is|at)?\s*(\d+|max(imum)?|infinite|unlimited)\b/,
  // "deal 100 damage", "give me 10 power", "make it 100 points"
  /\b(deal|give|make|set|rate|score|award|grant)\b[^.!?]{0,25}\b(\d+|ten|hundred|max(imum)?|infinite|unlimited|full)\s+(power|damage|points?|score|creativity|rating|hp|health)\b/,
  // "score me 100", "rate this a 10"
  /\b(score|rate|grade)\s+(me|this|it|my \w+)\s+(an? )?(\d+|ten|hundred|max(imum)?|perfect)\b/,
  // "infinite damage", "maximum points", "full points"
  /\b(infinite|unlimited|max(imum)?|full|perfect)\s+(damage|points|score|creativity|rating|hp|health|mana)\b/,
];

export function looksLikeCheat(words) {
  const said = String(words ?? '').toLowerCase();
  return PATTERNS.some((pattern) => pattern.test(said));
}
