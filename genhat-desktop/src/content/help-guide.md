# NELA Help Guide

Welcome to NELA. This guide explains what each major part of the app does so you can work confidently even if you are new to AI tools.

## 1. Quick Start

1. Create or continue a workspace.
2. Pick a mode (Chat, Vision, Audio, Podcast, Mindmap).
3. Choose **Private** (on-device models) or **Cloud** (NELA Cloud) from the top bar.
4. Choose the intelligence tier (Fast / Smart / Deep / Auto) for that path.
5. Ask your question or run your task.

## 2. Private vs Cloud

NELA is **local-first** with optional **NELA Cloud**.

### Private
- Models and document-library inference run on this device.
- Best when you want offline-capable chat and RAG without sending prompts to the cloud.
- Internet may still be used for **model downloads** or if you turn on **web search**.

### Cloud
- Sign in from Profile / Cloud settings.
- Answers use NELA Cloud quality tiers (**Fast**, **Smart**, **Deep**) over the internet.
- **Smart** and **Deep** need a plan or credits; Cloud Fast may include a free rolling allowance (see Pricing / Cloud settings).
- Prompts you send in Cloud leave this device. Files **attached to a chat** in Cloud are sent to NELA Cloud/OpenRouter for that conversation (you will see a disclosure). Your document **library** is still indexed on this device unless you attach those files to a Cloud chat.

### Auto
- Prefer Cloud when you are signed in and entitled; otherwise use your local Smart model, with a notice when that happens.

## 3. Workspaces

Workspaces keep your chats, documents, generated outputs, and model preferences organized by project.

- Use **New Project** to start fresh.
- Use **Import Project** to open a saved `.nela` file.
- Use **Export Project** to save your current workspace.

## 4. Modes

### Chat
Use for normal text conversations, Q&A, reasoning, summarization, document-grounded responses, and generating presentations, spreadsheets, HTML, or Word files.

### Vision
Use when you want to ask questions about an image.

### Audio
Use text-to-speech and speech-related workflows.

### Podcast
Generate a two-speaker podcast script and audio from your ingested documents.

### Mindmap
Generate visual concept trees from either your documents or model knowledge.

## 5. Models

### On this device (Private)
- **LLM models**: text generation and conversation.
- **Vision models (VLM)**: image + text understanding.
- **TTS/STT models**: speech generation/transcription.

You can install models from Hugging Face and map Fast / Smart / Deep to local models in Settings.

### NELA Cloud
Cloud tiers pick hosted models for you. Switching Fast / Smart / Deep in Cloud does not download a local GGUF.

## 6. Advanced Model Classes (Settings)

Inside **Settings → Advanced Models**, you may see optional classes:

- **Embedding models**: convert text into vectors for semantic search.
- **Grader models**: rerank retrieved chunks so better evidence is used.
- **Classifier / Router models**: classify intent and route tasks to the right model path.
- **Other advanced models**: specialized task models used in specific pipelines.

These are not always required, but they can improve retrieval quality and workflow accuracy.

## 7. Runtime Parameters (What They Mean)

Use the **Model Parameters** panel to tune generation (mainly Private / local).

- **Context Size**: how much prior text the model can remember.
- **Max Output Tokens**: max response length.
- **Temperature**: creativity/randomness.
- **Top P / Top K**: token sampling controls.
- **Repeat Penalty**: reduces repetitive loops.

Tip: Use the small **?** next to each parameter for a plain-language explanation.

## 8. Documents and File Indexer

### Document library
RAG means the model answers using files you added to the library (**Search my documents**).

- Add files/folders in Chat mode to the **document library** (indexed on this device).
- NELA retrieves relevant passages and can cite sources.

### File Indexer
For whole project folders, use the **File Indexer** (**Search my files**). It builds a structured index with keyword + meaning search — one of NELA’s strongest features. See the website docs for a plain-language walkthrough.

- In Cloud mode, use **Attach to this chat** when you want the cloud model to see a file for that turn — that path uploads for the conversation.

## 9. Podcast Studio

To generate a podcast:

1. Ingest documents first.
2. Open Podcast mode.
3. Set speaker names/voices and turns.
4. Enter topic/query.
5. Click **Generate Podcast**.

You can play the full output or individual lines.

## 10. Mindmaps

Mindmaps summarize ideas as a tree structure.

- Great for studying, planning, and brainstorming.
- Reopen saved mindmaps from the sidebar.

## 11. Help Options

- **Tours** (Help Center → Tours): guided spotlight walkthroughs. Start with **Getting Started** for Private vs Cloud, profile sign-in, Fast · Smart · Deep tiers, workspaces, chat, documents, and settings.
- **Help Guide** (this document): quick reference whenever needed.
- **Cloud settings** / Profile: sign-in, plan, and credits.

If you are ever unsure, start with the Getting Started tour, then use this guide as your lookup reference.
