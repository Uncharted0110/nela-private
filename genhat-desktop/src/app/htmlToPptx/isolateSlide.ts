import { copyAncestorBackground, findSlideElements } from "./slideRoots.ts";
import { collectTextHosts } from "./textHosts.ts";

type StyleSnap = { el: HTMLElement; cssText: string };

function snapshot(el: HTMLElement): StyleSnap {
  return { el, cssText: el.style.cssText };
}

function restore(snaps: StyleSnap[]): void {
  for (const s of snaps) s.el.style.cssText = s.cssText;
}

export function isolateSlide(
  slides: HTMLElement[],
  current: HTMLElement
): () => void {
  const snaps: StyleSnap[] = slides.map(snapshot);
  for (const s of slides) {
    if (s === current) continue;
    s.classList.remove("active");
    s.style.opacity = "0";
    s.style.visibility = "hidden";
    s.style.pointerEvents = "none";
  }
  current.classList.add("active");
  current.style.opacity = "1";
  current.style.visibility = "visible";
  current.style.pointerEvents = "auto";
  current.style.transition = "none";
  current.style.transform = "none";
  // Keep computed display (flex/grid). Forcing block collapses centering.
  return () => restore(snaps);
}

/** Freeze the 16:9 stage so preview `transform: scale(...)` is not measured. */
export function pinExportLayout(doc: Document): void {
  const stages = doc.querySelectorAll<HTMLElement>(".slide-stage, #stage");
  for (const stage of stages) {
    stage.style.setProperty("transform", "none", "important");
    stage.style.setProperty("width", "1280px", "important");
    stage.style.setProperty("height", "720px", "important");
  }
}

export function hideTextForCapture(slide: HTMLElement): () => void {
  const hosts = collectTextHosts(slide);
  const snaps = hosts.map(snapshot);
  for (const el of hosts) {
    el.style.color = "transparent";
    el.style.textShadow = "none";
    el.style.setProperty("-webkit-text-fill-color", "transparent");
  }
  return () => restore(snaps);
}

export function hideMediaForCapture(hosts: HTMLElement[]): () => void {
  const snaps = hosts.map(snapshot);
  for (const el of hosts) {
    el.style.visibility = "hidden";
  }
  return () => restore(snaps);
}

export function prepareSlidesForExport(
  doc: Document,
  win: Window
): HTMLElement[] {
  const slides = findSlideElements(doc, win);
  for (const slide of slides) {
    copyAncestorBackground(slide, win);
  }
  return slides;
}
