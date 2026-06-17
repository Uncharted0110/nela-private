import { useEffect, useState, useCallback } from "react";

const STORAGE_KEY = "nela:ux:theme:v1";
export type ThemeName = "professional" | "neon";

/** Professional (light) is the DEFAULT for the non-technical target market. */
function readTheme(): ThemeName {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "neon" || v === "professional") return v;
    const legacy = localStorage.getItem("nela-theme");
    if (legacy === "dark") return "neon";
    if (legacy === "light") return "professional";
    return "professional";
  } catch {
    return "professional";
  }
}

export function applyTheme(theme: ThemeName) {
  const root = document.documentElement;
  if (theme === "professional") root.setAttribute("data-theme", "professional");
  else root.removeAttribute("data-theme"); // neon = default :root tokens
}

export function useTheme(): { theme: ThemeName; setTheme: (t: ThemeName) => void } {
  const [theme, setThemeState] = useState<ThemeName>(() => readTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((t: ThemeName) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
    setThemeState(t);
  }, []);

  return { theme, setTheme };
}
