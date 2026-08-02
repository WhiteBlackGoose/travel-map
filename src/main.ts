import "./style.css";

import { LANGS, LANG_LABEL, setLang, t, type Lang } from "./i18n";
import { MapView } from "./map";
import { cityKey, statesOf, visitedCountries, type PinnedCity } from "./model";
import { Store, type ThemeChoice } from "./store";
import { loadCities, searchCities, type CityHit } from "./cities";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const store = new Store();
let map: MapView;
let mapReady = false;

/* ------------------------------------------------------------------ theme */

function applyTheme(choice: ThemeChoice) {
  if (choice === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

/* ------------------------------------------------------------------- text */

function applyLang() {
  setLang(store.settings.lang);
  document.title = t("title");
  $("app-title").textContent = t("title");
  $("app-tagline").textContent = t("tagline");
  $("lbl-lang").textContent = t("language");
  $("lbl-theme").textContent = t("theme");
  $("banner-title").textContent = t("sharedBanner");
  $("banner-hint").textContent = t("sharedBannerHint");
  $("btn-adopt").textContent = t("importShared");
  $("btn-back").textContent = t("backToMine");
  $("stat-countries-lbl").textContent = t("countries");
  $("stat-regions-lbl").textContent = t("regions");
  $("stat-cities-lbl").textContent = t("cities");
  $("stat-pct-lbl").textContent = t("worldPercent");
  $("h-cities").textContent = t("addCity");
  $("h-places").textContent = t("selectedList");
  $("h-share").textContent = t("share");
  $("share-hint").textContent = t("shareHint");
  $("btn-copy").textContent = t("copyLink");
  $("btn-reset").textContent = t("reset");
  $<HTMLInputElement>("city-input").placeholder = t("cityPlaceholder");
  $("zoom-in").title = t("zoomIn");
  $("zoom-out").title = t("zoomOut");
  $("zoom-reset").title = t("zoomReset");

  const themeSel = $<HTMLSelectElement>("theme-select");
  const themeLabels: Record<ThemeChoice, string> = {
    auto: t("themeAuto"),
    light: t("themeLight"),
    dark: t("themeDark"),
  };
  for (const opt of Array.from(themeSel.options)) {
    opt.textContent = themeLabels[opt.value as ThemeChoice];
  }

  if (mapReady) map.relabel();
}

/* --------------------------------------------------------------- controls */

function buildSelectors() {
  const langSel = $<HTMLSelectElement>("lang-select");
  for (const l of LANGS) {
    const o = document.createElement("option");
    o.value = l;
    o.textContent = LANG_LABEL[l];
    langSel.append(o);
  }
  langSel.value = store.settings.lang;
  langSel.addEventListener("change", () => {
    store.updateSettings({ lang: langSel.value as Lang });
    applyLang();
    render();
  });

  const themeSel = $<HTMLSelectElement>("theme-select");
  for (const v of ["auto", "light", "dark"] as ThemeChoice[]) {
    const o = document.createElement("option");
    o.value = v;
    themeSel.append(o);
  }
  themeSel.value = store.settings.theme;
  themeSel.addEventListener("change", () => {
    const choice = themeSel.value as ThemeChoice;
    store.updateSettings({ theme: choice });
    applyTheme(choice);
  });
}

/* ------------------------------------------------------------ map actions */

function toggleCountry(cc: string) {
  store.update((d) => {
    if (d.countries.has(cc)) {
      d.countries.delete(cc);
    } else {
      // A partly-visited country becomes fully visited on a plain click.
      for (const s of statesOf(d, cc)) d.states.delete(s);
      d.countries.add(cc);
    }
  });
}

function toggleState(code: string) {
  store.update((d) => {
    if (!d.states.delete(code)) d.states.add(code);
  });
}

/**
 * Collapses a country back to a single shape. Any visited region makes the
 * whole country count as visited; keep it split for the per-region detail.
 */
function uniteCountry(cc: string) {
  store.update((d) => {
    d.expanded.delete(cc);
    const chosen = statesOf(d, cc);
    if (chosen.length > 0) {
      for (const s of chosen) d.states.delete(s);
      d.countries.add(cc);
    }
  });
}

function toggleExpand(cc: string) {
  if (store.data.expanded.has(cc)) {
    uniteCountry(cc);
    return;
  }
  store.update((d) => {
    d.expanded.add(cc);
    // Splitting a visited country pre-selects all of its regions.
    if (d.countries.delete(cc)) {
      for (const f of map.regionsOf(cc)) d.states.add(f.id);
    }
  });
  map.zoomTo(cc);
}

function removeCity(key: string) {
  store.update((d) => {
    d.cities = d.cities.filter((c) => cityKey(c) !== key);
  });
}

function addCity(c: CityHit) {
  const pin: PinnedCity = { name: c.name, cc: c.cc, lat: c.lat, lon: c.lon };
  store.update((d) => {
    if (!d.cities.some((x) => cityKey(x) === cityKey(pin))) d.cities.push(pin);
  });
}

/* ------------------------------------------------------- city combo box */

function setupCityInput() {
  const input = $<HTMLInputElement>("city-input");
  const list = $<HTMLUListElement>("city-results");
  let hits: CityHit[] = [];
  let active = -1;
  let loaded = false;

  const close = () => {
    list.hidden = true;
    list.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    hits = [];
    active = -1;
  };

  const paint = () => {
    list.innerHTML = "";
    if (!hits.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = t("noCityMatch");
      list.append(li);
    } else {
      hits.forEach((h, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === active));
        const name = document.createElement("span");
        name.textContent = h.name;
        const cc = document.createElement("span");
        cc.className = "cc";
        cc.textContent = h.cc;
        li.append(name, cc);
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(i);
        });
        list.append(li);
      });
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  const choose = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    addCity(hit);
    input.value = "";
    close();
  };

  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) return close();
    if (!loaded) {
      try {
        await loadCities();
        loaded = true;
      } catch {
        return close();
      }
      // The user may have kept typing while the dataset was downloading.
      if (input.value.trim() !== q) return;
    }
    hits = searchCities(q);
    active = hits.length ? 0 : -1;
    paint();
  };

  let timer: number | undefined;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120) as unknown as number;
  });
  input.addEventListener("focus", () => {
    void loadCities().catch(() => {});
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (e) => {
    if (list.hidden || !hits.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
      paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      close();
    }
  });
}

