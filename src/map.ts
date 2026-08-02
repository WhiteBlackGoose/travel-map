import { geoNaturalEarth1, geoPath, type GeoProjection, type GeoPath } from "d3-geo";
import { select, type Selection } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { feature } from "topojson-client";
import "d3-transition"; // augments Selection with .transition()
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, Geometry } from "geojson";

import { localName, t } from "./i18n";
import { cityKey, type PinnedCity, type TravelData } from "./model";

export type NameProps = { name: string; name_de?: string; name_fr?: string; country?: string };
export type Feat = Feature<Geometry, NameProps> & { id: string };

export type MapCallbacks = {
  onToggleCountry(cc: string): void;
  onToggleState(code: string): void;
  onToggleExpand(cc: string): void;
  onRemoveCity(key: string): void;
};

const WIDTH = 960;
const HEIGHT = 500;

const svgIcon = (body: string) =>
  `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" ` +
  `stroke-width="1.8" stroke-linecap="round" aria-hidden="true">${body}</svg>`;

/** A square cut into quarters: break the country apart. */
const ICON_SPLIT = svgIcon('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M8 2.5v11M2.5 8h11"/>');
/** The same square, whole again: put it back together. */
const ICON_MERGE = svgIcon('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/>');

export class MapView {
  private svg!: Selection<SVGSVGElement, unknown, null, undefined>;
  private layer!: Selection<SVGGElement, unknown, null, undefined>;
  private gCountries!: Selection<SVGGElement, unknown, null, undefined>;
  private gStates!: Selection<SVGGElement, unknown, null, undefined>;
  private gPins!: Selection<SVGGElement, unknown, null, undefined>;
  private projection!: GeoProjection;
  private path!: GeoPath;
  private zoomBehavior!: ZoomBehavior<SVGSVGElement, unknown>;
  private transform: ZoomTransform = zoomIdentity;

  /** Current viewBox size, kept equal to the host's CSS pixel size. */
  private w = WIDTH;
  private h = HEIGHT;

  private countries: Feat[] = [];
  private states: Feat[] = [];
  private byCC = new Map<string, Feat>();
  /** Countries the region file actually covers — never hardcoded, so the
   *  split affordance can never promise regions that do not exist. */
  private splittable = new Set<string>();
  private anchors = new Map<string, [number, number]>();
  /** Largest landmass per country, cached — see largestPart(). */
  private parts = new Map<string, unknown>();

  private splitBtn!: HTMLButtonElement;
  private tooltip!: HTMLDivElement;
  private cityPopup!: HTMLDivElement;
  private popupKey: string | null = null;
  private hoverCC: string | null = null;
  private hideTimer: number | undefined;

  private data: TravelData | null = null;

  constructor(
    private root: HTMLElement,
    private cb: MapCallbacks,
  ) {}

  /** Number of countries in the dataset — the denominator for "% of the world". */
  get countryCount() {
    return this.countries.length;
  }

  countryName(cc: string): string {
    const f = this.byCC.get(cc);
    return f ? localName(f.properties) : cc;
  }

  stateName(code: string): string {
    const f = this.states.find((s) => s.id === code);
    return f ? localName(f.properties) : code;
  }

  canSplit(cc: string): boolean {
    return this.splittable.has(cc);
  }

  regionsOf(cc: string): Feat[] {
    return this.states.filter((s) => s.properties.country === cc);
  }

  async load() {
    const [worldRes, adminRes] = await Promise.all([
      fetch("data/world.topo.json"),
      fetch("data/admin1.topo.json"),
    ]);
    if (!worldRes.ok || !adminRes.ok) throw new Error("map data unavailable");
    const world = (await worldRes.json()) as Topology;
    const admin = (await adminRes.json()) as Topology;

    this.countries = (
      feature(world, world.objects.countries as GeometryCollection<NameProps>) as unknown as {
        features: Feat[];
      }
    ).features;
    this.states = (
      feature(admin, admin.objects.states as GeometryCollection<NameProps>) as unknown as {
        features: Feat[];
      }
    ).features;

    for (const c of this.countries) this.byCC.set(c.id, c);
    for (const s of this.states) {
      if (s.properties.country) this.splittable.add(s.properties.country);
    }
    this.build();
  }

