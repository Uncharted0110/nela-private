# Linux install — FileIndexer parity with Windows NSIS

Windows uses a custom NSIS wizard ([`../nsis/README.md`](../nsis/README.md)). Linux `.deb` / AppImage builds cannot run the same multi-page GUI during `dpkg -i`, so NELA mirrors the **same choices on first launch** in release Linux builds.

## What happens on Linux

### During package install (`.deb` `postinst`)

The maintainer script [`deb/postinst.sh`](deb/postinst.sh) creates the same empty model directory tree as the NSIS `PREINSTALL` hook under `/usr/lib/NELA/models/` (LLM, grader, TTS, **fileindexer**, etc.).

Bundled weights still ship for other model classes via `tauri.linux.conf.json`. The FileIndexer MiniLM ONNX zip stays **out of the package** (~90 MB), matching Windows.

### On first app launch (release Linux only)

If `{app_data}/fileindexer/mode.txt` is missing, NELA shows a four-step setup wizard:

1. **Default vs Custom** — default indexes `$HOME` and mounted volumes (`/media`, `/mnt`, `/run/media`, `/home/*`, `/`).
2. **Custom folders** — add/remove paths with the in-app folder picker.
3. **Confirm** — review the folder list.
4. **Model download** — Yes/No for the all-MiniLM-L6-v2 ONNX zip.

On finish, the app writes the same files as NSIS `POSTINSTALL`:

| File | Purpose |
|------|---------|
| `{app_data}/fileindexer/mode.txt` | `default` or `custom` |
| `{app_data}/fileindexer/roots.txt` | One folder per line |
| `{app_data}/fileindexer/model_path.txt` | Writable models dir (`~/.local/share/com.genhat.dev/models/fileindexer` after seeding) |

Optional download uses the same Google Drive / `FILEINDEXER_MODEL_ZIP_URL` source as [`../nsis/installer.nsi`](../nsis/installer.nsi).

### Sidecar binary

`npm run prepare:sidecars:release` builds `fileindexer_sidecar` and stages it as a Tauri `externalBin` (`bin/fileindexer_sidecar-<triple>`), bundled next to the app like `fileindexer_sidecar.exe` on Windows.

## Build

```bash
cd genhat-desktop
npm run prepare:sidecars:release
npx tauri build --bundles deb
# or AppImage:
npx tauri build --bundles appimage
```

Output: `src-tauri/target/release/bundle/deb/` (and/or `appimage/`).

## Override model zip URL

Set before build or at runtime:

```bash
export FILEINDEXER_MODEL_ZIP_URL="https://example.com/fileindexer-minilm.zip"
```

## Windows vs Linux summary

| Step | Windows NSIS | Linux |
|------|--------------|-------|
| Model dir scaffolding | `PREINSTALL` hook | `postinst.sh` + first-run seed to app data |
| Folder mode / custom / confirm | Installer pages | First-run wizard |
| Model download Yes/No | Installer page + PowerShell | First-run wizard + Rust download |
| Config files | `%APPDATA%\com.genhat.dev\fileindexer\` | `~/.local/share/com.genhat.dev/fileindexer/` |
| Sidecar | `fileindexer_sidecar.exe` | `fileindexer_sidecar-<triple>` |

If setup was skipped or download failed, FileIndexer shows a **model missing** badge until the model is present under `models/fileindexer/`.
