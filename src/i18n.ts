export type Lang = "en" | "de" | "fr";

export const LANGS: Lang[] = ["en", "de", "fr"];

export const LANG_LABEL: Record<Lang, string> = {
  en: "English",
  de: "Deutsch",
  fr: "Français",
};

type Dict = {
  title: string;
  tagline: string;
  countries: string;
  regions: string;
  cities: string;
  worldPercent: string;
  addCity: string;
  cityPlaceholder: string;
  noCityMatch: string;
  removeCity: string;
  share: string;
  shareHint: string;
  copyLink: string;
  copied: string;
  reset: string;
  resetConfirm: string;
  splitInto: string;
  mergeBack: string;
  sharedBanner: string;
  sharedBannerHint: string;
  importShared: string;
  importConfirm: string;
  backToMine: string;
  language: string;
  theme: string;
  themeAuto: string;
  themeLight: string;
  themeDark: string;
  loading: string;
  loadError: string;
  zoomIn: string;
  zoomOut: string;
  zoomReset: string;
  selectedList: string;
  nothingSelected: string;
  statesOf: string;
  clearCities: string;
};

const en: Dict = {
  title: "Travel Map",
  tagline: "Click the countries you've been to.",
  countries: "Countries",
  regions: "Regions",
  cities: "Cities",
  worldPercent: "of the world",
  addCity: "Add city",
  cityPlaceholder: "Type a city…",
  noCityMatch: "No city found",
  removeCity: "Remove",
  share: "Share",
  shareHint: "This link contains your whole map. It updates as you edit.",
  copyLink: "Copy link",
  copied: "Copied!",
  reset: "Reset",
  resetConfirm: "Clear your entire map? This cannot be undone.",
  splitInto: "Split into regions",
  mergeBack: "Unite into one country",
  sharedBanner: "You're viewing a shared map.",
  sharedBannerHint: "Your own map is untouched.",
  importShared: "Save as my map",
  importConfirm: "Replace your own map with this shared one?",
  backToMine: "Back to my map",
  language: "Language",
  theme: "Theme",
  themeAuto: "Auto",
  themeLight: "Light",
  themeDark: "Dark",
  loading: "Loading map…",
  loadError: "Could not load the map data.",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomReset: "Reset view",
  selectedList: "Your places",
  nothingSelected: "Nothing selected yet.",
  statesOf: "Regions of {country}",
  clearCities: "Clear all cities",
};

const de: Dict = {
  title: "Reisekarte",
  tagline: "Klicke die Länder an, in denen du warst.",
  countries: "Länder",
  regions: "Regionen",
  cities: "Städte",
  worldPercent: "der Welt",
  addCity: "Stadt hinzufügen",
  cityPlaceholder: "Stadt eingeben…",
  noCityMatch: "Keine Stadt gefunden",
  removeCity: "Entfernen",
  share: "Teilen",
  shareHint: "Dieser Link enthält deine ganze Karte. Er aktualisiert sich beim Bearbeiten.",
  copyLink: "Link kopieren",
  copied: "Kopiert!",
  reset: "Zurücksetzen",
  resetConfirm: "Gesamte Karte löschen? Das lässt sich nicht rückgängig machen.",
  splitInto: "In Regionen aufteilen",
  mergeBack: "Zu einem Land vereinen",
  sharedBanner: "Du siehst eine geteilte Karte.",
  sharedBannerHint: "Deine eigene Karte bleibt unverändert.",
  importShared: "Als meine Karte speichern",
  importConfirm: "Deine eigene Karte durch diese geteilte ersetzen?",
  backToMine: "Zurück zu meiner Karte",
  language: "Sprache",
  theme: "Design",
  themeAuto: "Automatisch",
  themeLight: "Hell",
  themeDark: "Dunkel",
  loading: "Karte wird geladen…",
  loadError: "Die Kartendaten konnten nicht geladen werden.",
  zoomIn: "Vergrößern",
  zoomOut: "Verkleinern",
  zoomReset: "Ansicht zurücksetzen",
  selectedList: "Deine Orte",
  nothingSelected: "Noch nichts ausgewählt.",
  statesOf: "Regionen von {country}",
  clearCities: "Alle Städte löschen",
};

const fr: Dict = {
  title: "Carte de voyage",
  tagline: "Clique sur les pays que tu as visités.",
  countries: "Pays",
  regions: "Régions",
  cities: "Villes",
  worldPercent: "du monde",
  addCity: "Ajouter une ville",
  cityPlaceholder: "Saisir une ville…",
  noCityMatch: "Aucune ville trouvée",
  removeCity: "Retirer",
  share: "Partager",
  shareHint: "Ce lien contient toute ta carte. Il se met à jour automatiquement.",
  copyLink: "Copier le lien",
  copied: "Copié !",
  reset: "Réinitialiser",
  resetConfirm: "Effacer toute la carte ? Cette action est irréversible.",
  splitInto: "Diviser en régions",
  mergeBack: "Réunir en un seul pays",
  sharedBanner: "Tu consultes une carte partagée.",
  sharedBannerHint: "Ta propre carte n'est pas modifiée.",
  importShared: "Enregistrer comme ma carte",
  importConfirm: "Remplacer ta propre carte par celle-ci ?",
  backToMine: "Retour à ma carte",
  language: "Langue",
  theme: "Thème",
  themeAuto: "Auto",
  themeLight: "Clair",
  themeDark: "Sombre",
  loading: "Chargement de la carte…",
  loadError: "Impossible de charger les données de la carte.",
  zoomIn: "Zoom avant",
  zoomOut: "Zoom arrière",
  zoomReset: "Réinitialiser la vue",
  selectedList: "Tes lieux",
  nothingSelected: "Rien de sélectionné pour l'instant.",
  statesOf: "Régions de {country}",
  clearCities: "Effacer toutes les villes",
};

const DICTS: Record<Lang, Dict> = { en, de, fr };

let current: Lang = "en";

export function setLang(l: Lang) {
  current = l;
  document.documentElement.lang = l;
}

export function getLang(): Lang {
  return current;
}

export function detectLang(): Lang {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.slice(0, 2).toLowerCase() as Lang;
    if (LANGS.includes(base)) return base;
  }
  return "en";
}

export function t(key: keyof Dict, vars?: Record<string, string>): string {
  let s = DICTS[current][key] ?? DICTS.en[key] ?? String(key);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

/** Picks the localized name off a TopoJSON feature's properties. */
export function localName(props: { name: string; name_de?: string; name_fr?: string }): string {
  if (current === "de") return props.name_de || props.name;
  if (current === "fr") return props.name_fr || props.name;
  return props.name;
}
