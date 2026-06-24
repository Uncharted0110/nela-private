/**
 * Prepare HTML artifact content for in-app iframe preview.
 * Avoids file:// origins (blocked in nested frames) and strips local file refs
 * the model may have invented.
 */

/** Strip file:// URLs and local-only bases from generated HTML before preview. */
export function sanitizeArtifactHtml(html: string): string {
  let out = html;

  out = out.replace(/<base[^>]*href\s*=\s*["']file:[^"']*["'][^>]*>/gi, "");
  out = out.replace(
    /(\s(?:src|href|data)\s*=\s*["'])file:[^"']*(["'])/gi,
    "$1#$2"
  );
  out = out.replace(/url\(\s*["']?file:[^)"']*["']?\s*\)/gi, "url(#)");
  out = out.replace(
    /<iframe([^>]*)\s+src\s*=\s*["']file:[^"']*["']([^>]*)>/gi,
    '<iframe$1 src="about:blank"$2>'
  );

  return out;
}

/** HTML safe to inject via iframe srcDoc (opaque origin, no file protocol). */
export function prepareArtifactHtmlPreview(html: string): string {
  return sanitizeArtifactHtml(html);
}
