#!/usr/bin/env node
// Data build script for travel-map.
// Downloads Natural Earth + GeoNames sources into scripts/.cache/ (gitignored, cached),
// and writes public/data/{world.topo.json, admin1.topo.json, cities.json}.
//
// Run with: node scripts/build-data.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { topology } from "topojson-server";
import { feature as topoFeature } from "topojson-client";
import { geoContains } from "d3-geo";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(__dirname, ".cache");
const DATA_DIR = path.join(ROOT, "public", "data");

// ISO 3166 point-of-view variants (as opposed to the default de-facto/POV
// files) keep Crimea with Ukraine rather than Russia. Prefer the finest
// resolution available; fall back to coarser ISO variants, and only fall
// back to the non-ISO file as a last resort (see checkUrlExists below).
const COUNTRIES_URL_CANDIDATES = [
  {
    url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries_iso.geojson",
    cacheName: "ne_10m_admin_0_countries_iso.geojson",
  },
  {
    url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries_iso.geojson",
    cacheName: "ne_50m_admin_0_countries_iso.geojson",
  },
  {
    url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson",
    cacheName: "ne_10m_admin_0_countries.geojson",
  },
];
const ADMIN1_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson";
const CITIES_ZIP_URL = "https://download.geonames.org/export/dump/cities500.zip";

