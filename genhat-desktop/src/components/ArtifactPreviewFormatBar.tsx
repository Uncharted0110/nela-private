import { useRef } from "react";
import { Bold, Italic, ALargeSmall } from "lucide-react";
import { PRESENTATION_FORMAT_BAR_FONTS } from "../app/presentationFonts";

export type FormatCommand =
  | { cmd: "bold" }
  | { cmd: "italic" }
  | { cmd: "foreColor"; value: string }
  | { cmd: "fontName"; value: string }
  | { cmd: "fontSizeDelta"; value: number };

export interface ArtifactPreviewFormatBarProps {
  visible: boolean;
  onHold: () => void;
  onRelease: () => void;
  onCommand: (command: FormatCommand) => void;
}

/**
 * Compact text-format controls for the presentation preview editor.
 * Lives in the host (next to the selection chip); talks to the iframe via postMessage.
 */
export default function ArtifactPreviewFormatBar({
  visible,
  onHold,
  onRelease,
  onCommand,
}: ArtifactPreviewFormatBarProps) {
  const colorRef = useRef<HTMLInputElement>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!visible) return null;

  const hold = () => {
    if (releaseTimer.current) {
      clearTimeout(releaseTimer.current);
      releaseTimer.current = null;
    }
    onHold();
  };

  const scheduleRelease = () => {
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    releaseTimer.current = setTimeout(() => {
      releaseTimer.current = null;
      onRelease();
    }, 250);
  };

  const run = (command: FormatCommand) => {
    hold();
    onCommand(command);
    scheduleRelease();
  };

  return (
    <div
      className="flex justify-center"
      onPointerLeave={scheduleRelease}
      onPointerEnter={hold}
    >
      <div
        className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full border border-neon/40 bg-void-800/95 px-2.5 py-1.5 shadow-lg backdrop-blur"
        onMouseDown={(e) => {
          // Reduce focus steal; iframe still blurs — hold-edit handles that.
          e.preventDefault();
          hold();
        }}
      >
        <select
          aria-label="Font family"
          className="max-w-[9.5rem] rounded-full border border-white/10 bg-void-700/90 px-2 py-1 text-[0.7rem] text-txt focus:outline-none focus:border-neon/60"
          defaultValue=""
          onMouseDown={hold}
          onChange={(e) => {
            const value = e.target.value;
            if (!value) return;
            run({ cmd: "fontName", value });
            e.target.value = "";
          }}
        >
          <option value="" disabled>
            Font
          </option>
          {PRESENTATION_FORMAT_BAR_FONTS.map((font) => (
            <option key={font} value={font} style={{ fontFamily: font }}>
              {font}
            </option>
          ))}
        </select>

        <button
          type="button"
          title="Decrease font size"
          aria-label="Decrease font size"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-txt-muted hover:bg-void-600 hover:text-txt"
          onMouseDown={hold}
          onClick={() => run({ cmd: "fontSizeDelta", value: -2 })}
        >
          <span className="text-[0.65rem] font-semibold leading-none">A−</span>
        </button>
        <button
          type="button"
          title="Increase font size"
          aria-label="Increase font size"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-txt-muted hover:bg-void-600 hover:text-txt"
          onMouseDown={hold}
          onClick={() => run({ cmd: "fontSizeDelta", value: 2 })}
        >
          <ALargeSmall size={14} />
        </button>

        <button
          type="button"
          title="Bold"
          aria-label="Bold"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-txt-muted hover:bg-void-600 hover:text-txt"
          onMouseDown={hold}
          onClick={() => run({ cmd: "bold" })}
        >
          <Bold size={14} />
        </button>
        <button
          type="button"
          title="Italic"
          aria-label="Italic"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-txt-muted hover:bg-void-600 hover:text-txt"
          onMouseDown={hold}
          onClick={() => run({ cmd: "italic" })}
        >
          <Italic size={14} />
        </button>

        <label
          className="inline-flex h-7 items-center gap-1 rounded-full px-1.5 text-txt-muted hover:bg-void-600 hover:text-txt cursor-pointer"
          title="Text color"
          onMouseDown={hold}
        >
          <span className="text-[0.65rem] font-medium">Color</span>
          <input
            ref={colorRef}
            type="color"
            aria-label="Text color"
            defaultValue="#38bdf8"
            className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
            onMouseDown={hold}
            onChange={(e) => {
              run({ cmd: "foreColor", value: e.target.value });
            }}
          />
        </label>
      </div>
    </div>
  );
}
