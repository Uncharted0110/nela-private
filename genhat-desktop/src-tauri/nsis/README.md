# NSIS FileIndexer install integration

Install-time folder setup and embedding-model download for local FileIndexer.

## What the installer does

1. After the install-directory page, shows:
   - **Default** — all fixed drives
   - **Custom** — browse/add/remove folders
   - **Confirm** — list folders, then continue
   - **Model download** — Yes/No prompt for the MiniLM ONNX zip (~90 MB)
2. On finish (`NSIS_HOOK_POSTINSTALL`), writes:
   - `%APPDATA%\com.genhat.dev\fileindexer\roots.txt`
   - `%APPDATA%\com.genhat.dev\fileindexer\mode.txt`
   - `%APPDATA%\com.genhat.dev\fileindexer\model_path.txt` → `$INSTDIR\models\fileindexer`
3. If the user chose **Yes**, downloads and extracts the model zip into:
   - `$INSTDIR\models\fileindexer\models--Qdrant--all-MiniLM-L6-v2-onnx\`
4. If the user chose **No** (or download/extract fails), install still finishes. FileIndexer shows an **exclamation** badge until the model is present.
5. Bundles:
   - `fileindexer_sidecar.exe` next to the app (via `tauri.windows.conf.json`)
   - **Does not** ship the MiniLM weights inside the NSIS payload (download keeps the installer small)

First app launch reads those files, materializes `config.json`, and auto-starts the sidecar when the model is present.

## Model zip layout

Zip **one** of these shapes (installer flattens one extra wrapper folder if needed):

```text
models--Qdrant--all-MiniLM-L6-v2-onnx/
  snapshots/<hash>/model.onnx
  …
```

or:

```text
some-wrapper/
  models--Qdrant--all-MiniLM-L6-v2-onnx/
    snapshots/<hash>/model.onnx
```

## Download URL

Configured in [`installer.nsi`](installer.nsi):

```nsis
!define FILEINDEXER_MODEL_DRIVE_ID "1YwMBKe7do-tfEULZCWWicg2NEJAnOTou"
; optional direct zip override:
; !define FILEINDEXER_MODEL_ZIP_URL "https://example.com/fileindexer-minilm.zip"
```

Download flow (POSTINSTALL):

1. Downloads  
   `https://drive.usercontent.google.com/download?id=<DRIVE_ID>&export=download&confirm=t`  
   via **PowerShell** (Drive returns **403** to NSISdl). If `FILEINDEXER_MODEL_ZIP_URL` is set, tries **NSISdl** first, then PowerShell.
2. Verifies ZIP magic (`PK`).
3. **PowerShell `Expand-Archive`** unpacks into `$INSTDIR\models\fileindexer`.

Share the Drive file as **Anyone with the link**. Plain `https://drive.google.com/uc?export=download&id=…&confirm=t` often still returns HTML for large files — use the **usercontent** host above.

## Badge states (app UI)
| Icon | Phase |
|------|--------|
| Tick | `ready` / `sleeping` |
| Cross | `error` |
| Exclamation | `model_missing` |
| Spinner | `embedding` / `loading_model` / starting |
| Search | `scanning` |

## Files

| Path | Role |
|------|------|
| `nsis/installer.nsi` | Custom Tauri NSIS template (FileIndexer pages + URL define) |
| `nsis/preinstall.nsh` | Page functions + PRE/POSTINSTALL hooks + zip download |
| `resources/fileindexer_sidecar.exe` | Sidecar binary staged for bundling |

## Before building the installer

```powershell
cd C:\Users\assas\CODEBASES\nela-private\genhat-desktop

# Set FILEINDEXER_MODEL_ZIP_URL in nsis/installer.nsi to your zip URL

npm run prepare:sidecars:release
npx tauri build
```

FileIndexer lives in-repo at `src-tauri/crates/file-indexer` (workspace member).

```bash
npm run prepare:sidecars          # debug
npm run prepare:sidecars:release  # release
```

Installer output: `src-tauri/target/release/bundle/nsis/`.

## Note on the template

`nsis/installer.nsi` is forked from Tauri’s default template. When upgrading `@tauri-apps/cli`, re-diff against upstream `installer.nsi` and keep the “5b. FileIndexer” page block (including the model download page).
