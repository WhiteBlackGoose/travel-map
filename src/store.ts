import { decodeState, encodeState } from "./codec";
import { cloneData, emptyData, isEmpty, type TravelData } from "./model";
import { detectLang, LANGS, type Lang } from "./i18n";

const DATA_KEY = "travel-map:data";
const SETTINGS_KEY = "travel-map:settings";

export type ThemeChoice = "auto" | "light" | "dark";
export type Mode = "own" | "shared";

export type Settings = { lang: Lang; theme: ThemeChoice };

function loadSettings(): Settings {
  let lang = detectLang();
  let theme: ThemeChoice = "auto";
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (LANGS.includes(s.lang)) lang = s.lang;
      if (["auto", "light", "dark"].includes(s.theme)) theme = s.theme;
    }
  } catch {
    // ignore corrupted settings and fall back to the detected defaults
  }
  return { lang, theme };
}

function storedPayload(): string | null {
  try {
    return localStorage.getItem(DATA_KEY);
  } catch {
    return null;
  }
}

async function loadOwn(): Promise<TravelData> {
  const raw = storedPayload();
  if (!raw) return emptyData();
  return (await decodeState(raw)) ?? emptyData();
}

/**
 * Holds the map being displayed plus where it came from.
 *
 * The crucial rule: while `mode` is "shared" nothing is ever written to
 * localStorage, so opening somebody else's link — and even editing it — leaves
 * your own map exactly as you left it. `adopt()` is the only way a shared map
 * can become yours, and it asks first.
 */
export class Store {
  data: TravelData = emptyData();
  mode: Mode = "own";
  settings: Settings = loadSettings();
  /** The map stashed away while a shared one is on screen. */
  private ownBackup: TravelData | null = null;
  private listeners = new Set<() => void>();
  private hashWriteTimer: number | undefined;
  private selfWrittenHash = "";

  async init() {
    const payload = location.hash.replace(/^#/, "");
    // Your own map is mirrored into the hash, so a reload or a bookmark of it
    // arrives looking exactly like a shared link. Matching it against what is
    // saved tells the two apart — otherwise reloading would strand you in
    // shared mode and quietly stop saving your edits.
    const shared = payload && payload !== storedPayload() ? await decodeState(payload) : null;
    if (shared) {
      this.mode = "shared";
      this.data = shared;
      this.ownBackup = await loadOwn();
    } else {
      this.mode = "own";
      this.data = await loadOwn();
      this.syncHash();
    }
    addEventListener("hashchange", () => this.onHashChange());
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** Apply a change to the map, then persist and re-share it. */
  update(fn: (d: TravelData) => void) {
    fn(this.data);
    this.persist();
    this.syncHash();
    this.emit();
  }

  updateSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // storage unavailable (private mode); settings just won't stick
    }
    this.emit();
  }

  private persist() {
    if (this.mode !== "own") return;
    void encodeState(this.data).then((s) => {
      try {
        localStorage.setItem(DATA_KEY, s);
      } catch {
        // quota or private mode — the URL still carries the map
      }
    });
  }

  /** Keeps the address bar holding a shareable snapshot of what's on screen. */
  private syncHash() {
    clearTimeout(this.hashWriteTimer);
    this.hashWriteTimer = setTimeout(() => {
      // An empty map gets a clean URL rather than a link to nothing.
      const payload = isEmpty(this.data) ? Promise.resolve("") : encodeState(this.data);
      void payload.then((s) => {
        if (location.hash.replace(/^#/, "") === s) return;
        this.selfWrittenHash = s;
        history.replaceState(null, "", s ? `#${s}` : location.pathname + location.search);
      });
    }, 150) as unknown as number;
  }

  private async onHashChange() {
    const payload = location.hash.replace(/^#/, "");
    if (payload === this.selfWrittenHash) return;
    if (payload && payload === storedPayload()) {
      // Navigated back to your own saved map — not somebody else's.
      if (this.mode === "shared") await this.restoreOwn();
      return;
    }
    const incoming = payload ? await decodeState(payload) : null;
    if (!incoming) return;
    if (this.mode === "own") this.ownBackup = cloneData(this.data);
    this.mode = "shared";
    this.data = incoming;
    this.emit();
  }

  /** Make the shared map on screen your own. Overwrites localStorage. */
  adopt() {
    this.mode = "own";
    this.ownBackup = null;
    this.persist();
    this.emit();
  }

  /** Drop the shared map and restore the one that was saved before. */
  async restoreOwn() {
    this.data = this.ownBackup ?? (await loadOwn());
    this.ownBackup = null;
    this.mode = "own";
    this.syncHash();
    this.emit();
  }

  reset() {
    this.data = emptyData();
    this.mode = "own";
    this.ownBackup = null;
    this.persist();
    this.syncHash();
    this.emit();
  }

  async shareUrl(): Promise<string> {
    const base = `${location.origin}${location.pathname}`;
    if (isEmpty(this.data)) return base;
    return `${base}#${await encodeState(this.data)}`;
  }
}
