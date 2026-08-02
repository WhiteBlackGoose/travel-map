export type PinnedCity = {
  name: string;
  cc: string;
  lat: number;
  lon: number;
};

export type TravelData = {
  /** ISO 3166-1 alpha-2 codes of countries counted as visited as a whole. */
  countries: Set<string>;
  /** ISO 3166-2 codes, e.g. "US-CA". Only for countries currently split. */
  states: Set<string>;
  /** Countries drawn as their regions rather than one shape. View state only. */
  expanded: Set<string>;
  cities: PinnedCity[];
};

export function emptyData(): TravelData {
  return { countries: new Set(), states: new Set(), expanded: new Set(), cities: [] };
}

export function cloneData(d: TravelData): TravelData {
  return {
    countries: new Set(d.countries),
    states: new Set(d.states),
    expanded: new Set(d.expanded),
    cities: d.cities.map((c) => ({ ...c })),
  };
}

export function isEmpty(d: TravelData): boolean {
  return d.countries.size === 0 && d.states.size === 0 && d.cities.length === 0;
}

export function cityKey(c: PinnedCity): string {
  return `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;
}

export function statesOf(d: TravelData, cc: string): string[] {
  const prefix = cc + "-";
  return [...d.states].filter((s) => s.startsWith(prefix));
}

/**
 * A country counts as visited if it is selected outright or if any of its
 * regions is. Used for both the map fill and the headline counter.
 */
export function visitedCountries(d: TravelData): Set<string> {
  const out = new Set(d.countries);
  for (const s of d.states) {
    const cc = s.slice(0, s.indexOf("-"));
    if (cc) out.add(cc);
  }
  return out;
}
