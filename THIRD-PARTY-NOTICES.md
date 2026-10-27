# Third-party notices

`dsh-speech-whisper-local` redistributes or downloads the components below. Their licenses
apply to those components; the plugin's own code is MIT (see LICENSE).

## Redistributed in this repository (`lib/vendor/`)

| Component | Version | License | Notes |
|---|---|---|---|
| sherpa-onnx (Node wrapper `sherpa-onnx-node`) | 1.13.8 | Apache-2.0 | `lib/vendor/sherpa-onnx-node/` — JS wrapper only |
| sherpa-onnx native runtime (`sherpa-onnx-win-x64`) | 1.13.8 | Apache-2.0 | `lib/vendor/sherpa-onnx-win-x64/` — DLLs and Node addon |
| ONNX Runtime | bundled with sherpa-onnx | MIT | `onnxruntime.dll` / `onnxruntime_providers_shared.dll` |
| @deepseek-ai/schemastery | 3.18.5 | MIT | vendored ESM build (`lib/vendor/schemastery/`) |
| @deepseek-ai/cosmokit | 1.8.2 | MIT | vendored ESM build (`lib/vendor/cosmokit/`) |
| DeepSeek Harness speech-to-text contract types | — | MIT | API shapes implemented from `@deepseek-ai/dsh-experimental-speech-to-text` |

## Downloaded at setup time (not in this repository)

| Component | Source | License |
|---|---|---|
| whisper.cpp Windows builds (CUDA 12.4 x64 / CPU x64) | github.com/ggml-org/whisper.cpp releases | MIT |
| ggml CUDA backend and cuBLAS redistributables inside that build | NVIDIA / ggml | see the release archive |
| Whisper ggml models (`ggml-large-v3.bin`, `ggml-medium.bin`, `ggml-small.bin`) | huggingface.co/ggerganov/whisper.cpp | Whisper weights: MIT (OpenAI) |
| Whisper model architecture | OpenAI Whisper | MIT |

## Notes

- Filenames, URLs, sizes and SHA-256 digests are pinned in `scripts/assets.json`; `scripts/setup.mjs`
  refuses any file that does not match.
- No third-party component here grants trademark rights; "Whisper", "NVIDIA", "CUDA" and "DeepSeek"
  are used descriptively.