/* ------------------------------------------------------------- rendering */

function renderStats() {
  const d = store.data;
  const visited = visitedCountries(d);
  $("stat-countries").textContent = String(visited.size);
  $("stat-regions").textContent = String(d.states.size);
  $("stat-cities").textContent = String(d.cities.length);
  const total = mapReady ? map.countryCount : 0;
  $("stat-pct").textContent = total ? `${Math.round((visited.size / total) * 100)}%` : "–";
}

function chip(label: string, onRemove: () => void, cls = ""): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `chip ${cls}`.trim();
  const span = document.createElement("span");
  span.textContent = label;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = t("removeCity");
  btn.setAttribute("aria-label", `${t("removeCity")}: ${label}`);
  btn.textContent = "×";
  btn.addEventListener("click", onRemove);
  li.append(span, btn);
  return li;
}

function renderPlaces() {
  const d = store.data;
  const host = $("place-list");
  host.innerHTML = "";

  const group = (title: string, items: HTMLLIElement[], uniteCC?: string) => {
    if (!items.length) return;
    const wrap = document.createElement("div");
    wrap.className = "group";
    const h = document.createElement("div");
    h.className = "group-title";
    const label = document.createElement("span");
    label.textContent = title;
    h.append(label);
    if (uniteCC) {
      // A spelled-out alternative to the map's hover button.
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "group-unite";
      btn.textContent = t("mergeBack");
      btn.addEventListener("click", () => uniteCountry(uniteCC));
      h.append(btn);
    }
    const ul = document.createElement("ul");
    ul.className = "chips";
    ul.append(...items);
    wrap.append(h, ul);
    host.append(wrap);
  };

  const countryChips = [...d.countries]
    .map((cc) => ({ cc, name: map.countryName(cc) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => chip(c.name, () => store.update((x) => void x.countries.delete(c.cc))));

  const byCountry = new Map<string, HTMLLIElement[]>();
  for (const code of [...d.states].sort()) {
    const cc = code.slice(0, code.indexOf("-"));
    const item = chip(map.stateName(code), () => store.update((x) => void x.states.delete(code)));
    (byCountry.get(cc) ?? byCountry.set(cc, []).get(cc)!).push(item);
  }

  group(t("countries"), countryChips);
  for (const [cc, items] of byCountry) {
    group(t("statesOf", { country: map.countryName(cc) }), items, cc);
  }

  if (!host.childElementCount) {
    const p = document.createElement("p");
    p.className = "muted";
    p.style.margin = "0";
    p.textContent = t("nothingSelected");
    host.append(p);
  }
}

function renderCityChips() {
  const ul = $<HTMLUListElement>("city-list");
  ul.innerHTML = "";
  for (const c of store.data.cities) {
    ul.append(chip(c.name, () => removeCity(cityKey(c)), "pin-chip"));
  }
}

function renderBanner() {
  $("shared-banner").hidden = store.mode !== "shared";
}

let shareTimer: number | undefined;
function renderShare() {
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => {
    void store.shareUrl().then((url) => {
      $<HTMLInputElement>("share-url").value = url;
    });
  }, 200) as unknown as number;
}

function render() {
  if (mapReady) map.render(store.data);
  renderStats();
  renderPlaces();
  renderCityChips();
  renderBanner();
  renderShare();
}

/* ----------------------------------------------------------------- share */

function setupShare() {
  $("btn-copy").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("btn-copy");
    const url = $<HTMLInputElement>("share-url").value;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      $<HTMLInputElement>("share-url").select();
      document.execCommand?.("copy");
    }
    btn.textContent = t("copied");
    setTimeout(() => (btn.textContent = t("copyLink")), 1400);
  });


  $("btn-reset").addEventListener("click", () => {
    if (confirm(t("resetConfirm"))) store.reset();
  });

  $("btn-adopt").addEventListener("click", () => {
    if (confirm(t("importConfirm"))) store.adopt();
  });

  $("btn-back").addEventListener("click", () => void store.restoreOwn());
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  await store.init();
  applyTheme(store.settings.theme);
  buildSelectors();
  applyLang();
  setupCityInput();
  setupShare();
  store.subscribe(render);

  $("map-status").textContent = t("loading");
  map = new MapView($("map"), {
    onToggleCountry: toggleCountry,
    onToggleState: toggleState,
    onToggleExpand: toggleExpand,
    onRemoveCity: removeCity,
  });

  addEventListener("keydown", (e) => {
    if (e.key === "Escape") map.closeCityPopup();
  });

  $("zoom-in").addEventListener("click", () => map.zoomBy(1.6));
  $("zoom-out").addEventListener("click", () => map.zoomBy(1 / 1.6));
  $("zoom-reset").addEventListener("click", () => map.resetZoom());

  try {
    await map.load();
    mapReady = true;
    // Regions only exist for a few countries; drop stale expansions.
    store.update((d) => {
      for (const cc of [...d.expanded]) if (!map.canSplit(cc)) d.expanded.delete(cc);
    });
    $("map-status").textContent = "";
  } catch {
    $("map-status").textContent = t("loadError");
  }
  render();
}

void boot();
