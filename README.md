<div align="center">

<img src="genhat-desktop/public/logo-dark.png" alt="NELA" width="110"/>

# NELA

### Your private AI workspace — local-first, with optional Cloud.

[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-6366f1?style=flat-square)](#)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8D8?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-stable-CE422B?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![License](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)

NELA is a **local-first** AI desktop application. In **Private** mode, models and your document library run on your hardware. Sign in for optional **NELA Cloud** (Fast / Smart / Deep) when you want hosted quality tiers.  
Chat with your documents, analyse images, generate speech, produce podcasts, build mindmaps, create artifacts, and wire together custom AI pipelines.

</div>

---

## What is NELA?

NELA is a full desktop application built with **Tauri** (a Rust-powered native shell) and a **React** frontend. It is local-first by default:

- **Private** — selectable models run via a built-in inference runtime; library indexing stays on this device.
- **NELA Cloud** (optional) — signed-in routing to hosted Fast / Smart / Deep tiers over the internet. Smart/Deep typically use plan credits.
- **Auto** — prefer Cloud when entitled; otherwise local, with a clear notice.

NELA organises your work into **project workspaces** that can be exported and imported as `.nela` archives, so your chats, documents, podcasts, and mindmaps travel with you like any other file.

> Internet is used for model downloads, optional web search, and NELA Cloud when enabled. Private inference does not require Cloud.

Cloud API wiring for developers: see [`genhat-desktop/CLOUD.md`](genhat-desktop/CLOUD.md).

---

## Features

<table>
<tr>
<td width="50%" valign="top">

### Chat + Document Grounding

Conversational AI powered by local LLMs you install, or NELA Cloud when signed in. Add files or folders to build a **retrieval-augmented knowledge base** — indexed on this device, with citations in answers.

Supports PDF, DOCX, PPTX, Markdown, plain text, code files, CSV, JSON, YAML, HTML, and audio transcripts (MP3, WAV, M4A, and more).

</td>
<td width="50%" valign="top">

### Vision Mode

Drop an image into the conversation and ask anything about it. Private mode uses an on-device VLM; Cloud can use hosted multimodal models when enabled.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Audio Mode

Two-way voice interaction in a single mode.

- **Speech-to-text** — dictate prompts with your microphone; a local ASR model transcribes in real time.
- **Text-to-speech** — listen to responses with your choice of local TTS voice and speed.

</td>
<td width="50%" valign="top">

### Podcast Studio

Turn a knowledge base into a listenable conversation. Give two speaker names, a topic, and let NELA script a multi-turn dialogue from your documents. It then synthesises every line into audio and stitches the segments into a single combined episode track.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Mindmaps

Generate visual concept trees from either your ingested documents or a model's own knowledge. Great for studying, planning, and brainstorming. All maps are saved per-workspace and reopen instantly from the sidebar.

</td>
<td width="50%" valign="top">

### Artifacts & Pipeline Playground

Generate presentations, spreadsheets, HTML, and Word documents from chat. Cloud often helps with richer decks; Private works with local models.  
The **Pipeline Playground** is a node-based editor for custom AI flows (LLM, Transcribe, TTS, RAG, File Read, Script, Condition, Transform, and more).

</td>
</tr>
</table>

---

## Model Management

NELA ships with a full in-app model manager for **Private** (local) models.

- **Browse and install** models from Hugging Face directly from the Settings panel.
- **Compatibility scoring** estimates RAM usage, CPU performance, and disk requirements *before* you download.
- **Runtime parameter controls** — context size, max tokens, temperature, top-p, top-k, repeat penalty, and backend-specific flags — are adjustable per-session.
- Map **Fast / Smart / Deep** to local models; Cloud uses hosted tiers instead of downloading a GGUF when you switch.

Supported local model classes:

| Class | Purpose |
|---|---|
| LLM | Text generation and conversation |
| VLM | Multimodal vision + language |
| ASR | Speech-to-text transcription |
| TTS | Text-to-speech synthesis |
| Embedding | Semantic indexing for RAG |
| Grader / Reranker | Chunk relevance scoring |
| Classifier / Router | Intent routing |

---

## Workspaces

Everything in NELA is scoped to a **workspace** — a named project that holds:

- Chat sessions and message history
- Ingested document knowledge base
- Generated podcasts and audio episodes
- Saved mindmaps
- Model preferences and runtime parameters

Workspaces export and import as `.nela` archives, making sharing and backup as simple as copying a file.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri v2](https://tauri.app) (Rust) |
| Frontend | [React 19](https://react.dev) + TypeScript + [Vite](https://vitejs.dev) |
| Styling | [Tailwind CSS v4](https://tailwindcss.com) |
| Pipeline canvas | [@xyflow/react](https://reactflow.dev) |
| Inference runtime | llama.cpp-compatible GGUF backend (Rust) |
| Cloud (optional) | NELA Cloud API → hosted model tiers |
| Vector search | In-process IVF vector index (Rust) |
| ASR | ONNX-based local transcription |
| TTS | Custom on-device synthesis pipeline |

---

## Run from Source

**Prerequisites:** Node.js 24+, npm, Rust stable toolchain.

Linux also needs a few system libraries:

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libasound2-dev pkg-config
```

**Start in dev mode:**

```sh
cd genhat-desktop
npm ci
npx tauri dev
```

The app launches with a startup modal where you create or import a workspace. From there, open **Settings** to download local models, and optionally sign in for NELA Cloud.

**Build a distributable package:**

```sh
# Linux .deb
npx tauri build --bundles deb

# macOS .dmg
npx tauri build --bundles dmg

# Windows installer
npx tauri build --bundles msi,nsis
```

---

## First Run Checklist

1. Create a workspace from the startup screen.
2. Go to **Settings → Models** and install the models you want for Private mode (start with a mid-size LLM like a 7B or 8B Q4 for chat).
3. For RAG, also install an **embedding model** and optionally a **grader model**.
4. Use the top bar to stay on **Private** or switch to **Cloud** after signing in.
5. Pick a mode from the input bar and start exploring.
6. Use **Help → Tours** for a guided in-app walkthrough if you want one.

---

## Repository Layout

```
nela/
├── genhat-desktop/     # Main desktop app (Tauri + React)
│   ├── src/            # Frontend — components, hooks, app logic
│   ├── CLOUD.md        # Cloud API / entitlement integration notes
│   └── src-tauri/src/  # Rust backend — inference, RAG, TTS, ASR, commands
├── benchmark/          # Runtime benchmark suite and plotting tools
├── models/             # Local model storage (gitignored)
└── The-Bare/           # Standalone experiments and prototypes
```

---

<div align="center">

*NELA — local-first intelligence, Cloud when you choose.*

</div>
