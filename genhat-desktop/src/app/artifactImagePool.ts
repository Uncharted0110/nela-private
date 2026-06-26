/**
 * Collect and attach images for HTML / presentation artifacts.
 */

import { Api } from "../api";
import type { ArtifactImageAsset, HtmlPlan, PresentationPlan, SearchHit } from "../types";

export type ImagePoolEntry = ArtifactImageAsset & { index: number };

/** Build a catalog from web hits + optional document path. */
export async function buildArtifactImagePool(options: {
  webHits?: SearchHit[];
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

  if (options.webHits?.length) {
    for (const hit of options.webHits) {
      if (!hit.image_url || pool.length >= max) break;
      try {
        const dataUri = await Api.downloadImageDataUri(hit.image_url);
        push({
          data_uri: dataUri,
          caption: hit.title || "Web image",
          alt: hit.title,
        });
      } catch (err) {
        console.warn("Failed to download web image:", hit.image_url, err);
      }
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
    `AVAILABLE IMAGES — set image_index to use in IMAGE_LEFT / IMAGE sections:\n` +
    `${lines.join("\n")}\n` +
    `Use different image_index values across slides/sections when possible.\n\n`
  );
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
  const slides = (plan.slides ?? []).map((slide, i) => {
    if (slide.layout === "IMAGE_LEFT" && slide.image_index == null) {
      return { ...slide, image_index: i % pool.length };
    }
    return slide;
  });
  return { ...plan, images, slides };
}

export function attachImagesToHtmlPlan(plan: HtmlPlan, pool: ImagePoolEntry[]): HtmlPlan {
  if (!pool.length) return plan;
  const images = pool.map(({ data_uri, caption, alt }) => ({
    data_uri,
    caption,
    alt,
  }));
  const sections = (plan.sections ?? []).map((section, i) => {
    if (
      (section.kind === "IMAGE" || section.kind === "HERO") &&
      section.image_index == null &&
      pool.length > 0
    ) {
      if (section.kind === "IMAGE") {
        return { ...section, image_index: i % pool.length };
      }
    }
    return section;
  });
  return { ...plan, images, sections };
}
