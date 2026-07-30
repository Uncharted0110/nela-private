# NELA Cloud — local desktop integration

Run the API and desktop against **localhost** (local Postgres). No Neon required for this phase.

## 1. API (`nela-backend`)

```bash
cd nela-backend
# Ensure .env has:
#   DATABASE_URL=postgresql://...   # Neon (or local Postgres)
#   OPENROUTER_MANAGEMENT_KEY=...   # preferred; mints completion keys on boot
#   CLOUD_ENTITLEMENT_OVERRIDE=pro  # unlock Smart/Deep for local testing
#   TOKEN_ENCRYPTION_KEY_BASE64=... # optional locally (plain: storage if unset)

npm run db:push          # first time / schema changes
npm run dev              # http://localhost:3001
```

On boot, `ensureDefaultPools` mints free/paid `ProviderKey` rows via the Management API.

## 2. Desktop (`nela/genhat-desktop`)

```bash
cd nela/genhat-desktop
cp .env.example .env
# NELA_CLOUD_API_BASE_URL=http://localhost:3001
# NELA_CLOUD_WEB_BASE_URL=http://localhost:3000

npm run tauri dev        # or your usual desktop launch
```

## 3. Sign in

- **Device link:** Profile → start device auth → open verification URL → enter code on the web app (`:3000/account/link-device`).
- **Email:** register/login against the local API.

Then Cloud Settings → choose **NELA Cloud** or **Auto (prefer cloud)**.

Intelligence selector **Fast / Smart / Deep / Auto** maps to API `mode` on cloud turns. Auto on local uses the Smart GGUF.

## 4. Smoke checklist

| Test | Expect |
|------|--------|
| Chat Fast cloud | Streamed reply; no `OPENROUTER_NOT_CONFIGURED` |
| Smart/Deep with `CLOUD_ENTITLEMENT_OVERRIDE=pro` | Paid lane models |
| Intelligence Auto + cloud | Server auto-router; reply succeeds |
| Web search enabled + cloud | Native `tools[]` web_search round-trip |
| MCP tools (spreadsheet/ppt/html) via chat | Model may call `generate_*`; writers run on desktop |
| Artifact `/excel` etc. on cloud | No GBNF; `response_format: json_object`; file written locally |
| File context without consent | Forced local (or blocked from cloud) |
| API stopped + routing Auto | Falls back to local llama |

## Architecture notes

- OpenRouter keys never leave `apps/api`. Desktop only holds JWT session tokens.
- Local path keeps GBNF grammars; cloud path skips them.
- Tool execution (web_search, MCP writers) always runs on the desktop; the API only forwards `tools` / `tool_calls` to OpenRouter.
- **Prompt caching:** the API marks the first system message and last tool with OpenRouter `cache_control` (1h TTL), passes desktop `sessionId` as `session_id` for sticky routing, and adds top-level `cache_control` for Anthropic models. Desktop keeps NELA identity / artifact JSON schemas as a stable first system message; dynamic RAG/ambient/per-request instructions go in later messages.