  private build() {
    this.root.innerHTML = "";
    this.projection = geoNaturalEarth1().fitSize([WIDTH, HEIGHT], {
      type: "FeatureCollection",
      features: this.countries,
    } as never);
    this.path = geoPath(this.projection);

    this.svg = select(this.root)
      .append("svg")
      .attr("class", "map")
      .attr("viewBox", `0 0 ${WIDTH} ${HEIGHT}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    this.svg.append("rect").attr("class", "ocean").attr("width", WIDTH).attr("height", HEIGHT);

    this.layer = this.svg.append("g");
    this.gCountries = this.layer.append("g").attr("class", "countries");
    this.gStates = this.layer.append("g").attr("class", "states");
    this.gPins = this.layer.append("g").attr("class", "pins");

    this.zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 60])
      .translateExtent([
        [0, 0],
        [WIDTH, HEIGHT],
      ])
      .on("zoom", (e) => {
        this.transform = e.transform;
        this.layer.attr("transform", e.transform.toString());
        this.rescalePins();
        this.positionSplitButton();
        this.positionCityPopup();
      });
    this.svg.call(this.zoomBehavior);

    // Clicking empty ocean dismisses the hover affordances.
    this.svg.on("click", (e: MouseEvent) => {
      if (e.target === this.svg.node() || (e.target as Element).classList.contains("ocean")) {
        this.hideSplitButton(true);
      }
      this.closeCityPopup();
    });
    this.svg.on("mouseleave", () => this.scheduleHide());

    this.splitBtn = document.createElement("button");
    this.splitBtn.className = "split-btn";
    this.splitBtn.hidden = true;
    this.splitBtn.addEventListener("click", () => {
      if (this.hoverCC) this.cb.onToggleExpand(this.hoverCC);
    });
    this.splitBtn.addEventListener("mouseenter", () => clearTimeout(this.hideTimer));
    this.splitBtn.addEventListener("mouseleave", () => this.scheduleHide());
    this.root.appendChild(this.splitBtn);

    this.tooltip = document.createElement("div");
    this.tooltip.className = "map-tooltip";
    this.tooltip.hidden = true;
    this.root.appendChild(this.tooltip);

    this.cityPopup = document.createElement("div");
    this.cityPopup.className = "city-popup";
    this.cityPopup.hidden = true;
    this.cityPopup.addEventListener("click", (e) => e.stopPropagation());
    this.root.appendChild(this.cityPopup);

    // Anywhere outside the popover dismisses it, including outside the map.
    // pointerdown runs before the pin's click, so clicking a different pin
    // still closes this one and opens that one.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.popupKey) return;
        const target = e.target as Element | null;
        // The zoom controls are exempt: zooming in for a closer look at the
        // pin you just opened should not throw the popover away.
        if (this.cityPopup.contains(target) || target?.closest?.(".map-controls")) return;
        this.closeCityPopup();
      },
      true,
    );

    this.drawCountries();
    this.fit();

    // Re-fit on resize so the map always fills its panel instead of
    // letterboxing inside a fixed 960x500 box.
    let pending = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => this.fit());
    }).observe(this.root);
  }

  /** Matches the projection to the host's real size, preserving the zoom. */
  private fit() {
    const r = this.root.getBoundingClientRect();
    const w = Math.max(240, Math.round(r.width));
    const h = Math.max(200, Math.round(r.height));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;

    this.svg.attr("viewBox", `0 0 ${w} ${h}`);
    this.svg.select("rect.ocean").attr("width", w).attr("height", h);
    this.projection.fitSize([w, h], {
      type: "FeatureCollection",
      features: this.countries,
    } as never);
    this.zoomBehavior.translateExtent([
      [0, 0],
      [w, h],
    ]);

    this.gCountries.selectAll<SVGPathElement, Feat>("path").attr("d", (d) => this.path(d) ?? "");
    this.gStates.selectAll<SVGPathElement, Feat>("path").attr("d", (d) => this.path(d) ?? "");
    this.anchors.clear();
    this.parts.clear();
    this.placePins();
    this.positionSplitButton();
    this.positionCityPopup();
  }

  private openCityPopup(c: PinnedCity) {
    this.popupKey = cityKey(c);
    this.cityPopup.innerHTML = "";

    const name = document.createElement("span");
    name.className = "city-popup-name";
    name.textContent = c.name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "city-popup-remove";
    remove.textContent = t("removeCity");
    remove.addEventListener("click", () => {
      const key = this.popupKey;
      this.closeCityPopup();
      if (key) this.cb.onRemoveCity(key);
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "city-popup-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", () => this.closeCityPopup());

    this.cityPopup.append(name, remove, close);
    this.cityPopup.hidden = false;
    this.positionCityPopup();
  }

  closeCityPopup() {
    this.popupKey = null;
    this.cityPopup.hidden = true;
  }

  private positionCityPopup() {
    if (!this.popupKey || this.cityPopup.hidden || !this.data) return;
    const c = this.data.cities.find((x) => cityKey(x) === this.popupKey);
    if (!c) return this.closeCityPopup();
    const p = this.projection([c.lon, c.lat]);
    if (!p) return;
    const [x, y] = this.toScreen(p as [number, number]);
    this.cityPopup.style.left = `${x}px`;
    this.cityPopup.style.top = `${y}px`;
  }

  /** Map view units -> CSS pixels, honouring the zoom and the SVG's fit. */
  private toScreen([x, y]: [number, number]): [number, number] {
    return this.transform.apply([x, y]) as [number, number];
  }

  private drawCountries() {
    this.gCountries
      .selectAll<SVGPathElement, Feat>("path")
      .data(this.countries, (d) => d.id)
      .join("path")
      .attr("d", (d) => this.path(d) ?? "")
      .on("click", (e: MouseEvent, d) => {
        e.stopPropagation();
        this.closeCityPopup();
        if (this.data?.expanded.has(d.id)) return;
        this.cb.onToggleCountry(d.id);
      })
      .on("mousemove", (e: MouseEvent, d) => this.onHover(e, d, d.id))
      .on("mouseleave", () => this.scheduleHide());
  }

  /**
   * `cc` is the country the hovered shape belongs to — itself for a country,
   * the parent for a region. A split country is click-through, so hovering it
   * lands on a region; without this the merge button would be unreachable.
   */
  private onHover(e: MouseEvent, d: Feat, cc: string) {
    clearTimeout(this.hideTimer);
    this.showTooltip(e, localName(d.properties));
    const next = this.splittable.has(cc) ? cc : null;
    if (this.hoverCC !== next) {
      this.hoverCC = next;
      this.refreshSplitButton();
    }
  }

  private showTooltip(e: MouseEvent, text: string) {
    const r = this.root.getBoundingClientRect();
    this.tooltip.textContent = text;
    this.tooltip.hidden = false;
    this.tooltip.style.left = `${e.clientX - r.left}px`;
    this.tooltip.style.top = `${e.clientY - r.top}px`;
  }

  private scheduleHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hideSplitButton(true), 350) as unknown as number;
  }

  private hideSplitButton(alsoTooltip = false) {
    this.hoverCC = null;
    this.splitBtn.hidden = true;
    if (alsoTooltip) this.tooltip.hidden = true;
  }

  private refreshSplitButton() {
    if (!this.hoverCC) {
      this.splitBtn.hidden = true;
      return;
    }
    const expanded = this.data?.expanded.has(this.hoverCC) ?? false;
    const label = expanded ? t("mergeBack") : t("splitInto");
    // Icon only — a labelled pill was large enough to catch stray clicks.
    this.splitBtn.innerHTML = expanded ? ICON_MERGE : ICON_SPLIT;
    this.splitBtn.title = label;
    this.splitBtn.setAttribute("aria-label", label);
    this.splitBtn.hidden = false;
    this.positionSplitButton();
  }

  /**
   * Centre of the country's biggest landmass. The plain centroid of the whole
   * feature drifts into the sea for countries with far-flung parts — Alaska
   * and Hawaii drag the USA's up towards Greenland.
   */
  private largestPart(f: Feat): unknown {
    const hit = this.parts.get(f.id);
    if (hit) return hit;
    let best: unknown = f.geometry;
    if (f.geometry.type === "MultiPolygon") {
      let bestArea = -1;
      for (const coordinates of f.geometry.coordinates) {
        const poly = { type: "Polygon", coordinates };
        const area = this.path.area(poly as never);
        if (area > bestArea) {
          bestArea = area;
          best = poly;
        }
      }
    }
    this.parts.set(f.id, best);
    return best;
  }

  private anchorOf(f: Feat): [number, number] {
    const hit = this.anchors.get(f.id);
    if (hit) return hit;
    const c = this.path.centroid(this.largestPart(f) as never) as [number, number];
    this.anchors.set(f.id, c);
    return c;
  }

  private positionSplitButton() {
    if (!this.hoverCC || this.splitBtn.hidden) return;
    const f = this.byCC.get(this.hoverCC);
    if (!f) return;
    const [cx, cy] = this.anchorOf(f);
    if (!Number.isFinite(cx)) return;
    const [sx, sy] = this.toScreen([cx, cy]);
    // Sits above the middle, leaving the spot you aim at to select the country.
    const x = Math.min(Math.max(sx, 14), this.w - 14);
    const y = Math.min(Math.max(sy - 26, 14), this.h - 14);
    this.splitBtn.style.left = `${x}px`;
    this.splitBtn.style.top = `${y}px`;
  }

  /** Zooms so a country fills most of the view. */
  zoomTo(cc: string) {
    const f = this.byCC.get(cc);
    if (!f) return;
    // Bounds of the biggest landmass only: France reaches to French Guiana
    // and Reunion, so the full extent would zoom nowhere near the mainland.
    const [[x0, y0], [x1, y1]] = this.path.bounds(this.largestPart(f) as never);
    const k = Math.min(60, 0.7 / Math.max((x1 - x0) / this.w, (y1 - y0) / this.h));
    const tx = this.w / 2 - (k * (x0 + x1)) / 2;
    const ty = this.h / 2 - (k * (y0 + y1)) / 2;
    this.svg
      .transition()
      .duration(600)
      .call(this.zoomBehavior.transform, zoomIdentity.translate(tx, ty).scale(k));
  }

  zoomBy(factor: number) {
    this.svg.transition().duration(250).call(this.zoomBehavior.scaleBy, factor);
  }

  resetZoom() {
    this.svg.transition().duration(450).call(this.zoomBehavior.transform, zoomIdentity);
  }

  /** Recomputes projected pin coordinates (after a re-fit) and rescales them. */
  private placePins() {
    const proj = this.projection;
    this.gPins.selectAll<SVGGElement, PinnedCity>("g.pin").each(function (d) {
      const p = proj([d.lon, d.lat]);
      this.dataset.x = String(p?.[0] ?? 0);
      this.dataset.y = String(p?.[1] ?? 0);
    });
    this.rescalePins();
  }

  private rescalePins() {
    const k = this.transform.k;
    this.gPins.selectAll<SVGGElement, unknown>("g.pin").attr("transform", function () {
      const el = this as SVGGElement;
      const x = el.dataset.x!;
      const y = el.dataset.y!;
      return `translate(${x},${y}) scale(${1 / k})`;
    });
  }

  /** Repaints fills, regions and pins from the current map data. */
  render(data: TravelData) {
    this.data = data;

    const visitedViaState = new Set<string>();
    for (const s of data.states) visitedViaState.add(s.slice(0, s.indexOf("-")));

    this.gCountries
      .selectAll<SVGPathElement, Feat>("path")
      .attr("class", (d) => {
        if (data.expanded.has(d.id)) return "country expanded";
        if (data.countries.has(d.id)) return "country sel";
        if (visitedViaState.has(d.id)) return "country partial";
        return "country";
      })
      .attr("aria-label", (d) => localName(d.properties));

    const shown = this.states.filter((s) => data.expanded.has(s.properties.country ?? ""));
    this.gStates
      .selectAll<SVGPathElement, Feat>("path")
      .data(shown, (d) => d.id)
      .join("path")
      .attr("d", (d) => this.path(d) ?? "")
      .attr("class", (d) => (data.states.has(d.id) ? "state sel" : "state"))
      .on("click", (e: MouseEvent, d) => {
        e.stopPropagation();
        this.closeCityPopup();
        this.cb.onToggleState(d.id);
      })
      .on("mousemove", (e: MouseEvent, d) => this.onHover(e, d, d.properties.country ?? ""))
      .on("mouseleave", () => this.scheduleHide());

    const k = this.transform.k;
    this.gPins
      .selectAll<SVGGElement, TravelData["cities"][number]>("g.pin")
      .data(data.cities, (d) => cityKey(d))
      .join((enter) => {
        const g = enter.append("g").attr("class", "pin");
        g.append("circle").attr("class", "pin-halo").attr("r", 7);
        g.append("circle").attr("class", "pin-dot").attr("r", 3.2);
        g.append("title");
        // Opens a confirmation popover — a stray click must not delete a pin.
        g.on("click", (e: MouseEvent, d) => {
          e.stopPropagation();
          this.openCityPopup(d);
        });
        return g;
      })
      .each((d, i, nodes) => {
        const p = this.projection([d.lon, d.lat]);
        const el = nodes[i];
        el.dataset.x = String(p?.[0] ?? 0);
        el.dataset.y = String(p?.[1] ?? 0);
        el.querySelector("title")!.textContent = d.name;
      })
      .attr("transform", function () {
        const el = this as SVGGElement;
        return `translate(${el.dataset.x},${el.dataset.y}) scale(${1 / k})`;
      });

    this.refreshSplitButton();
    this.positionCityPopup();
  }

  /** Re-labels everything after a language switch. */
  relabel() {
    this.refreshSplitButton();
    this.closeCityPopup();
  }
}
