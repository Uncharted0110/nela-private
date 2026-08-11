/**
 * Fetch slide-image candidates from a model-authored web query.
 *
 * The query is used as a seed (no "key facts history" / travel framing).
 * Results are diversified across a few photo-oriented query variants, then
 * deduped by canonical URL *and* downloaded content so the picker never shows
 * the same picture six times.
 */

import { Api } from "../../api";

export type SlideImageCandidate = {
  dataUri: string;
  sourceUrl: string;
  caption: string;
};

const NELA_IMG_SRC_ATTR = "data-nela-img-src";

/** Path/host patterns that are almost never usable slide photos. */
const JUNK_IMAGE_PATH =
  /\/(?:flags?|icons?|icon|favicon|sprites?|logo|logos|badge|badges|emoji|emoticons?|avatar|avatars|thumb\.php|spacer|pixel|tracking|1x1|blank)\b/i;

const JUNK_IMAGE_EXT = /\.(?:svg|ico|gif)(?:$|[?#])/i;

const JUNK_IMAGE_HOST =
  /(?:^|\.)(?:icons\.com|iconfinder\.com|flaticon\.com|iconscout\.com|fontawesome\.com|gravatar\.com)/i;

/** Recently offered content fingerprints — skip on the next pick so repeats vary. */
const RECENT_FINGERPRINTS: string[] = [];
const RECENT_FINGERPRINT_LIMIT = 32;

/** Rotates which secondary query variants we fire so repeat searches diverge. */
let queryRotation = 0;

/**
 * True when a URL looks like a real photo/illustration worth embedding on a
 * slide — not an SVG flag, favicon, tracking pixel, or icon CDN asset.
 */
export function isUsableSlideImageUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const path = `${parsed.pathname}${parsed.search}`;
  if (JUNK_IMAGE_HOST.test(host)) return false;
  if (JUNK_IMAGE_EXT.test(path)) return false;
  if (JUNK_IMAGE_PATH.test(path)) return false;
  if (parsed.pathname.length < 4) return false;
  return true;
}

/**
 * Collapse thumb/size variants of the same asset onto one key so
 * `…/thumb/a/ab/Foo.jpg/220px-Foo.jpg` and `…/a/ab/Foo.jpg` count as one.
 */
export function canonicalImageKey(url: string): string {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase();
    let path = u.pathname;

    const wmThumb = path.match(
      /\/wikipedia\/[^/]+\/thumb\/.\/[^/]+\/([^/]+)\/\d+px-[^/]+$/i
    );
    if (wmThumb?.[1]) return `wm:${decodeURIComponent(wmThumb[1]).toLowerCase()}`;

    const wmFull = path.match(/\/wikipedia\/[^/]+\/.\/[^/]+\/([^/]+)$/i);
    if (wmFull?.[1]) return `wm:${decodeURIComponent(wmFull[1]).toLowerCase()}`;

    for (const key of [
      "w",
      "h",
      "width",
      "height",
      "fit",
      "crop",
      "q",
      "quality",
      "auto",
      "fm",
      "ixid",
      "ixlib",
    ]) {
      u.searchParams.delete(key);
    }
    u.hash = "";
    path = u.pathname.replace(/-\d+x\d+(?=\.[a-z]+$)/i, "");
    path = path.replace(/\/\d+px-/i, "/");
    return `${host}${path.toLowerCase()}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Cheap content fingerprint so identical bytes under different URLs collapse. */
export function contentFingerprint(dataUri: string): string {
  const b64 = dataUri.replace(/^data:image\/[^;]+;base64,/i, "");
  const len = b64.length;
  if (len < 48) return `${len}:${b64}`;
  const mid = Math.floor(len / 2);
  return `${len}:${b64.slice(0, 48)}:${b64.slice(mid, mid + 48)}:${b64.slice(-48)}`;
}

function rememberFingerprint(fp: string): void {
  if (RECENT_FINGERPRINTS.includes(fp)) return;
  RECENT_FINGERPRINTS.push(fp);
  while (RECENT_FINGERPRINTS.length > RECENT_FINGERPRINT_LIMIT) {
    RECENT_FINGERPRINTS.shift();
  }
}

/** Prefer Wikimedia / Unsplash / known photo CDNs when ranking candidates. */
function imageUrlScore(url: string): number {
  const lower = url.toLowerCase();
  let score = 0;
  if (/upload\.wikimedia\.org|commons\.wikimedia/.test(lower)) score += 5;
  if (/images\.unsplash\.com|unsplash\.com/.test(lower)) score += 4;
  if (/pexels\.com|pixabay\.com|flickr\.com/.test(lower)) score += 3;
  if (/\.(?:jpe?g|png|webp)(?:$|[?#])/i.test(lower)) score += 2;
  if (/\/thumb\//i.test(lower)) score -= 1;
  return score;
}

/**
 * Build a small set of photo-oriented query variants. A rotation counter makes
 * repeat "change image to X" requests pull different secondary angles.
 */
export function diversifyImageQueries(query: string): string[] {
  const base = query.trim().replace(/\s+/g, " ").slice(0, 100);
  if (!base) return [];

  const alreadyPhoto = /\b(?:photo|portrait|image|picture|pic)\b/i.test(base);
  const suffixes = alreadyPhoto
    ? ["", "action shot", "close up", "stadium", "interview", "training"]
    : [
        "photo",
        "portrait photo",
        "action shot photo",
        "close up photo",
        "high resolution photo",
        "press photo",
      ];

  const rot = queryRotation++ % Math.max(1, suffixes.length - 1);
  const picked = [base];
  for (let i = 0; i < 2; i++) {
    const suffix = suffixes[(rot + i) % suffixes.length]!;
    const q = suffix ? `${base} ${suffix}`.slice(0, 120) : base;
    if (!picked.includes(q)) picked.push(q);
  }
  return picked;
}

/** Collect provenance URLs already embedded in the deck HTML. */
export function listDeckImageSources(html: string): string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(
    `${NELA_IMG_SRC_ATTR}\\s*=\\s*["']([^"']+)["']`,
    "gi"
  );
  for (const m of html.matchAll(re)) {
    const url = (m[1] ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push(url);
  }
  return sources;
}

async function collectGalleryUrls(
  queries: string[],
  hitCaptions: Map<string, string>
): Promise<string[]> {
  const gallery: string[] = [];
  const results = await Promise.all(
    queries.map(async (q) => {
      try {
        return await Api.webSearch(q, 8, { profile: "simple" });
      } catch (err) {
        console.warn("Slide image search failed:", q, err);
        return null;
      }
    })
  );

  for (const result of results) {
    if (!result) continue;
    for (const url of result.images ?? []) {
      if (/^https?:\/\//i.test(url)) gallery.push(url);
    }
    for (const hit of result.results ?? []) {
      if (hit.image_url && /^https?:\/\//i.test(hit.image_url)) {
        gallery.push(hit.image_url);
        if (hit.title?.trim()) hitCaptions.set(hit.image_url, hit.title.trim());
      }
    }
  }
  return gallery;
}

/**
 * Search the web for images matching `query` and download up to `count`
 * distinct candidates, skipping any URL in `excludeSources`.
 */
export async function fetchSlideImageCandidates(opts: {
  query: string;
  count?: number;
  excludeSources?: Iterable<string>;
  onStatus?: (message: string) => void;
}): Promise<SlideImageCandidate[]> {
  const query = opts.query.trim().slice(0, 200);
  const count = Math.max(1, Math.min(opts.count ?? 6, 8));
  if (!query) return [];

  const exclude = new Set(
    [...(opts.excludeSources ?? [])]
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u))
  );
  const excludeCanonical = new Set(
    [...exclude].map((u) => canonicalImageKey(u))
  );
  const recent = new Set(RECENT_FINGERPRINTS);

  const queries = diversifyImageQueries(query);
  opts.onStatus?.(
    queries.length > 1
      ? `Searching images for “${query}” (${queries.length} angles)…`
      : `Searching images for “${query}”…`
  );

  const hitCaptions = new Map<string, string>();
  const gallery = await collectGalleryUrls(queries, hitCaptions);
  if (!gallery.length) return [];

  const seenKeys = new Set<string>();
  const urls: string[] = [];
  for (const url of gallery) {
    const normalized = url.trim();
    if (!normalized || exclude.has(normalized)) continue;
    if (!isUsableSlideImageUrl(normalized)) continue;
    const key = canonicalImageKey(normalized);
    if (!key || seenKeys.has(key) || excludeCanonical.has(key)) continue;
    seenKeys.add(key);
    urls.push(normalized);
  }
  urls.sort((a, b) => imageUrlScore(b) - imageUrlScore(a));

  // Cap per-host so one Wikimedia match doesn't fill the whole strip.
  const hostCounts = new Map<string, number>();
  const interleaved: string[] = [];
  const deferred: string[] = [];
  for (const url of urls) {
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      host = "";
    }
    const n = hostCounts.get(host) ?? 0;
    if (n < 2) {
      hostCounts.set(host, n + 1);
      interleaved.push(url);
    } else {
      deferred.push(url);
    }
  }
  const ordered = [...interleaved, ...deferred];
  const tryLimit = Math.min(ordered.length, Math.max(count * 5, 20));

  type Downloaded = {
    url: string;
    dataUri: string;
    fp: string;
    caption: string;
  };
  const downloaded: Downloaded[] = [];
  const seenFingerprints = new Set<string>();

  for (let i = 0; i < tryLimit; i++) {
    const url = ordered[i]!;
    try {
      const dataUri = await Api.downloadImageDataUri(url);
      if (!dataUri?.startsWith("data:image/")) continue;
      if (/^data:image\/svg\+xml/i.test(dataUri)) continue;
      const fp = contentFingerprint(dataUri);
      if (seenFingerprints.has(fp)) continue;
      seenFingerprints.add(fp);
      downloaded.push({
        url,
        dataUri,
        fp,
        caption: hitCaptions.get(url) || "Web image",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/\b403\b|\b401\b|\b404\b|Forbidden|Unauthorized|Not Found/i.test(msg)) {
        console.warn("Failed to download slide image candidate:", url, err);
      }
    }
  }

  // Prefer images not shown in recent pickers; fall back if that leaves too few.
  let fresh = downloaded.filter((d) => !recent.has(d.fp));
  if (fresh.length < Math.min(3, count)) {
    fresh = downloaded;
  }

  const candidates = fresh.slice(0, count).map((d) => ({
    dataUri: d.dataUri,
    sourceUrl: d.url,
    caption: d.caption,
  }));

  for (const c of candidates) {
    rememberFingerprint(contentFingerprint(c.dataUri));
  }

  return candidates;
}

export { NELA_IMG_SRC_ATTR };
