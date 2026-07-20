/** Predefined avatar presets (inline SVG data URLs). */

export interface PresetAvatar {
  id: string;
  label: string;
  dataUrl: string;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const COLORS = [
  { bg: "#1a3a4a", accent: "#5eead4" },
  { bg: "#2a2540", accent: "#c4b5fd" },
  { bg: "#3a2a1a", accent: "#fbbf24" },
  { bg: "#1a2a3a", accent: "#38bdf8" },
  { bg: "#2a3a1a", accent: "#a3e635" },
  { bg: "#3a1a2a", accent: "#fb7185" },
  { bg: "#1a3a2a", accent: "#34d399" },
  { bg: "#2a1a3a", accent: "#e879f9" },
] as const;

function faceSvg(bg: string, accent: string, variant: number): string {
  const eyes =
    variant % 2 === 0
      ? `<circle cx="38" cy="42" r="4" fill="${accent}"/><circle cx="62" cy="42" r="4" fill="${accent}"/>`
      : `<rect x="33" y="39" width="10" height="5" rx="2" fill="${accent}"/><rect x="57" y="39" width="10" height="5" rx="2" fill="${accent}"/>`;
  const mouth =
    variant % 3 === 0
      ? `<path d="M40 62 Q50 72 60 62" stroke="${accent}" stroke-width="3" fill="none" stroke-linecap="round"/>`
      : variant % 3 === 1
        ? `<line x1="40" y1="64" x2="60" y2="64" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>`
        : `<path d="M40 66 Q50 58 60 66" stroke="${accent}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" rx="50" fill="${bg}"/>
  <circle cx="50" cy="48" r="28" fill="none" stroke="${accent}" stroke-width="3" opacity="0.35"/>
  ${eyes}
  ${mouth}
</svg>`;
}

export const PRESET_AVATARS: PresetAvatar[] = COLORS.map((c, i) => ({
  id: `preset-${i + 1}`,
  label: `Avatar ${i + 1}`,
  dataUrl: svgDataUrl(faceSvg(c.bg, c.accent, i)),
}));
