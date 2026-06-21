import type { SlashCommandDef } from "../app/slashCommands";

interface SlashCommandMenuProps {
  commands: SlashCommandDef[];
  activeIndex: number;
  onSelect: (command: SlashCommandDef) => void;
}

export default function SlashCommandMenu({
  commands,
  activeIndex,
  onSelect,
}: SlashCommandMenuProps) {
  if (commands.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 mb-2 w-[min(320px,90vw)] rounded-xl bg-void-700/95 backdrop-blur-xl border border-glass-border shadow-[0_8px_32px_rgba(0,0,0,0.45)] p-1 z-[60] max-h-[280px] overflow-y-auto"
    >
      <div className="px-2.5 py-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-txt-muted">
        Commands
      </div>
      {commands.map((cmd, index) => {
        const active = index === activeIndex;
        return (
          <button
            key={cmd.id}
            type="button"
            role="option"
            aria-selected={active}
            className={[
              "w-full text-left rounded-lg px-2.5 py-2 transition-colors duration-100",
              active
                ? "bg-neon-subtle text-neon"
                : "text-txt-secondary hover:bg-glass-hover hover:text-txt",
            ].join(" ")}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(cmd);
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.82rem] font-semibold">{cmd.label}</span>
              {cmd.web && (
                <span className="text-[0.62rem] uppercase tracking-wide text-txt-muted">modifier</span>
              )}
            </div>
            <div className="text-[0.74rem] text-txt-muted mt-0.5 leading-snug">{cmd.description}</div>
          </button>
        );
      })}
    </div>
  );
}
