# NSIS FileIndexer install integration

Install-time folder setup for local FileIndexer lives in the Windows NSIS installer.

## What the installer does

1. After the install-directory page, shows:
   - **Default** — all fixed drives
   - **Custom** — browse/add/remove folders
   - **Confirm** — list folders, then continue
2. On finish (`NSIS_HOOK_POSTINSTALL`), writes:
   - `%APPDATA%\com.genhat.dev\fileindexer\roots.txt`
   - `%APPDATA%\com.genhat.dev\fileindexer\mode.txt`
3. Bundles:
   - `models/fileindexer/models--Qdrant--all-MiniLM-L6-v2-onnx/` (embedding model)
   - `fileindexer_sidecar.exe` next to the app

First app launch reads those files, materializes `config.json`, and auto-starts the sidecar.

## Files

| Path | Role |
|------|------|
| `nsis/installer.nsi` | Custom Tauri NSIS template (adds FileIndexer pages) |
| `nsis/preinstall.nsh` | Page functions + PRE/POSTINSTALL hooks |
| `resources/models/fileindexer/` | Model payload staged for bundling |
| `resources/fileindexer_sidecar.exe` | Sidecar binary staged for bundling |

## Before building the installer

```powershell
# 1) Build sidecar
cd C:\Users\assas\CODEBASES\FileIndexer
cargo build --release --bin fileindexer_sidecar
Copy-Item .\target\release\fileindexer_sidecar.exe `
  C:\Users\assas\CODEBASES\nela-private\genhat-desktop\src-tauri\resources\fileindexer_sidecar.exe -Force

# 2) Ensure model is under resources (junction or copy)
#    src-tauri\resources\models\fileindexer\models--Qdrant--all-MiniLM-L6-v2-onnx\

# 3) Bundle
cd C:\Users\assas\CODEBASES\nela-private\genhat-desktop
npx tauri build
```

Installer output: `src-tauri/target/release/bundle/nsis/`.

## Note on the template

`nsis/installer.nsi` is forked from Tauri’s default template. When upgrading `@tauri-apps/cli`, re-diff against upstream `installer.nsi` and keep the “5b. FileIndexer” page block.
