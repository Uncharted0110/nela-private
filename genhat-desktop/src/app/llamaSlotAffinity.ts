/**
 * Pin each chat/workspace conversation to a llama-server KV slot (`id_slot`).
 *
 * With `--parallel 3` and `cache_prompt`, sessions must not share a slot or their
 * prompt caches bleed into each other. We keep an LRU map of up to 3 hot contexts.
 */

/** Must match `LLAMA_ROUTER_PARALLEL_SLOTS` in llama_router_preset.rs */
export const LLAMA_PARALLEL_SLOTS = 3;

interface SlotBinding {
  key: string;
  slot: number;
  lastUsed: number;
}

const bindings: SlotBinding[] = [];

/** Build a stable key for slot affinity. */
export function llamaContextKey(
  workspaceId: string | null | undefined,
  sessionId: string | null | undefined
): string {
  const ws = (workspaceId ?? "default").trim() || "default";
  const sid = (sessionId ?? "anon").trim() || "anon";
  return `${ws}::${sid}`;
}

/**
 * Resolve (and refresh) the llama-server slot for this conversation.
 * New chats get a free slot when available; otherwise the least-recently-used
 * binding is reused so at most {@link LLAMA_PARALLEL_SLOTS} stay hot.
 */
export function resolveLlamaSlot(contextKey: string): number {
  const key = contextKey.trim() || "default::anon";
  const existing = bindings.find((b) => b.key === key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.slot;
  }

  const used = new Set(bindings.map((b) => b.slot));
  for (let slot = 0; slot < LLAMA_PARALLEL_SLOTS; slot++) {
    if (!used.has(slot)) {
      bindings.push({ key, slot, lastUsed: Date.now() });
      return slot;
    }
  }

  // All slots busy — steal the LRU binding (its prior chat loses cached KV).
  bindings.sort((a, b) => a.lastUsed - b.lastUsed);
  const victim = bindings[0];
  victim.key = key;
  victim.lastUsed = Date.now();
  return victim.slot;
}

/** Drop affinity when a chat tab is closed. */
export function releaseLlamaSlot(contextKey: string): void {
  const key = contextKey.trim();
  const idx = bindings.findIndex((b) => b.key === key);
  if (idx >= 0) bindings.splice(idx, 1);
}

/** Clear all affinities (e.g. workspace switch). */
export function clearLlamaSlots(): void {
  bindings.length = 0;
}

/** Release every binding for a workspace prefix. */
export function releaseLlamaSlotsForWorkspace(workspaceId: string | null | undefined): void {
  const prefix = `${(workspaceId ?? "default").trim() || "default"}::`;
  for (let i = bindings.length - 1; i >= 0; i--) {
    if (bindings[i].key.startsWith(prefix)) {
      bindings.splice(i, 1);
    }
  }
}
