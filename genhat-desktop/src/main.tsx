import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { applyTheme } from "./hooks/useTheme";
import App from "./App";

(() => {
  try {
    const t = localStorage.getItem("nela:ux:theme:v1");
    const legacy = localStorage.getItem("nela-theme");
    if (t === "neon" || legacy === "dark") applyTheme("neon");
    else applyTheme("professional");
  } catch {
    applyTheme("professional");
  }
})();
import TourProviderRoot from "./components/TourProviderRoot";
import { TOURS } from "./tours";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TourProviderRoot tours={TOURS}>
      <App />
    </TourProviderRoot>
  </StrictMode>
);