await fsp.mkdir(CACHE_DIR, { recursive: true });
await fsp.mkdir(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function downloadIfMissing(url, destPath) {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    console.log(`[cache] using cached ${path.relative(ROOT, destPath)}`);
    return;
  }
  console.log(`[download] ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buf);
  console.log(`[download] wrote ${path.relative(ROOT, destPath)} (${buf.length} bytes)`);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function urlExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (res.ok) return true;
    // Some hosts (incl. raw.githubusercontent.com in some cases) don't like
    // HEAD; fall back to a ranged GET before concluding it's missing.
    if (res.status === 404 || res.status === 405) {
      if (res.status === 404) return false;
      const res2 = await fetch(url, { headers: { Range: "bytes=0-0" } });
      return res2.ok;
    }
    return false;
  } catch {
    return false;
  }
}

// Simple planar point-in-ring test (even-odd rule). Good enough for locating
// which polygon of a MultiPolygon a probe point falls into; not used for the
// final correctness check (that's geoContains, which is spherical and RFC
// 7946-winding-aware).
function pointInRing(pt, ring) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function findPolygonContaining(multiPolygonCoords, lonLat) {
  for (let i = 0; i < multiPolygonCoords.length; i++) {
    if (pointInRing(lonLat, multiPolygonCoords[i][0])) return i;
  }
  return -1;
}

function ringBBox(ring) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// Crimea gap-fill patch.
//
// Investigated for this task: the finest-resolution ISO-POV file
// (ne_10m_admin_0_countries_iso.geojson) does NOT misattribute Crimea to
// Russia the way the plain/de-facto file does -- instead it has a literal
// coverage gap there. Neither Ukraine's nor Russia's geometry in that file
// covers the Crimea peninsula (verified by point-in-polygon probes at
// Simferopol/Kerch against both features' raw coordinates -- both come back
// false). This function handles that (and, defensively, the plain-file
// misattribution case too, in case a future run falls back to a non-ISO
// source): if Ukraine's geometry already covers Crimea, no-op; if Crimea is
// found inside Russia's geometry, move that polygon to Ukraine; if it's in
// neither (the gap case actually observed), splice in the Crimea landmass
// polygon from the plain ne_10m_admin_0_countries.geojson file (which does
// have correct high-resolution coastline data for it).
async function patchCrimeaIfNeeded(features) {
  const ua = features.find((f) => (f.properties.NAME || f.properties.NAME_EN) === "Ukraine");
  const ru = features.find((f) => (f.properties.NAME || f.properties.NAME_EN) === "Russia");
  if (!ua || !ru) {
    console.log("[crimea patch] Ukraine/Russia feature not found in source; skipping patch check");
    return;
  }

  const CRIMEA_PROBE_POINTS = [
    [34.1, 44.95], // Simferopol
    [36.47, 45.36], // Kerch
  ];

  const uaCoords = ua.geometry.type === "MultiPolygon" ? ua.geometry.coordinates : [ua.geometry.coordinates];
  const missing = CRIMEA_PROBE_POINTS.filter((pt) => findPolygonContaining(uaCoords, pt) === -1);

  if (missing.length === 0) {
    console.log("[crimea patch] Ukraine geometry already covers the Crimea probe points; no patch needed");
    return;
  }

  console.log(
    `[crimea patch] Ukraine geometry does NOT cover Crimea (${missing.length}/${CRIMEA_PROBE_POINTS.length} probe points missing) -- investigating source`
  );

  const ruCoords = ru.geometry.type === "MultiPolygon" ? ru.geometry.coordinates : [ru.geometry.coordinates];
  const ruPolyIdx = findPolygonContaining(ruCoords, CRIMEA_PROBE_POINTS[0]);

  if (ruPolyIdx !== -1) {
    console.log(
      `[crimea patch] found: Crimea is misattributed to Russia in this source (Russia.coordinates[${ruPolyIdx}]). Moving that polygon to Ukraine.`
    );
    const [crimeaPoly] = ruCoords.splice(ruPolyIdx, 1);
    uaCoords.push(crimeaPoly);
    ru.geometry.type = "MultiPolygon";
    ru.geometry.coordinates = ruCoords;
    ua.geometry.type = "MultiPolygon";
    ua.geometry.coordinates = uaCoords;
    return;
  }

  console.log(
    "[crimea patch] found: Crimea is covered by NEITHER Ukraine nor Russia in this source -- a genuine " +
      "coverage gap (confirmed: ne_10m_admin_0_countries_iso.geojson omits the Crimea peninsula from both " +
      "countries' geometry). Patching by splicing in the Crimea landmass polygon from the plain " +
      "ne_10m_admin_0_countries.geojson file."
  );

  const patchUrl =
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson";
  const patchCachePath = path.join(CACHE_DIR, "ne_10m_admin_0_countries.geojson");
  await downloadIfMissing(patchUrl, patchCachePath);
  const patchRaw = JSON.parse(await fsp.readFile(patchCachePath, "utf8"));
  const patchRu = patchRaw.features.find((f) => (f.properties.NAME || f.properties.NAME_EN) === "Russia");
  if (!patchRu) {
    throw new Error("[crimea patch] could not find a Russia feature in the patch source");
  }

  const patchRuCoords =
    patchRu.geometry.type === "MultiPolygon" ? patchRu.geometry.coordinates : [patchRu.geometry.coordinates];
  const patchIdx = findPolygonContaining(patchRuCoords, CRIMEA_PROBE_POINTS[0]);
  if (patchIdx === -1) {
    throw new Error("[crimea patch] could not locate the Crimea polygon in the patch source either");
  }

  const crimeaPoly = JSON.parse(JSON.stringify(patchRuCoords[patchIdx]));
  const bbox = ringBBox(crimeaPoly[0]);
  console.log(
    `[crimea patch] extracted Crimea polygon from patch source: ${crimeaPoly[0].length} points, bbox=${JSON.stringify(bbox)}`
  );

  uaCoords.push(crimeaPoly);
  ua.geometry.type = "MultiPolygon";
  ua.geometry.coordinates = uaCoords;

  const stillMissing = CRIMEA_PROBE_POINTS.filter((pt) => findPolygonContaining(uaCoords, pt) === -1);
  if (stillMissing.length > 0) {
    throw new Error(
      `[crimea patch] patch applied but ${stillMissing.length} probe point(s) still not covered by Ukraine`
    );
  }
  console.log("[crimea patch] patch applied successfully; Ukraine geometry now covers the Crimea probe points");
}

async function selectCountriesSource() {
  for (const candidate of COUNTRIES_URL_CANDIDATES) {
    const exists = await urlExists(candidate.url);
    console.log(`[countries source] ${exists ? "FOUND" : "missing"}: ${candidate.url}`);
    if (exists) return candidate;
  }
  throw new Error("No countries source candidate URL is reachable");
}

// ---------------------------------------------------------------------------
// OUTPUT 1: world.topo.json (Natural Earth 110m admin_0 countries)
// ---------------------------------------------------------------------------

async function buildCountries() {
  console.log("\n=== Building world.topo.json ===");
  const source = await selectCountriesSource();
  console.log(`[countries source] using ${source.url}`);
  const cachePath = path.join(CACHE_DIR, source.cacheName);
  await downloadIfMissing(source.url, cachePath);

  const raw = JSON.parse(await fsp.readFile(cachePath, "utf8"));

  // Manual fallback for the usual -99 offenders (and anything else that slips through).
  const MANUAL_ISO2 = {
    France: "FR",
    Norway: "NO",
    Kosovo: "XK",
    "N. Cyprus": "XC",
    Somaliland: "XS",
  };

  const features = raw.features.filter((f) => {
    const p = f.properties;
    const iso2eh = p.ISO_A2_EH;
    return iso2eh !== "AQ" && p.NAME !== "Antarctica";
  });

  await patchCrimeaIfNeeded(features);

  const usedIds = new Set();
  const failures = [];

  for (const f of features) {
    const p = f.properties;
    let id = p.ISO_A2_EH;
    if (!id || id === "-99") id = p.ISO_A2;
    if (!id || id === "-99") id = MANUAL_ISO2[p.NAME] ?? MANUAL_ISO2[p.NAME_EN] ?? null;
    if (id) id = String(id).toUpperCase();

    if (!id || id === "-99" || usedIds.has(id)) {
      failures.push({ name: p.NAME, ne_id: p.NE_ID, id });
    } else {
      usedIds.add(id);
    }

    const nameEn = p.NAME_EN || p.NAME;
    f.id = id;
    f.properties = {
      name: nameEn,
      name_de: p.NAME_DE || nameEn,
      name_fr: p.NAME_FR || nameEn,
    };
  }

  if (failures.length > 0) {
    console.error("FAILURES (countries missing/duplicate id):", failures);
    throw new Error(`${failures.length} country feature(s) failed id assignment`);
  }

  const fc = { type: "FeatureCollection", features };

  // Deliberately NOT using topojson-simplify's presimplify()/simplify() here.
  //
  // Visvalingam-based point simplification removes points until a ring drops
  // below a valid/recognizable shape -- fine for a huge coastline, fatal for
  // small countries: Vatican (7 pts), Monaco (12 pts), San Marino (19 pts),
  // and the like get reduced to nothing (or to a degenerate sliver that
  // reads as belonging to whichever neighbor's polygon is still valid) well
  // before any meaningfully large country loses visible detail. This was
  // verified directly: at any nontrivial simplify() weight, Vatican/San
  // Marino/Monaco/Liechtenstein/Andorra/Malta/Singapore/Maldives either lost
  // their geometry outright or collapsed into their surrounding country.
  // Per-arc "keep at least K points" workarounds were tried and rejected too
  // -- they reintroduce a *different* failure mode (see the quantization
  // note below) for near-degenerate rings.
  //
  // File size is not a constraint here (confirmed acceptable up to ~6MB), so
  // the only size lever used is topojson-server's quantization, which only
  // rounds coordinates onto a grid -- it can never delete a ring, so it
  // cannot destroy a small feature the way simplify() can.
  //
  // Quantization resolution still matters for correctness, though: at the
  // "standard" 1e5 grid, a handful of very small islands (some U.S., Bahamas
  // and Maldives islets) are smaller than a single grid cell, so several of
  // their vertices snap to the identical quantized point. The resulting
  // near-degenerate ring can come out with *inverted winding*, and because
  // d3-geo's spherical point-in-polygon sums crossings across every ring of
  // a MultiPolygon feature, one inverted islet ring corrupts containment for
  // the ENTIRE country -- verified directly: at quantization 1e5, US/BS/MV
  // each spuriously "contained" every test point on Earth, including Paris
  // and Berlin. Quantizing at 1e6 gives cells small enough that no vertex
  // pair collapses, which resolved every one of those cases in testing. We
  // still try 1e5 first (in case this particular build environment doesn't
  // reproduce the collapse) and only step up if a correctness probe fails.
  const QUANTIZE_CANDIDATES = [1e5, 1e6, 1e7];
  const SIZE_BUDGET = 6 * 1024 * 1024; // ~6MB, per relaxed budget

  // A handful of small-ring / antimeridian-adjacent probes that are cheap
  // stand-ins for the full geoContains verification run in main(): if any of
  // these come back wrong, this quantization is not usable.
  const QUICK_PROBES = [
    ["VA", [12.4534, 41.9029]], // Vatican
    ["MC", [7.42, 43.74]], // Monaco
    ["SM", [12.45, 43.94]], // San Marino
    ["MT", [14.42, 35.9]], // Malta
    ["SG", [103.82, 1.35]], // Singapore
    ["MV", [73.51, 4.18]], // Maldives
    ["US", [-157.86, 21.31]], // Honolulu
    ["US", [2.35, 48.86]], // sentinel: Paris must NOT be "in" US
  ];

  function quickProbesPass(topo) {
    const fc2 = topoFeature(topo, topo.objects.countries);
    // Paris sentinel: last probe's point must NOT be contained by the first
    // probe's id (catches the "country swallows the whole globe" failure
    // mode even when the two share an id, by construction here it's US/US
    // so instead check explicitly below).
    for (const [id, pt] of QUICK_PROBES.slice(0, -1)) {
      const f = fc2.features.find((x) => x.id === id);
      if (!f || !geoContains(f, pt)) return false;
    }
    const us = fc2.features.find((x) => x.id === "US");
    if (us && geoContains(us, [2.35, 48.86])) return false; // Paris inside "US"? corrupted.
    return true;
  }

  let finalTopo = null;
  let finalQuant = null;
  const quantReport = [];
  for (const quant of QUANTIZE_CANDIDATES) {
    const candidate = topology({ countries: fc }, quant);
    const size = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    const probesOk = quickProbesPass(candidate);
    quantReport.push({ quant, size, probesOk });
    console.log(
      `[countries quantize] quant=${quant} -> ${fmtBytes(size)}, correctness probes ${probesOk ? "PASS" : "FAIL"}`
    );
    if (probesOk && size <= SIZE_BUDGET) {
      finalTopo = candidate;
      finalQuant = quant;
      break;
    }
  }

  if (!finalTopo) {
    throw new Error(
      `No quantization candidate both passed correctness probes and fit the ${fmtBytes(SIZE_BUDGET)} budget. Tried: ${JSON.stringify(quantReport)}`
    );
  }

  const arcCount = finalTopo.arcs.length;
  const pointCount = finalTopo.arcs.reduce((n, a) => n + a.length, 0);

  // Sanity check: every feature must have real, non-empty geometry.
  const emptyGeomIds = [];
  for (const g of finalTopo.objects.countries.geometries) {
    const hasRings =
      g && g.arcs && g.arcs.length > 0 && (g.type === "Polygon" || g.type === "MultiPolygon");
    if (!hasRings) emptyGeomIds.push(g && g.id);
  }
  if (emptyGeomIds.length > 0) {
    throw new Error(`Feature(s) with empty/missing geometry: ${JSON.stringify(emptyGeomIds)}`);
  }

  const outPath = path.join(DATA_DIR, "world.topo.json");
  await fsp.writeFile(outPath, JSON.stringify(finalTopo));
  const size = (await fsp.stat(outPath)).size;
  console.log(
    `[world.topo.json] quant=${finalQuant} (no simplification), ${features.length} countries, ${fmtBytes(size)}, arcs=${arcCount}, points=${pointCount}`
  );

  return {
    path: outPath,
    size,
    count: features.length,
    topo: finalTopo,
    arcsBefore: arcCount,
    arcsAfter: arcCount,
    quant: finalQuant,
    sourceUrl: source.url,
  };
}

// ---------------------------------------------------------------------------
// OUTPUT 2: admin1.topo.json (Natural Earth 10m admin_1 states/provinces:
// US, DE, RU, CH, FR, CN)
// ---------------------------------------------------------------------------

async function buildAdmin1() {
  console.log("\n=== Building admin1.topo.json ===");
  const cachePath = path.join(CACHE_DIR, "ne_10m_admin_1_states_provinces.geojson");
  await downloadIfMissing(ADMIN1_URL, cachePath);

  const raw = JSON.parse(await fsp.readFile(cachePath, "utf8"));

  const TARGET_COUNTRIES = ["US", "DE", "RU", "CH", "FR", "CN"];
  const idPattern = /^(US|DE|RU|CH|FR|CN)-[A-Z0-9]+$/;

  // Rows we deliberately drop, with why -- reported at the end rather than
  // silently discarded, per the France/China territorial-scope requirements.
  const excluded = [];

  const candidates = raw.features.filter((f) => {
    const p = f.properties;
    if (!TARGET_COUNTRIES.includes(p.iso_a2)) return false;

    // France: NE's admin_1 for FR is départements (no région-level polygons
    // in this file at all -- confirmed by inspecting every FR row's `type`/
    // `type_en`, all either "Metropolitan département" or "Overseas
    // département"). Keep départements, but drop the 5 overseas ones
    // (Guyane française, Martinique, Guadeloupe, La Réunion, Mayotte) since
    // they aren't part of any metropolitan région.
    if (p.iso_a2 === "FR" && p.type && /overseas/i.test(p.type)) {
      excluded.push({
        reason: "FR overseas département (not part of a metropolitan région)",
        name: p.name,
        iso_3166_2: p.iso_3166_2,
      });
      return false;
    }

    return true;
  });

  // Taiwan, Hong Kong, and Macau are NOT mixed into "CN" in this dataset --
  // Natural Earth gives them their own iso_a2 codes (TW, HK, MO
  // respectively; Taiwan has 21 counties/cities, Hong Kong 18 districts,
  // Macau 1), entirely separate from CN's 32 iso_a2=="CN" rows. Filtering by
  // iso_a2 === "CN" above already excludes all of them without any extra
  // logic; nothing to silently include or drop. Verified directly against
  // the raw source.

  const usedIds = new Set();
  const failures = [];
  const features = [];

  // NE's iso_3166_2 for Moscow city vs. Moscow oblast is swapped relative to
  // the real ISO 3166-2:RU standard (RU-MOW is the federal city of Moscow;
  // RU-MOS is Moskovskaya oblast, the surrounding region -- cross-checked
  // against ISO 3166-2:RU, and consistent with the file's own St. Petersburg
  // pair, which is correct: city=RU-SPE, oblast=RU-LEN). NE's row named
  // "Moskva" (the city, type "Federal City") carries iso_3166_2="RU-MOS",
  // and the row named "Moskovskaya" (the oblast, type "Region") carries
  // "RU-MOW" -- exactly backwards. Verified directly: swapping these two is
  // the only way Moscow-the-city resolves to RU-MOW as ISO 3166-2 requires.
  const ISO_3166_2_OVERRIDES = {
    Moskva: "RU-MOW",
    Moskovskaya: "RU-MOS",
  };

  for (const f of candidates) {
    const p = f.properties;
    const country = p.iso_a2;
    let id = ISO_3166_2_OVERRIDES[p.name] ?? (p.iso_3166_2 ? String(p.iso_3166_2).toUpperCase() : null);

    // Two known cases of iso_3166_2 not agreeing with iso_a2's grouping,
    // both excluded here (not hard failures):
    //  - RU has two rows for Crimea/Sevastopol grouped under iso_a2=="RU"
    //    (the de-facto Russian claim), but their own iso_3166_2 codes are
    //    "UA-43"/"UA-40" (Ukraine's ISO codes) -- consistent with the same
    //    ISO-POV fix applied to world.topo.json, these are excluded from
    //    the RU set rather than drawn as Russian subdivisions.
    //  - RU and CN each have one placeholder row for disputed/unofficial
    //    territory (Russia: an unnamed row; China: "Paracel Islands") whose
    //    iso_3166_2 is a non-ISO placeholder like "RU-X01~"/"CN-X01~" (NE's
    //    convention for "no real code", note the trailing "~"). These fail
    //    idPattern (the "~" isn't in [A-Z0-9]) and are excluded.
    if (!id || !idPattern.test(id) || !id.startsWith(`${country}-`)) {
      excluded.push({
        reason: "invalid/non-ISO iso_3166_2, or country-code mismatch (e.g. Crimea/Sevastopol carrying UA-* codes)",
        name: p.name,
        iso_a2: p.iso_a2,
        iso_3166_2: p.iso_3166_2,
      });
      continue;
    }

    if (usedIds.has(id)) {
      failures.push({ name: p.name, iso_3166_2: p.iso_3166_2, id, reason: "duplicate id" });
      continue;
    }
    usedIds.add(id);

    const nameEn = p.name_en || p.name;
    f.id = id;
    f.properties = {
      name: nameEn,
      name_de: p.name_de || nameEn,
      name_fr: p.name_fr || nameEn,
      country,
    };
    features.push(f);
  }

  if (failures.length > 0) {
    console.error("FAILURES (admin1 missing/duplicate/invalid id):", failures);
    throw new Error(`${failures.length} admin1 feature(s) failed id assignment`);
  }

  console.log(`[admin1] excluded ${excluded.length} row(s):`);
  for (const e of excluded) console.log("  ", JSON.stringify(e));

  const countsByCountry = {};
  for (const f of features) {
    countsByCountry[f.properties.country] = (countsByCountry[f.properties.country] || 0) + 1;
  }
  console.log("[admin1] per-country feature counts:", JSON.stringify(countsByCountry));

  const usFeatures = features.filter((f) => f.properties.country === "US");
  const deFeatures = features.filter((f) => f.properties.country === "DE");

  // US and DE are unchanged from before -- keep the exact hard assertions.
  if (usFeatures.length !== 51) {
    throw new Error(`Expected exactly 51 US features, got ${usFeatures.length}`);
  }
  if (deFeatures.length !== 16) {
    throw new Error(`Expected exactly 16 DE features, got ${deFeatures.length}`);
  }
  // CH (26 cantons) is also a stable, well-known count -- hard assert it too.
  if (countsByCountry.CH !== 26) {
    throw new Error(`Expected exactly 26 CH features, got ${countsByCountry.CH}`);
  }
  // RU, FR, CN counts vary with the NE vintage -- reported above, not asserted.

  const fc = { type: "FeatureCollection", features };

  // Same trap as world.topo.json: presimplify()/simplify() destroy small
  // geometry (see the extensive notes in buildCountries above) and file
  // size is not a constraint here either (up to ~15MB is fine). So: no
  // simplification, quantization only, at 1e6 (already proven safe against
  // the winding-inversion failure mode for world.topo.json's small islands).
  const QUANT = 1e6;
  const topo = topology({ states: fc }, QUANT);

  const outPath = path.join(DATA_DIR, "admin1.topo.json");
  await fsp.writeFile(outPath, JSON.stringify(topo));
  const size = (await fsp.stat(outPath)).size;
  console.log(
    `[admin1.topo.json] quant=${QUANT} (no simplification), ${features.length} features, ${fmtBytes(size)}`
  );

  return {
    path: outPath,
    size,
    usCount: usFeatures.length,
    deCount: deFeatures.length,
    countsByCountry,
    excluded,
    topo,
  };
}

// ---------------------------------------------------------------------------
// OUTPUT 3: cities.json (GeoNames cities500 -- population >= 500, plus all
// administrative seats/capitals regardless of population, ~200k rows)
// ---------------------------------------------------------------------------

async function buildCities() {
  console.log("\n=== Building cities.json ===");
  const zipPath = path.join(CACHE_DIR, "cities500.zip");
  await downloadIfMissing(CITIES_ZIP_URL, zipPath);

  const extractDir = path.join(CACHE_DIR, "cities500_extracted");
  const txtPath = path.join(extractDir, "cities500.txt");

  if (!fs.existsSync(txtPath)) {
    await fsp.mkdir(extractDir, { recursive: true });
    console.log("[unzip] extracting cities500.zip");
    execFileSync("unzip", ["-o", zipPath, "-d", extractDir], { stdio: "inherit" });
  } else {
    console.log("[cache] using cached extracted cities500.txt");
  }

  const raw = await fsp.readFile(txtPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const round4 = (n) => Math.round(n * 10000) / 10000;

  const ALT_ALLOWED = /^[a-z0-9 '-]+$/;
  const fold = (s) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();

  function buildAlt(alternatenamesRaw, name, asciiname) {
    if (!alternatenamesRaw) return "";
    const foldedName = fold(name);
    const foldedAscii = fold(asciiname);

    const candidates = alternatenamesRaw
      .split(",")
      .map(fold)
      .filter((s) => ALT_ALLOWED.test(s))
      .filter((s) => s !== foldedName && s !== foldedAscii)
      .filter((s) => s.length >= 2 && s.length <= 40);

    // dedupe (exact folded duplicates only)
    //
    // NOTE on the "drop substrings" step from the original spec: dropping an
    // entry whenever it's a substring of another kept entry was tried in
    // both directions and both broke real cities:
    //   - drop-the-shorter-one: for Munich, GeoNames' alternatenames list
    //     happens to include "Lungsod ng Muenchen" (Tagalog for "City of
    //     Munich"). That swallowed the short, essential "muenchen"/"munchen"
    //     entries, and the long Tagalog phrase itself then got sorted near
    //     the end (by length) and cut off by the char cap -- so the actually
    //     useful spelling vanished entirely.
    //   - drop-the-longer-one: for Florence, GeoNames lists both "Firenz"
    //     and "Firenze"; the correct/standard "firenze" got dropped because
    //     it contains the shorter, less-common "firenz".
    // Since neither direction is safe in general, this step is skipped.
    // Tightness is instead achieved purely by the length-ascending sort +
    // char cap below (which still discards the long, low-value multi-word
    // phrases first).
    const kept = [...new Set(candidates)];

    // sort by length ascending, join capped at CAP chars, cut at space boundary
    kept.sort((a, b) => a.length - b.length);

    // 150 chars (the original spec value) was too tight: for cities with a
    // large number of GeoNames alternate spellings (Munich, Florence, ...)
    // it got exhausted by short low-value transliterations before reaching
    // the mid-length spellings that actually matter for search (e.g.
    // "muenchen"). 300 was the smallest cap under which all of the
    // required-searchable spellings below survive, and it keeps the whole
    // file comfortably under the ~4.5MB budget (see report).
    const CAP = 300;
    let out = "";
    for (const entry of kept) {
      const candidate = out.length === 0 ? entry : `${out} ${entry}`;
      if (candidate.length > CAP) break;
      out = candidate;
    }

    return out;
  }

  // cities500.zip already applies the population/seat filtering at the
  // source (GeoNames: population >= 500, OR any administrative seat/capital
  // regardless of population) -- so unlike the old cities15000 build, there
  // is no additional population threshold here. Rows with unknown/zero
  // population are kept (many small villages have no recorded population
  // but must still be searchable) and just sort to the back.
  //
  // Building the `alt` alias string is somewhat expensive and only matters
  // for well-known places that get referred to by exonyms (Munich/München,
  // etc.) -- restrict it to bigger cities to keep the ~200k-row file sane.
  const ALT_MIN_POP = 20000;

  const rows = [];
  for (const line of lines) {
    const cols = line.split("\t");
    const name = cols[1];
    const asciiname = cols[2];
    const alternatenamesRaw = cols[3];
    const lat = parseFloat(cols[4]);
    const lon = parseFloat(cols[5]);
    const cc = cols[8];
    const popRaw = parseInt(cols[14], 10);
    const pop = Number.isFinite(popRaw) ? popRaw : 0;

    if (!name || !cc) continue;

    const alt = pop >= ALT_MIN_POP ? buildAlt(alternatenamesRaw, name, asciiname) : "";

    rows.push([
      name,
      asciiname === name ? "" : asciiname,
      cc,
      round4(lat),
      round4(lon),
      pop,
      alt,
    ]);
  }

  // Descending by population; rows with population 0 naturally sort last.
  rows.sort((a, b) => b[5] - a[5]);

  const outPath = path.join(DATA_DIR, "cities.json");
  const json = JSON.stringify({ cities: rows });
  await fsp.writeFile(outPath, json);
  const size = (await fsp.stat(outPath)).size;
  console.log(`[cities.json] ${rows.length} rows, ${fmtBytes(size)}`);

  return { path: outPath, size, count: rows.length, rows };
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

function verifyTopo(topo, objectName, label) {
  const fc = topoFeature(topo, topo.objects[objectName]);
  if (fc.type !== "FeatureCollection") {
    throw new Error(`${label}: topojson-client feature() did not return a FeatureCollection`);
  }
  console.log(`[verify] ${label}: parsed ${fc.features.length} features via topojson-client`);
  return fc;
}

function assertNonEmptyGeometries(fc, label) {
  const bad = [];
  for (const f of fc.features) {
    const g = f.geometry;
    const coords =
      g && (g.type === "Polygon" || g.type === "MultiPolygon") ? g.coordinates : null;
    const nonEmpty = Array.isArray(coords) && coords.length > 0 && coords[0]?.length > 0 && coords[0][0]?.length > 0;
    if (!nonEmpty) bad.push(f.id);
  }
  if (bad.length > 0) {
    console.error(`[verify] ${label}: feature(s) with empty/missing geometry:`, bad);
    throw new Error(`${label}: ${bad.length} feature(s) have empty/missing geometry: ${JSON.stringify(bad)}`);
  }
  console.log(`[verify] ${label}: all ${fc.features.length} features have non-empty geometry`);
}

// All country features (by id) that contain a given [lon, lat] point, using
// d3-geo's geoContains against the decoded FeatureCollection. "Correct" for
// a strict check is exactly one match, equal to the wanted id -- this also
// catches a point falling in an unwanted neighbor (e.g. a badly-wound hole
// letting Monaco's point register as also inside France).
function countriesContaining(countriesFc, lonLat) {
  return countriesFc.features.filter((f) => geoContains(f, lonLat)).map((f) => f.id);
}

// Points that are known, at full 10m-resolution precision with zero
// simplification, to legitimately fall just offshore (harbor/bay water) of
// their "obvious" country -- this is real coastline detail, not a
// processing bug. Verified for Sevastopol: even the fully unsimplified,
// untouched source geometry for Ukraine's Crimea polygon does not cover the
// exact point (33.53, 44.62), because it sits in Sevastopol Bay. Listed
// explicitly (never silently) per the requirement to call this out rather
// than hide it.
const KNOWN_COASTAL_EDGE_CASES = new Set(["Sevastopol"]);

function runGeoContainsChecks(countriesFc) {
  const POINTS = [
    { name: "Vatican", lonLat: [12.4534, 41.9029], want: "VA" },
    { name: "San Marino", lonLat: [12.45, 43.94], want: "SM" },
    { name: "Monaco", lonLat: [7.42, 43.74], want: "MC" },
    { name: "Liechtenstein", lonLat: [9.55, 47.15], want: "LI" },
    { name: "Andorra", lonLat: [1.52, 42.51], want: "AD" },
    { name: "Malta", lonLat: [14.42, 35.9], want: "MT" },
    { name: "Singapore", lonLat: [103.82, 1.35], want: "SG" },
    { name: "Maldives", lonLat: [73.51, 4.18], want: "MV" },
    { name: "Luxembourg", lonLat: [6.13, 49.61], want: "LU" },
    { name: "Rhodes", lonLat: [28.05, 36.35], want: "GR" },
    { name: "Crete", lonLat: [24.81, 35.24], want: "GR" },
    { name: "Sicily", lonLat: [14.02, 37.6], want: "IT" },
    { name: "Simferopol", lonLat: [34.1, 44.95], want: "UA" },
    { name: "Sevastopol", lonLat: [33.53, 44.62], want: "UA" },
    { name: "Kerch", lonLat: [36.47, 45.36], want: "UA" },
    { name: "Yalta", lonLat: [34.17, 44.5], want: "UA" },
    { name: "Moscow", lonLat: [37.62, 55.75], want: "RU" },
    { name: "Rostov-on-Don", lonLat: [39.72, 47.24], want: "RU" },
    { name: "Kyiv", lonLat: [30.52, 50.45], want: "UA" },
    { name: "Donetsk", lonLat: [37.8, 48.0], informational: true },
    { name: "Honolulu", lonLat: [-157.86, 21.31], want: "US" },
    { name: "Oahu", lonLat: [-157.98, 21.47], want: "US" },
    { name: "Anchorage", lonLat: [-149.9, 61.22], want: "US" },
    { name: "Berlin", lonLat: [13.4, 52.52], want: "DE" },
    { name: "Paris", lonLat: [2.35, 48.86], want: "FR" },
  ];

  const rows = [];
  let hardFail = false;

  for (const pt of POINTS) {
    const containedBy = countriesContaining(countriesFc, pt.lonLat);

    if (pt.informational) {
      rows.push({
        name: pt.name,
        lonLat: pt.lonLat,
        status: "INFO",
        detail: `contained by: ${JSON.stringify(containedBy)}`,
      });
      continue;
    }

    const pass = containedBy.length === 1 && containedBy[0] === pt.want;

    if (pass) {
      rows.push({ name: pt.name, lonLat: pt.lonLat, status: "PASS", detail: `got=${JSON.stringify(containedBy)}` });
      continue;
    }

    if (containedBy.length === 0 && KNOWN_COASTAL_EDGE_CASES.has(pt.name)) {
      const wantFeature = countriesFc.features.find((f) => f.id === pt.want);
      const healthy = !!wantFeature && wantFeature.geometry && wantFeature.geometry.coordinates?.length > 0;
      rows.push({
        name: pt.name,
        lonLat: pt.lonLat,
        status: "OFFSHORE",
        detail: `got=[] (no country covers this exact point at full 10m resolution -- real coastline/harbor detail, not a bug); ${pt.want} geometry is otherwise ${healthy ? "healthy" : "MISSING/BROKEN"}`,
      });
      if (!healthy) hardFail = true;
      continue;
    }

    hardFail = true;
    rows.push({
      name: pt.name,
      lonLat: pt.lonLat,
      status: "FAIL",
      detail: `want=${pt.want} got=${JSON.stringify(containedBy)}`,
    });
  }

  console.log("\n=== geoContains verification ===");
  for (const r of rows) {
    console.log(`${r.status.padEnd(9)} ${r.name.padEnd(16)} [${r.lonLat.join(", ")}]  ${r.detail}`);
  }

  if (hardFail) {
    throw new Error("One or more geoContains check(s) FAILED (see table above)");
  }

  return rows;
}

function assertAdmin1Integrity(admin1Fc) {
  const idPattern = /^(US|DE|RU|CH|FR|CN)-/;
  const seen = new Set();
  const problems = [];

  for (const f of admin1Fc.features) {
    if (!f.id) problems.push(`empty id (name=${f.properties?.name})`);
    else if (seen.has(f.id)) problems.push(`duplicate id ${f.id}`);
    else seen.add(f.id);

    if (f.id && !idPattern.test(f.id)) problems.push(`id ${f.id} doesn't match /^(US|DE|RU|CH|FR|CN)-/`);

    const g = f.geometry;
    const coords = g && (g.type === "Polygon" || g.type === "MultiPolygon") ? g.coordinates : null;
    const nonEmpty = Array.isArray(coords) && coords.length > 0 && coords[0]?.length > 0 && coords[0][0]?.length > 0;
    if (!nonEmpty) problems.push(`empty/missing geometry for id ${f.id}`);
  }

  // Winding-inversion check: three points far from all six admin1 target
  // countries (mid South Atlantic, southern Indian Ocean, mid South
  // Pacific). No real US/DE/RU/CH/FR/CN subdivision should ever contain any
  // of these -- if one does, a ring's winding got flipped (the same failure
  // mode found and fixed in world.topo.json at low quantization).
  const FAR_SENTINELS = [
    [-15, -30], // mid South Atlantic
    [75, -40], // southern Indian Ocean
    [-140, -20], // mid South Pacific
  ];
  const spurious = [];
  for (const f of admin1Fc.features) {
    for (const pt of FAR_SENTINELS) {
      if (geoContains(f, pt)) spurious.push(`${f.id} spuriously contains ${JSON.stringify(pt)}`);
    }
  }

  console.log(`\n[verify] admin1.topo.json: checked ${admin1Fc.features.length} features`);
  if (problems.length > 0) {
    console.error("[verify] admin1.topo.json PROBLEMS:", problems);
  } else {
    console.log("[verify] admin1.topo.json: all ids unique, non-empty, correctly prefixed; all geometry non-empty");
  }
  if (spurious.length > 0) {
    console.error("[verify] admin1.topo.json WINDING FAILURES:", spurious);
  } else {
    console.log("[verify] admin1.topo.json: no feature spuriously contains a far-away sentinel point (winding OK)");
  }

  if (problems.length > 0 || spurious.length > 0) {
    throw new Error(
      `admin1.topo.json integrity check failed: ${problems.length} id/geometry problem(s), ${spurious.length} winding failure(s)`
    );
  }
}

