import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Tracks whether any model download is currently running.
 * Listens to model-download-progress events from the Rust backend.
 */
export function useNetworkActivity(): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    const inFlight = new Set<string>();

    const wire = async () => {
      unsubs.push(
        await listen<{ model_id: string; progress: number; status: string }>(
          "model-download-progress",
          (event) => {
            const { model_id, progress, status } = event.payload;
            const done =
              progress >= 100 ||
              status === "Complete" ||
              status === "Cancelled" ||
              status === "Error" ||
              status.toLowerCase().includes("cancel") ||
              status.toLowerCase().includes("error") ||
              status.toLowerCase().includes("fail");

            if (done) {
              inFlight.delete(model_id);
            } else {
              inFlight.add(model_id);
            }
            setActive(inFlight.size > 0);
          }
        )
      );
    };
    void wire();

    return () => {
      unsubs.forEach((u) => u());
    };
  }, []);

  return active;
}
