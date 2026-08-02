import type { TravelData, PinnedCity } from "./model";
import { emptyData } from "./model";

// Field / record separators. These are control characters, so they can never
// collide with a city name, and they survive the UTF-8 round trip untouched.
const FS = "\u001f"; // between the four sections
const RS = "\u001e"; // between city records
const US = "\u001d"; // between fields of one city record

const RAW = 1;
const DEFLATE = 2;

function serialize(d: TravelData): string {
  const cities = d.cities
    .map((c) => [c.lat.toFixed(4), c.lon.toFixed(4), c.cc, c.name].join(US))
    .join(RS);
  return [
    "1",
    [...d.countries].sort().join(","),
    [...d.states].sort().join(","),
    [...d.expanded].sort().join(","),
    cities,
  ].join(FS);
}

function deserialize(s: string): TravelData | null {
  const parts = s.split(FS);
  if (parts.length < 5 || parts[0] !== "1") return null;
  const split = (x: string) => (x ? x.split(",").filter(Boolean) : []);
  const cities: PinnedCity[] = [];
  if (parts[4]) {
    for (const rec of parts[4].split(RS)) {
      const f = rec.split(US);
      if (f.length < 4) continue;
      const lat = Number(f[0]);
      const lon = Number(f[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      cities.push({ lat, lon, cc: f[2], name: f.slice(3).join(US) });
    }
  }
  return {
    countries: new Set(split(parts[1])),
    states: new Set(split(parts[2])),
    expanded: new Set(split(parts[3])),
    cities,
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array | null {
  try {
    const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function pipe(bytes: Uint8Array, s: CompressionStream | DecompressionStream) {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(s as ReadableWritablePair);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Packs the map into a URL-safe base64 payload. Compresses when the browser
 * supports it — city names dominate the payload and deflate roughly halves it.
 */
export async function encodeState(d: TravelData): Promise<string> {
  const raw = new TextEncoder().encode(serialize(d));
  if (typeof CompressionStream !== "undefined") {
    try {
      const packed = await pipe(raw, new CompressionStream("deflate-raw"));
      if (packed.length < raw.length) {
        const out = new Uint8Array(packed.length + 1);
        out[0] = DEFLATE;
        out.set(packed, 1);
        return toBase64Url(out);
      }
    } catch {
      // fall through to the uncompressed form
    }
  }
  const out = new Uint8Array(raw.length + 1);
  out[0] = RAW;
  out.set(raw, 1);
  return toBase64Url(out);
}

export async function decodeState(payload: string): Promise<TravelData | null> {
  const bytes = fromBase64Url(payload);
  if (!bytes || bytes.length < 2) return null;
  const body = bytes.subarray(1);
  let text: string;
  try {
    if (bytes[0] === DEFLATE) {
      if (typeof DecompressionStream === "undefined") return null;
      text = new TextDecoder().decode(await pipe(body, new DecompressionStream("deflate-raw")));
    } else if (bytes[0] === RAW) {
      text = new TextDecoder().decode(body);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  return deserialize(text) ?? emptyData();
}