function runAdmin1GeoContainsChecks(admin1Fc) {
  const POINTS = [
    { name: "Moscow", lonLat: [37.62, 55.75], want: "RU-MOW" },
    { name: "Saint Petersburg", lonLat: [30.31, 59.94], want: "RU-SPE" },
    { name: "Kazan", lonLat: [49.11, 55.79], want: "RU-TA" },
    { name: "Sochi", lonLat: [39.73, 43.6], want: "RU-KDA" },
    { name: "Kaliningrad", lonLat: [20.51, 54.71], want: "RU-KGD" },
    { name: "Vladivostok", lonLat: [131.89, 43.12], want: "RU-PRI" },
    { name: "Zurich", lonLat: [8.54, 47.37], want: "CH-ZH" },
    { name: "Geneva", lonLat: [6.14, 46.2], want: "CH-GE" },
    { name: "Lausanne", lonLat: [6.63, 46.52], want: "CH-VD" },
    { name: "Paris", lonLat: [2.35, 48.86], want: null },
    { name: "Strasbourg", lonLat: [7.75, 48.57], want: null },
    { name: "Chamonix", lonLat: [6.87, 45.92], want: null },
    { name: "Beijing", lonLat: [116.4, 39.9], want: "CN-BJ" },
    { name: "Shanghai", lonLat: [121.47, 31.23], want: "CN-SH" },
    { name: "Lhasa", lonLat: [91.14, 29.65], want: "CN-XZ" },
    { name: "Los Angeles", lonLat: [-118.24, 34.05], want: "US-CA" },
    { name: "Munich", lonLat: [11.58, 48.14], want: "DE-BY" },
    { name: "Berlin", lonLat: [13.4, 52.52], want: "DE-BE" },
  ];

  const rows = [];
  let hardFail = false;

  for (const pt of POINTS) {
    const containedBy = admin1Fc.features.filter((f) => geoContains(f, pt.lonLat)).map((f) => f.id);

    if (pt.want === null) {
      // French département ids depend on what NE ships -- just report which
      // feature(s) contain the point rather than asserting an exact id.
      const names = admin1Fc.features
        .filter((f) => containedBy.includes(f.id))
        .map((f) => `${f.id} (${f.properties.name})`);
      const pass = names.length === 1;
      if (!pass) hardFail = true;
      rows.push({
        name: pt.name,
        lonLat: pt.lonLat,
        status: pass ? "PASS" : "FAIL",
        detail: `contained by: ${JSON.stringify(names)}`,
      });
      continue;
    }

    const pass = containedBy.length === 1 && containedBy[0] === pt.want;
    if (!pass) hardFail = true;
    rows.push({
      name: pt.name,
      lonLat: pt.lonLat,
      status: pass ? "PASS" : "FAIL",
      detail: `want=${pt.want} got=${JSON.stringify(containedBy)}`,
    });
  }

  console.log("\n=== admin1 geoContains verification ===");
  for (const r of rows) {
    console.log(`${r.status.padEnd(6)} ${r.name.padEnd(18)} [${r.lonLat.join(", ")}]  ${r.detail}`);
  }

  if (hardFail) {
    throw new Error("One or more admin1 geoContains check(s) FAILED (see table above)");
  }

  return rows;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const COUNTRIES_ONLY = process.env.BUILD_DATA_COUNTRIES_ONLY === "1";
const SKIP_ADMIN1 = COUNTRIES_ONLY || process.env.BUILD_DATA_SKIP_ADMIN1 === "1";
const SKIP_CITIES = COUNTRIES_ONLY || process.env.BUILD_DATA_SKIP_CITIES === "1";

async function main() {
  const countries = await buildCountries();
  const admin1 = SKIP_ADMIN1 ? null : await buildAdmin1();
  const cities = SKIP_CITIES ? null : await buildCities();

  console.log("\n=== Verification ===");
  const countriesFc = verifyTopo(countries.topo, "countries", "world.topo.json");
  const admin1Fc = admin1 ? verifyTopo(admin1.topo, "states", "admin1.topo.json") : null;

  assertNonEmptyGeometries(countriesFc, "world.topo.json");

  const geoContainsRows = runGeoContainsChecks(countriesFc);

  let admin1GeoContainsRows = null;
  if (admin1Fc) {
    assertAdmin1Integrity(admin1Fc);
    admin1GeoContainsRows = runAdmin1GeoContainsChecks(admin1Fc);
  }

  console.log("\n=== Report ===");
  console.log(`countries source: ${countries.sourceUrl}`);
  console.log(`world.topo.json: ${fmtBytes(countries.size)} (${countries.size} bytes), ${countries.count} countries`);
  console.log(
    `world.topo.json: quantization=${countries.quant} (no simplification applied), arcs=${countries.arcsAfter}`
  );
  if (admin1) {
    console.log(
      `admin1.topo.json: ${fmtBytes(admin1.size)} (${admin1.size} bytes), ${admin1.usCount} US states, ${admin1.deCount} DE states`
    );
    console.log(`admin1.topo.json: per-country feature counts: ${JSON.stringify(admin1.countsByCountry)}`);
    console.log(`admin1.topo.json: excluded rows: ${JSON.stringify(admin1.excluded)}`);
  }
  if (cities) {
    console.log(`cities.json: ${fmtBytes(cities.size)} (${cities.size} bytes), ${cities.count} cities`);
  }

  console.log("\ngeoContains PASS/FAIL table:");
  for (const r of geoContainsRows) {
    console.log(`  ${r.status.padEnd(9)} ${r.name.padEnd(16)} [${r.lonLat.join(", ")}]  ${r.detail}`);
  }
  if (admin1GeoContainsRows) {
    console.log("\nadmin1 geoContains PASS/FAIL table:");
    for (const r of admin1GeoContainsRows) {
      console.log(`  ${r.status.padEnd(6)} ${r.name.padEnd(18)} [${r.lonLat.join(", ")}]  ${r.detail}`);
    }
  }

  const sampleCountry = countriesFc.features[0];
  console.log(
    `\nSample country: id=${sampleCountry.id} properties=${JSON.stringify(sampleCountry.properties)}`
  );
  if (admin1Fc) {
    const sampleAdmin1 = admin1Fc.features[0];
    console.log(
      `Sample admin1: id=${sampleAdmin1.id} properties=${JSON.stringify(sampleAdmin1.properties)}`
    );
  }
  if (cities) {
    console.log(`First 2 cities: ${JSON.stringify(cities.rows.slice(0, 2))}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
