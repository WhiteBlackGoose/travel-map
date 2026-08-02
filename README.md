# Travel Map

Mark the countries you've been to, pin the cities, and share the whole thing as a
link. No backend, no accounts, no tracking — the map lives in the URL.

**<https://travel-map.wbg.gg>**

## What it does

- **Click a country** on the world map to mark it visited.
- **Split into regions** — hover a country with region data and a small button appears
  that breaks it into its states, cantons, régions or provinces, each clickable
  on its own. Merging unites them back into one country.
- **Pin cities** by typing them. ~235 000 places are bundled, so the lookup is
  instant and offline. It matches local spellings (`München`, `Wien`, `Genève`),
  tolerates misspellings (`Reykiavik`, `Olomutz`) and ignores word order
  (`Novgorod Velikiy`). Clicking a pin opens a popover to remove it.
- **Share** via a URL whose fragment *is* the map, base64url-encoded and
  deflate-compressed. It updates as you edit.
- **Autosaves** to localStorage.
- **EN / DE / FR**, autodetected from the browser and switchable.
- **Light / dark**, following the OS by default, overridable.

### Opening someone else's link never touches your own map

A link with a `#payload` puts the app in *shared* mode: the map on screen is the
one from the link, a banner says so, and **nothing is written to localStorage** —
not even if you click around and edit it. Your own map is restored by
*Back to my map*. *Save as my map* is the only path that overwrites your data,
and it asks first.

## Layout

```
src/
  main.ts      wiring, rendering, share panel
  map.ts       d3-geo SVG map: countries, regions, pins, zoom, hover button
  store.ts     own-vs-shared mode, localStorage, URL hash sync
  codec.ts     TravelData <-> deflate+base64url payload
  cities.ts    lazy-loaded city index and search
  i18n.ts      EN/DE/FR strings
scripts/
  build-data.mjs   regenerates public/data/* from Natural Earth + GeoNames
public/data/
  world.topo.json    248 countries, TopoJSON, localized names (ISO point of view)
  admin1.topo.json   303 subdivisions: US 51, DE 16, RU 83, CH 26, FR 96, CN 31
  cities.json        ~235 000 places with search aliases
```

The three data files are committed, so a normal build needs no network. They are
built without simplification — only quantization — because simplifying destroys
microstates like Monaco and San Marino.

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + bundle to dist/
npm run build:data # only when refreshing the map/city data
```

Pushing to `master` deploys to GitHub Pages via `.github/workflows/deploy.yml`.

## Data

- Country and region geometry: [Natural Earth](https://www.naturalearthdata.com/)
  (public domain), simplified and quantized.
- Cities: [GeoNames](https://www.geonames.org/) `cities15000` (CC BY 4.0).
