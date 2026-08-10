/**
 * Collect and attach images for HTML / presentation artifacts.
 */

import { Api } from "../api";
import type { ArtifactImageAsset, HtmlPlan, PresentationPlan, SearchHit } from "../types";

export type ImagePoolEntry = ArtifactImageAsset & { index: number };

/** Build a catalog from web hits + gallery URLs + optional document path. */
export async function buildArtifactImagePool(options: {
  webHits?: SearchHit[];
  /** Top-level gallery URLs from WebSearchResult.images (often richer than hit.image_url). */
  galleryUrls?: string[];
  documentPath?: string | null;
  maxImages?: number;
}): Promise<ImagePoolEntry[]> {
  const max = options.maxImages ?? 8;
  const pool: ImagePoolEntry[] = [];
  const seen = new Set<string>();

  const push = (asset: ArtifactImageAsset) => {
    const key = asset.data_uri.slice(0, 80);
    if (seen.has(key) || pool.length >= max) return;
    seen.add(key);
    pool.push({ ...asset, index: pool.length });
  };

  const downloadUrl = async (url: string, caption: string) => {
    if (!url || pool.length >= max) return;
    const normalized = url.trim();
    if (!/^https?:\/\//i.test(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    try {
      const dataUri = await Api.downloadImageDataUri(normalized);
      push({
        data_uri: dataUri,
        caption,
        alt: caption,
        source: normalized,
      });
    } catch (err) {
      console.warn("Failed to download web image:", normalized, err);
    }
  };

  if (options.galleryUrls?.length) {
    for (const url of options.galleryUrls) {
      if (pool.length >= max) break;
      await downloadUrl(url, "Web image");
    }
  }

  if (options.webHits?.length) {
    for (const hit of options.webHits) {
      if (pool.length >= max) break;
      if (!hit.image_url) continue;
      await downloadUrl(hit.image_url, hit.title || "Web image");
    }
  }

  if (options.documentPath && pool.length < max) {
    try {
      const docImages = await Api.extractDocumentImages(
        options.documentPath,
        max - pool.length
      );
      for (const img of docImages) {
        push({
          data_uri: img.data_uri,
          caption: img.caption,
          alt: img.caption,
        });
      }
    } catch (err) {
      console.warn("Document image extraction failed:", err);
    }
  }

  return pool;
}

export function formatImageCatalogForPrompt(pool: ImagePoolEntry[]): string {
  if (!pool.length) return "";
  const lines = pool.map(
    (img) => `[${img.index}] ${img.caption} (source: ${img.source ?? "attached"})`
  );
  return (
    `AVAILABLE IMAGES — embed with these placeholders (renderer replaces them with real bytes):\n` +
    `${lines.join("\n")}\n` +
    `For structured JSON plans: set image_index on IMAGE / IMAGE_LEFT / HERO sections.\n` +
    `For freeform HTML / PPT HTML: use <img src="nela-img:0"> (or nela-img:1, …) — never invent image URLs.\n` +
    `Use different indices across slides/sections when possible.\n\n`
  );
}

/**
 * Replace nela-img placeholders with data URIs. If none were used, inject a small
 * gallery so web-search images still appear in the artifact (like chat embeds).
 */
export function embedPoolImagesInHtml(
  html: string,
  pool: ImagePoolEntry[]
): string {
  if (!pool.length || !html.trim()) return html;

  let out = html;
  for (const img of pool) {
    const uri = img.data_uri;
    out = out.replace(new RegExp(`nela-img:${img.index}\\b`, "gi"), uri);
    out = out.replace(new RegExp(`nela-image://${img.index}\\b`, "gi"), uri);
    out = out.replace(new RegExp(`\\{\\{NELA_IMAGE_${img.index}\\}\\}`, "g"), uri);
  }

  const usedPoolImage = pool.some((img) => out.includes(img.data_uri.slice(0, 48)));
  if (usedPoolImage) return out;

  const figures = pool
    .slice(0, 4)
    .map((img) => {
      const alt = escapeAttr(img.alt || img.caption || `Image ${img.index}`);
      const caption = escapeHtml(img.caption || "");
      return (
        `<figure class="nela-web-figure" style="margin:0">` +
        `<img src="${img.data_uri}" alt="${alt}" style="width:100%;height:auto;border-radius:12px;display:block" />` +
        (caption
          ? `<figcaption style="margin-top:.4rem;font-size:.85rem;opacity:.75">${caption}</figcaption>`
          : "") +
        `</figure>`
      );
    })
    .join("\n");

  const gallery =
    `<section class="nela-web-images" aria-label="Related images" ` +
    `style="padding:1.5rem 1rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem">` +
    `${figures}</section>`;

  if (/<\/body>/i.test(out)) {
    return out.replace(/<\/body>/i, `${gallery}\n</body>`);
  }
  return `${out}\n${gallery}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

export function attachImagesToPresentationPlan(
  plan: PresentationPlan,
  pool: ImagePoolEntry[]
): PresentationPlan {
  if (!pool.length) return plan;
  const images = pool.map(({ data_uri, caption, alt }) => ({
    data_uri,
    caption,
    alt,
  }));
  let slides = (plan.slides ?? []).map((slide, i) => {
    if (slide.layout === "IMAGE_LEFT" && slide.image_index == null) {
      return { ...slide, image_index: i % pool.length };
    }
    return slide;
  });

  // Ensure at least one IMAGE_LEFT slide when we have web images and stats/content slides.
  const hasImageSlide = slides.some((s) => s.layout === "IMAGE_LEFT");
  if (!hasImageSlide && slides.length >= 3) {
    const targetIdx = Math.min(2, slides.length - 1);
    const target = slides[targetIdx];
    if (target && target.layout !== "TITLE" && target.layout !== "SECTION") {
      slides = slides.map((s, i) =>
        i === targetIdx
          ? { ...s, layout: "IMAGE_LEFT" as const, image_index: 0 }
          : s
      );
    }
  }

  return { ...plan, images, slides };
}

export function attachImagesToHtmlPlan(plan: HtmlPlan, pool: ImagePoolEntry[]): HtmlPlan {
  if (!pool.length) return plan;
  const images = pool.map(({ data_uri, caption, alt }) => ({
    data_uri,
    caption,
    alt,
  }));
  let sections = (plan.sections ?? []).map((section, i) => {
    if (section.image_index != null) return section;
    if (section.kind === "IMAGE") {
      return { ...section, image_index: i % pool.length };
    }
    if (section.kind === "HERO") {
      return { ...section, image_index: 0 };
    }
    return section;
  });

  const hasImageSection = sections.some((s) => s.kind === "IMAGE");
  if (!hasImageSection) {
    sections = [
      ...sections,
      {
        kind: "IMAGE" as const,
        title: "Related imagery",
        image_index: 0,
        items: [],
      },
    ];
  }

  return { ...plan, images, sections };
}
