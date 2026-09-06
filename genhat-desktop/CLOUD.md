# NELA Cloud — desktop integration

By default the desktop app talks to **production**:

| Service | URL |
|---------|-----|
| API | `https://nela-gateway.onrender.com` |
| Website | `https://nela-webpage.vercel.app` |

If production is unreachable, it falls back to `http://localhost:3001` / `http://localhost:3000`.

## Local development
## 1. API (`nela-backend`)

```bash
cd nela-backend
# Ensure .env has:
#   DATABASE_URL=postgresql://...   # Neon (or local Postgres)
#   OPENROUTER_MANAGEMENT_KEY=...   # preferred; mints completion keys on boot
#   CLOUD_ENTITLEMENT_OVERRIDE=pro  # unlock Smart/Deep for local testing (seeds credit grant)
#   NELA_OR_USD_PER_CREDIT=0.0095   # 100 credits = $0.95 OpenRouter
#   USD_INR_RATE=83                 # non-IN USD list → INR paise
#   ADMIN_DASHBOARD_PASSWORD=...    # hidden /dashboard on the website
#   ADMIN_SESSION_SECRET=...        # HMAC for admin API tokens
#   TOKEN_ENCRYPTION_KEY_BASE64=... # optional locally (plain: storage if unset)

npm run db:push          # first time / schema changes
npm run dev              # http://localhost:3001
```

**List prices (no launch offer):** Free Fast 8/6h; Starter ₹399 → 800 credits/mo; Pro ₹999 → 2000 credits/mo; packs Nano/Plus/Max at ₹199/₹799/₹1,799. Geo adjusts paise for non-IN via USD list × `USD_INR_RATE`.

**Admin:** open `http://localhost:3000/dashboard` (no nav link). Set matching `ADMIN_SESSION_SECRET` on both API and webpage; password is `ADMIN_DASHBOARD_PASSWORD` on the API. Overview metrics come from Postgres materialized view `mv_admin_dashboard` (auto-refresh ≤5m, or **Refresh metrics**).

Override the defaults with a `.env` in `genhat-desktop`:

```bash
cd nela/genhat-desktop
cp .env.example .env
# NELA_CLOUD_API_BASE_URL=http://localhost:3001
# NELA_CLOUD_WEB_BASE_URL=http://localhost:3000
```

### 1. API (`nela-backend`)

```bash
cd nela-backend
npm run dev          # http://localhost:3001
```

### 2. Website (`NELA-Webpage`) — for device-link browser flow

```bash
cd NELA-Webpage
npm run dev          # http://localhost:3000
```

### 3. Desktop

```bash
cd nela/genhat-desktop
npm run tauri dev
```

## Sign in

- **Device link:** Profile → sign in → browser opens the verification page → enter the code.
- **Email:** register/login against the API.

Then Cloud Settings → choose **NELA Cloud** or **Auto (prefer cloud)**.

Intelligence selector **Fast / Smart / Deep / Auto** maps to API `mode` on cloud turns. Auto on local uses the Smart GGUF.

## Smoke checklist

| Test | Expect |
|------|--------|
| Chat Fast cloud | Streamed reply |
| Smart/Deep with a paid plan | Paid lane models |
| Intelligence Auto + cloud | Server auto-router; reply succeeds |
| Web search enabled + cloud | Native `tools[]` web_search round-trip |
| Artifact `/excel` etc. on cloud | File written locally |
| API stopped + routing Auto | Falls back to local llama |

## Architecture notes

- OpenRouter keys never leave the API. Desktop only holds JWT session tokens.
- Local path keeps GBNF grammars; cloud path skips them.
- Tool execution (web_search, MCP writers, Gmail send) always runs on the desktop.

## Google connectors (NELA ops — not end users)

End users only click **Connect Gmail** and Allow. They never see client IDs or `.env`.

Before a wide release:

1. On the NELA Google Cloud project (same org as website login), enable the Gmail API (Drive API later).
2. Create a **Desktop** OAuth client — not the website login client (`GOOGLE_CLIENT_ID` on the API).
3. Consent screen: app name NELA, support email, logo, homepage, privacy policy.
4. Bake the public client ID into release builds: set GitHub secret `NELA_GOOGLE_CONNECTOR_CLIENT_ID` (compile-time). Local `.env` is a dev override only.
5. Submit Google verification for `gmail.send` before shipping to non-test users. Until then, only GCP test users can connect without the “unverified app” warning.
- Fast/Smart/Deep model IDs are **not** hardcoded forever: the API sweeper pulls
  `GET https://openrouter.ai/api/v1/models` on boot and every
  `OPENROUTER_SWEEP_INTERVAL_MS` (default 6h), classifies free vs paid chat
  models, and refreshes the live catalog. Inspect with `GET /v1/models/catalog`
  or force with `POST /v1/models/sweep` (+ `MODELS_SWEEP_SECRET` in production).

## Drive connectors (File Indexer)

Desktop connectors sync remote folders (Google Drive first) into local mirrors under
`{app_data}/connectors/mirrors/`, then register those paths as File Indexer roots.

- **OAuth only on the API:** `POST /v1/connectors/oauth/start|poll|refresh` and
  `GET /v1/connectors/oauth/callback`. No Drive file bytes go through NELA Cloud.
- Env: reuse `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, or set
  `GOOGLE_CONNECTOR_CLIENT_ID` / `GOOGLE_CONNECTOR_CLIENT_SECRET` /
  `GOOGLE_CONNECTOR_REDIRECT_URI` (`{PUBLIC_API_URL}/v1/connectors/oauth/callback`).
- Add that redirect URI in Google Cloud Console for the OAuth client.
- Desktop stores connector refresh tokens in `{app_data}/connectors/credentials.json`
  (mode `0600`) — never in `nela_cloud_tokens.json`.
