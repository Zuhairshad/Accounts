/*
 * Forgiving search for pickers. Every typed word must match the label somewhere, in any order, by one of (best first):
 * an account code prefix, a word prefix, the initials of consecutive words ("ar" → Accounts Receivable), a substring,
 * the letters of one word in order ("rcvbl"), or a word with one letter wrong (two from seven letters; codes never).
 * The whole query may also be typed without spaces ("cashinhand"). Higher scores rank first; null means no match.
 */

const normalize = (text: string) => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/** Length of the longest common subsequence: how many typed letters appear in the word in order. */
function common(a: string, b: string) {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const char of a) {
    const row = [0];
    for (let j = 1; j <= b.length; j++) row.push(char === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], row[j - 1]));
    previous = row;
  }
  return previous[b.length];
}

const inOrder = (needle: string, haystack: string) => {
  let at = 0;
  for (const char of haystack) if (char === needle[at] && ++at === needle.length) return true;
  return false;
};

function wordScore(token: string, words: string[], text: string): number | null {
  if (/^\d+$/.test(token) && words[0]?.startsWith(token)) return 100;
  if (words.some((word) => word === token)) return 90;
  if (words.some((word) => word.startsWith(token))) return 80;
  if (token.length >= 2 && words.some((_, start) => words.slice(start, start + token.length).map((word) => word[0]).join("") === token)) return 60;
  if (text.includes(token)) return 45;
  if (/^\d+$/.test(token)) return null; // codes match exactly, never as typos
  if (token.length >= 3 && words.some((word) => word[0] === token[0] && inOrder(token, word))) return 35;
  if (token.length >= 4) {
    // Typos: all but one typed letter (two from seven letters) appear in order in a word with the same first letter.
    const allowed = token.length - (token.length >= 7 ? 2 : 1);
    const best = Math.max(0, ...words.filter((word) => word[0] === token[0]).map((word) => common(token, word)));
    if (best >= allowed) return 15 + 10 * (best / token.length);
  }
  return null;
}

export function searchScore(query: string, label: string): number | null {
  const tokens = normalize(query).split(" ").filter(Boolean);
  if (!tokens.length) return 0;
  const text = normalize(label);
  const words = text.split(" ");
  let total = 0;
  let matched = true;
  for (const token of tokens) {
    const score = wordScore(token, words, text);
    if (score === null) { matched = false; break; }
    total += score;
  }
  const joined = tokens.join("");
  if (!matched) {
    // Typed without spaces, or split differently from the label.
    if (joined.length >= 3 && words.join("").includes(joined)) total = 50 * tokens.length;
    else return null;
  }
  // Account labels lead with their code; compare the name part for "starts with" and exact-name bonuses.
  const name = text.replace(/^\d+ /, "");
  const phrase = tokens.join(" ");
  if (name.startsWith(phrase)) total += 30;
  if (name === phrase) total += 20;
  return total / tokens.length;
}

/** Matching items, best first; equal scores keep their original order. */
export function rankSearch<T>(query: string, items: T[], label: (item: T) => string) {
  if (!normalize(query)) return items;
  return items.map((item, index) => ({ item, index, score: searchScore(query, label(item)) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.item);
}
