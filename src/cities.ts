import type { PinnedCity } from "./model";

type Row = [
  name: string,
  ascii: string,
  cc: string,
  lat: number,
  lon: number,
  pop: number,
  /** Space-separated, already-folded alternative spellings. */
  alt?: string,
];

export type CityHit = PinnedCity & { pop: number };

let rows: Row[] | null = null;
let loading: Promise<void> | null = null;
/** fold(name) — the display spelling, e.g. "koln". */
let names: string[] | null = null;
/** fold(asciiname) when it differs, e.g. "koeln". Empty otherwise. */
let asciis: string[] | null = null;
/** Pre-folded alternative spellings, space-padded for token tests. */
let alts: string[] | null = null;
/** First letter of a name -> row indices, to narrow fuzzy matching. */
let buckets: Map<string, number[]> | null = null;
/** First letter of any alternative spelling -> row indices. */
let altBuckets: Map<string, number[]> | null = null;

/**
 * Levenshtein distance, abandoned as soon as it provably exceeds `max`.
 * Bailing out early is what makes scanning a whole bucket per keystroke cheap.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = cur[0];
    const lo = Math.max(1, i - max);
    const hi = Math.min(b.length, i + max);
    if (lo > 1) cur[lo - 1] = max + 1;
    for (let j = lo; j <= hi; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (hi < b.length) cur[hi + 1] = max + 1;
    if (best > max) return max + 1;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length];
}

/**
 * How far off a spelling may be before it stops counting as the same place.
 * Generous, because this only ever fills slots literal matching left empty
 * and results are ranked by distance — "Olomutz" is 3 edits from "Olomouc".
 */
function tolerance(len: number): number {
  if (len <= 4) return 1;
  if (len <= 6) return 2;
  return Math.min(4, Math.round(len * 0.4));
}

/** Lowercase and strip accents so "munchen" also finds "München". */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** The dataset is ~1.5MB, so it is only fetched once the user starts typing. */
export function loadCities(): Promise<void> {
  if (!loading) {
    loading = fetch("data/cities.json")
      .then((r) => {
        if (!r.ok) throw new Error("cities unavailable");
        return r.json();
      })
      .then((j: { cities: Row[] }) => {
        rows = j.cities;
        // Both spellings are indexed: "Köln" folds to "koln" but its ascii
        // name is "Koeln", and a German user may type either.
        names = rows.map((r) => fold(r[0]));
        asciis = rows.map((r, i) => {
          const a = r[1] ? fold(r[1]) : "";
          return a === names![i] ? "" : a;
        });
        // Padded with spaces so a token prefix is a plain substring test.
        alts = rows.map((r) => (r[6] ? ` ${r[6]} ` : ""));
        // Bucketed on the first letter only: a transliteration usually keeps
        // it ("Olomutz"/"Olomouc") while diverging soon after, so two letters
        // was too strict to catch the spellings that actually need help.
        const push = (m: Map<string, number[]>, key: string, i: number) => {
          const list = m.get(key);
          if (list) list.push(i);
          else m.set(key, [i]);
        };
        buckets = new Map();
        altBuckets = new Map();
        for (let i = 0; i < names.length; i++) {
          for (const key of new Set([names[i][0], asciis[i][0]])) {
            if (key) push(buckets, key, i);
          }
          if (!alts[i]) continue;
          const seen = new Set<string>();
          for (const token of alts[i].split(" ")) {
            if (token && !seen.has(token[0])) {
              seen.add(token[0]);
              push(altBuckets, token[0], i);
            }
          }
        }
      })
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

export function searchCities(query: string, limit = 8): CityHit[] {
  if (!rows || !names || !asciis || !alts) return [];
  const q = fold(query);
  if (!q) return [];

  // Three tiers, best first: the city's own name starts with the query; an
  // alternative spelling does ("wien" -> Vienna); the query appears anywhere.
  // Without the tiers, "Florence" would rank Kisumu — which lists Florence as
  // an alias — above Florence itself.
  const byName: number[] = [];
  const byAlias: number[] = [];
  const byWords: number[] = [];
  const loose: number[] = [];
  const cap = limit * 3;

  // Split on punctuation too, so "Saint-Petersburg" matches "Saint Petersburg"
  // and "Rothenburg o. d. Tauber" survives its abbreviations. Order-insensitive,
  // which is what rescues "Novgorod Velikiy" from "Veliky Novgorod".
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  const multi = words.length >= 2;

  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    const s = asciis[i];
    const a = alts[i];
    if (n.startsWith(q) || (s && s.startsWith(q))) {
      if (byName.length < cap) byName.push(i);
    } else if (a && a.includes(` ${q}`)) {
      if (byAlias.length < cap) byAlias.push(i);
    } else if (multi && byWords.length < cap && words.every((w) => n.includes(w) || s.includes(w) || a.includes(w))) {
      byWords.push(i);
    } else if (loose.length < cap && (n.includes(q) || s.includes(q) || a.includes(q))) {
      loose.push(i);
    }
    if (byName.length >= cap && byAlias.length >= cap && (!multi || byWords.length >= cap)) break;
  }

  // Name and alias hits compete on population rather than tier, so "Wien"
  // offers Vienna before Wiener Neustadt. Matching the actual name is worth
  // roughly a doubling, which keeps Florence ahead of the larger Kisumu (an
  // old "Port Florence"). Loose substring hits stay at the bottom.
  const best = [
    ...byName.map((i) => [i, rows![i][5] * 2] as const),
    ...byAlias.map((i) => [i, rows![i][5]] as const),
    ...byWords.map((i) => [i, rows![i][5] * 1.5] as const),
  ]
    .sort((a, b) => b[1] - a[1])
    .map(([i]) => i);

  const out = [...best, ...loose];
  // Only when literal matching came up short: tolerate misspelt and
  // transliterated input, so "Reykiavik" still finds Reykjavík.
  if (out.length < limit) out.push(...fuzzyHits(q, new Set(out), limit - out.length));

  return out.slice(0, limit).map((i) => {
    const r = rows![i];
    return { name: r[0], cc: r[2], lat: r[3], lon: r[4], pop: r[5] };
  });
}

function fuzzyHits(q: string, seen: Set<number>, want: number): number[] {
  if (!names || !asciis || !alts || !buckets || !altBuckets || q.length < 4) return [];
  const max = tolerance(q.length);
  const scored: Array<[index: number, distance: number, pop: number]> = [];
  const taken = new Set(seen);

  const consider = (i: number, d: number) => {
    if (d > max || taken.has(i)) return;
    taken.add(i);
    scored.push([i, d, rows![i][5]]);
  };

  for (const i of buckets.get(q[0]) ?? []) {
    if (taken.has(i)) continue;
    let d = editDistance(q, names[i], max);
    if (d > max && asciis[i]) d = editDistance(q, asciis[i], max);
    consider(i, d);
  }
  // Alternative spellings get the same treatment, which is what turns
  // "Soloniki" into Thessaloniki by way of its alias "saloniki".
  for (const i of altBuckets.get(q[0]) ?? []) {
    if (taken.has(i)) continue;
    let best = max + 1;
    for (const token of alts[i].split(" ")) {
      if (token && token[0] === q[0]) best = Math.min(best, editDistance(q, token, max));
      if (best === 0) break;
    }
    consider(i, best);
  }

  // Closest spelling first, then the bigger city.
  scored.sort((a, b) => a[1] - b[1] || b[2] - a[2]);
  return scored.slice(0, want).map(([i]) => i);
}
