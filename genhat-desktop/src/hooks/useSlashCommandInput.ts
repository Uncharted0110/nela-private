import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import {
  activeSlashQuery,
  filterSlashCommands,
  insertSlashCommand,
  type SlashCommandDef,
} from "../app/slashCommands";

interface UseSlashCommandInputOptions {
  value: string;
  onChange: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  enabled?: boolean;
}

export function useSlashCommandInput({
  value,
  onChange,
  textareaRef,
  enabled = true,
}: UseSlashCommandInputOptions) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [cursor, setCursor] = useState(0);

  const slashContext = useMemo(() => {
    if (!enabled) return null;
    return activeSlashQuery(value, cursor);
  }, [enabled, value, cursor]);

  const filteredCommands = useMemo(() => {
    if (!enabled || !slashContext) return [];
    return filterSlashCommands(slashContext.query);
  }, [enabled, slashContext]);

  const showMenu = enabled && menuOpen && !!slashContext && filteredCommands.length > 0;

  const syncCursor = useCallback(() => {
    const next = textareaRef.current?.selectionStart ?? value.length;
    setCursor(next);
  }, [textareaRef, value.length]);

  const handleChange = useCallback(
    (nextValue: string) => {
      onChange(nextValue);
      const ta = textareaRef.current;
      const nextCursor = ta?.selectionStart ?? nextValue.length;
      setCursor(nextCursor);
      const ctx = activeSlashQuery(nextValue, nextCursor);
      setMenuOpen(!!ctx);
      setActiveIndex(0);
    },
    [onChange, textareaRef]
  );

  const applyCommand = useCallback(
    (command: SlashCommandDef) => {
      const ta = textareaRef.current;
      const currentCursor = ta?.selectionStart ?? cursor;
      const { nextValue, nextCursor } = insertSlashCommand(value, currentCursor, command.token);
      onChange(nextValue);
      setMenuOpen(false);
      setActiveIndex(0);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(nextCursor, nextCursor);
        setCursor(nextCursor);
      });
    },
    [cursor, onChange, textareaRef, value]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>, onEnter?: () => void) => {
      if (!showMenu) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onEnter?.();
        }
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const selected = filteredCommands[activeIndex] ?? filteredCommands[0];
        if (selected) applyCommand(selected);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
      }
    },
    [activeIndex, applyCommand, filteredCommands, showMenu]
  );

  return {
    showMenu,
    filteredCommands,
    activeIndex,
    handleChange,
    handleKeyDown,
    applyCommand,
    syncCursor,
    closeMenu: () => setMenuOpen(false),
  };
}
