# dsh-speech-whisper-local

Local Spanish (and 30+ language) dictation for **DeepSeek Harness**, powered by **whisper.cpp** on the GPU with the **Whisper large-v3** model, plus a CPU fallback.

It exists to replace the bundled provider (SenseVoiceSmall), which does not support Spanish: in tests with real audio it classified Spanish as English and returned unusable text.

English | [Español](README.es.md)

## What it does

- **Working Dictate button in Spanish** with Whisper large-v3 (~0.1–0.5 s per dictation on GPU).
- **Automatic backend**: uses the **CUDA** build when installed, otherwise the **CPU** build (whisper.cpp runs on any Windows x64 machine).
- **Releases VRAM**: stops the server after 10 minutes without dictation and restarts it on the next one (~2–3 s).
- **Optional ONNX/CPU fallback** (only registered when its model files are present).
- **Diagnostics log** at `%USERPROFILE%\.dsh\speech-to-text\whisper-provider.log`.

## Requirements

| Item | Value |
|---|---|
| OS | Windows x64 |
| DeepSeek Harness | with the experimental voice-input bundle enabled |
| GPU (optional) | NVIDIA with a CUDA 12+ driver and ~1.3 GB VRAM (small) / ~2.3 GB (medium) / ~4.5 GB (large-v3) |
| Disk | ~1.2 GB (CUDA build) or ~0.3 GB (CPU build) + model: 0.5 / 1.5 / 3.1 GB |
| Node | 20+ (for the setup script only) |

Without an NVIDIA GPU it still works through the CPU build, just slower.

## Install

### 1. Clone the repository

```powershell
git clone https://github.com/apppoweria/dsh-speech-whisper-local.git
cd dsh-speech-whisper-local
```

### 2. Download binaries and model (once)

```powershell
node scripts/setup.mjs
```

Options:

```powershell
node scripts/setup.mjs --model=medium            # less VRAM / disk
node scripts/setup.mjs --model=small             # minimum
node scripts/setup.mjs --backend=cpu             # no NVIDIA GPU
node scripts/setup.mjs --backend=both            # CUDA + CPU
```

The setup verifies the SHA-256 of every file against `scripts/assets.json`, extracts the build into
`%USERPROFILE%\.dsh\speech-to-text\whisper-cpp\{cuda|cpu}` and the model into `...\whisper-cpp\models\`.
Re-running it is safe: installed backends and verified models are skipped.

### 3. Install the plugin in DSH

1. **Plugins → Add plugin**.
2. Paste this folder path (for example `C:\Users\<user>\Projects\dsh-speech-whisper-local`) → **Install** → **Enable now**.
3. In the bundle card, turn on the **`speech-to-text-whisper`** row switch (Components). Without it the plugin does not mount.
4. **Settings → Voice recognition**: pick `Whisper (GPU, cuda)` and language `es`.

The first dictation takes ~2–3 s (server start + model load). Afterwards: 0.1–0.5 s.

### Install from the plugin market (Discover)

Add this index source in **Plugins → Discover → Add index source**:

```
https://raw.githubusercontent.com/apppoweria/dsh-speech-whisper-local/main/market/index.json
```

## Configuration

Edit the row in your DSH profile patch (`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`):

```yaml
- id: speech-to-text-whisper
  config:
    gpuModel: models/ggml-medium.bin   # if you installed another model
    gpuIdleTimeoutMs: 300000           # 5 min; 0 = never stop the server
    gpuThreads: 4                      # whisper.cpp server CPU threads
```

| Field | Default | Description |
|---|---|---|
| `gpuBackend` | `auto` | `auto` uses `cuda` when present, otherwise `cpu` |
| `gpuModel` | `models/ggml-large-v3.bin` | ggml model to load |
| `gpuIdleTimeoutMs` | `600000` | inactivity before releasing VRAM (`0` disables) |
| `gpuThreads` | `4` | whisper.cpp server threads |
| `gpuLoadTimeoutMs` | `120000` | maximum wait while loading the model |

## Models

| Model | Disk | VRAM (approx.) | Spanish quality |
|---|---|---|---|
| `large-v3` | 3.1 GB | ~4.5 GB | best (recommended) |
| `medium` | 1.5 GB | ~2.3 GB | good |
| `small` | 0.5 GB | ~1.3 GB | acceptable |

## Troubleshooting

- **Dictate returns Chinese or garbage** → the bundled SenseVoice provider is still active: the plugin is not selected or its row is off. Check Plugins → `speech-to-text-whisper` row in **Running**.
- **"Speech recognition is not ready"** → the configured provider is not registered. Check that the profile language (`es`) is valid for the active provider.
- **CUDA backend does not start** (old driver, no NVIDIA) → `node scripts/setup.mjs --backend=cpu` and set `gpuBackend: cpu`.
- **Running out of VRAM** → use a smaller model and/or lower `gpuIdleTimeoutMs`.
- **Diagnostics** → `%USERPROFILE%\.dsh\speech-to-text\whisper-provider.log` records mount, backend, startup and errors.

## License

MIT. Bundled third-party components keep their own licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
