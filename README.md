# dsh-speech-whisper-local

Dictado local en español (y 30+ idiomas) para **DeepSeek Harness**, usando **whisper.cpp** en GPU con el modelo **Whisper large-v3**, más un fallback a CPU.

Nació para reemplazar el proveedor incluido (SenseVoiceSmall), que no soporta español: en pruebas con audio real clasificaba el español como inglés y devolvía texto inservible.

## Qué hace

- **Botón Dictate funcional en español** con Whisper large-v3 (~0,1–0,5 s por dictado en GPU).
- **Backend automático**: usa la build **CUDA** si está instalada, si no la build **CPU** (whisper.cpp corre en cualquier Windows x64).
- **Libera la VRAM**: apaga el servidor tras 10 minutos sin dictar y lo revive en la siguiente dictación (~2–3 s).
- **Fallback a ONNX/CPU** (opcional, si instalaste también ese modelo).
- **Registro de diagnóstico** en `%USERPROFILE%\.dsh\speech-to-text\whisper-provider.log`.

## Requisitos

| Ítem | Valor |
|---|---|
| Sistema | Windows x64 |
| DeepSeek Harness | con el bundle de voz experimental habilitado |
| GPU (opcional) | NVIDIA con driver CUDA 12+ y ~1,3 GB VRAM (small) / ~2,3 GB (medium) / ~4,5 GB (large-v3) |
| Disco | ~1,2 GB (binarios CUDA) o ~0,3 GB (CPU) + modelo: 0,5 / 1,5 / 3,1 GB |
| Node | 20+ (solo para el setup) |

Sin GPU NVIDIA funciona igual con la build CPU, más lento.

## Instalación

### 1. Clonar / copiar este repo

```powershell
git clone <url-del-repo> C:\Users\<usuario>\Proyectos\dsh-speech-whisper-local
```

### 2. Descargar binarios y modelo (una sola vez)

```powershell
cd C:\Users\<usuario>\Proyectos\dsh-speech-whisper-local
node scripts/setup.mjs
```

Opciones:

```powershell
node scripts/setup.mjs --model=medium            # menos VRAM / disco
node scripts/setup.mjs --model=small             # mínimo
node scripts/setup.mjs --backend=cpu             # sin NVIDIA
node scripts/setup.mjs --backend=both            # CUDA + CPU
```

El setup verifica SHA-256 de cada archivo contra `scripts/assets.json`, extrae la build en
`%USERPROFILE%\.dsh\speech-to-text\whisper-cpp\{cuda|cpu}` y el modelo en `...\whisper-cpp\models\`.

### 3. Instalar el plugin en DSH

1. **Plugins → Add plugin**.
2. Pegá la ruta de esta carpeta (por ejemplo `C:\Users\<usuario>\Proyectos\dsh-speech-whisper-local`) → **Install** → **Enable now**.
3. En la tarjeta del bundle, prendé el switch de la fila **`speech-to-text-whisper`** (Components). Sin eso el plugin no monta.
4. **Settings → Reconocimiento de voz**: elegí `Whisper (GPU, cuda)` y el idioma `es`.

La primera dictación tarda ~2–3 s (arranca el servidor y carga el modelo en GPU). Después: 0,1–0,5 s.

## Configuración

Los valores se ajustan en `cordis.patch.yml` del perfil de DSH (`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`), bajo la fila del plugin:

```yaml
- id: speech-to-text-whisper
  config:
    gpuModel: models/ggml-medium.bin   # si instalaste otro modelo
    gpuIdleTimeoutMs: 300000           # 5 min; 0 = nunca apagar el servidor
    gpuThreads: 4                      # hilos de CPU del servidor
```

| Campo | Default | Descripción |
|---|---|---|
| `gpuBackend` | `auto` | `auto` usa `cuda` si existe, si no `cpu` |
| `gpuModel` | `models/ggml-large-v3.bin` | modelo ggml a cargar |
| `gpuIdleTimeoutMs` | `600000` | inactividad antes de liberar VRAM (`0` desactiva) |
| `gpuThreads` | `4` | hilos del servidor whisper.cpp |
| `gpuLoadTimeoutMs` | `120000` | espera máxima al cargar el modelo |

## Modelos

| Modelo | Disco | VRAM aprox. | Calidad español |
|---|---|---|---|
| `large-v3` | 3,1 GB | ~4,5 GB | la mejor (recomendado) |
| `medium` | 1,5 GB | ~2,3 GB | buena |
| `small` | 0,5 GB | ~1,3 GB | aceptable |

## Solución de problemas

- **Dictate devuelve chino o texto raro** → está usando el SenseVoice incluido: el plugin no está seleccionado o su fila está apagada. Revisá Plugins → fila `speech-to-text-whisper` en **Running**.
- **"Speech recognition is not ready"** → el proveedor configurado no está registrado. Verificá que el idioma del perfil (`es`) sea válido para el proveedor activo.
- **No arranca el backend CUDA** (driver viejo, sin NVIDIA) → `node scripts/setup.mjs --backend=cpu` y poné `gpuBackend: cpu`.
- **Se queda sin VRAM** → usá un modelo menor y/o bajá `gpuIdleTimeoutMs`.
- **Diagnóstico** → `%USERPROFILE%\.dsh\speech-to-text\whisper-provider.log` registra montaje, backend, arranque y errores.

## Licencia

MIT. Incluye componentes de terceros con sus propias licencias; ver [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
