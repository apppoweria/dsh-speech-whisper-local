/**
 * Local Whisper speech-to-text for DeepSeek Harness.
 *
 * Registers up to three host-local recognizers:
 *  - `<providerId>`    sherpa-onnx ONNX Whisper on the CPU (optional, registered only when its model files exist).
 *  - `<gpuProviderId>` whisper.cpp server (ggml model) kept resident, reached over loopback HTTP.
 *                      Uses the `cuda` build when present, otherwise the `cpu` build (see scripts/setup.mjs).
 *                      Falls back to the CPU recognizer if the server cannot run.
 *
 * The composer's Dictate button uses the provider and language selected in Settings.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import z from './vendor/schemastery/index.mjs';

const name = 'experimental-speech-to-text-whisper';

const inject = ['speechToText'];

/** Language hints offered in the composer settings; `auto` asks the model to detect it. */
const languages = [
	'auto',
	'es',
	'en',
	'pt',
	'fr',
	'de',
	'it',
	'nl',
	'pl',
	'ru',
	'uk',
	'tr',
	'ar',
	'hi',
	'vi',
	'id',
	'ca',
	'sv',
	'fi',
	'cs',
	'da',
	'nb',
	'hu',
	'ro',
	'sk',
	'bg',
	'hr',
	'et',
	'ja',
	'ko',
	'zh'
];

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');

const Config = z.object({
	providerId: z.string().min(1).default('whisper-local'),
	modelDirectory: z.string().min(1).default(join(dshHome, 'speech-to-text', 'whisper-small')),
	encoder: z.string().min(1).default('small-encoder.int8.onnx'),
	decoder: z.string().min(1).default('small-decoder.int8.onnx'),
	tokens: z.string().min(1).default('small-tokens.txt'),
	threads: z.natural().min(1).max(64).default(8),
	gpuProviderId: z.string().min(1).default('whisper-gpu'),
	gpuRoot: z.string().min(1).default(join(dshHome, 'speech-to-text', 'whisper-cpp')),
	gpuBackend: z.union(['auto', 'cuda', 'cpu']).default('auto'),
	gpuBinary: z.string().min(1).default('whisper-server.exe'),
	gpuModel: z.string().min(1).default('models/ggml-large-v3.bin'),
	gpuThreads: z.natural().min(1).max(32).default(4),
	gpuLoadTimeoutMs: z.natural().min(1000).default(120000),
	gpuRequestTimeoutMs: z.natural().min(1000).default(120000),
	gpuIdleTimeoutMs: z.natural().min(0).default(600000)
});

/** Append-only diagnostics for the provider lifecycle; never throws into the Host. */
const diagPath = join(dshHome, 'speech-to-text', 'whisper-provider.log');
function diag(message) {
	try {
		appendFileSync(diagPath, `${new Date().toISOString()} ${message}\n`);
	} catch {}
}

/** Read a canonical 16 kHz mono PCM16 WAV recording into normalized samples. */
function readSamples(audio) {
	const bytes = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
	const count = Math.floor((bytes.length - 44) / 2);
	const samples = new Float32Array(count);
	for (let index = 0; index < count; index += 1) samples[index] = bytes.readInt16LE(44 + index * 2) / 32768;
	return samples;
}

/** Reserve a loopback port the GPU server can bind. */
function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const port = probe.address().port;
			probe.close(() => resolve(port));
		});
	});
}

/** Resolve once something accepts TCP connections on the loopback port. */
function waitForPort(port, timeoutMs, signal) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const attempt = () => {
			if (signal?.aborted) return reject(new Error('aborted'));
			if (Date.now() > deadline) return reject(new Error(`whisper-server did not start within ${timeoutMs} ms`));
			const socket = connect({ host: '127.0.0.1', port });
			socket.once('connect', () => {
				socket.destroy();
				resolve();
			});
			socket.once('error', () => {
				socket.destroy();
				setTimeout(attempt, 250);
			});
		};
		attempt();
	});
}

/** Build a minimal multipart/form-data body for the inference endpoint. */
function multipart(boundary, file, fields) {
	const parts = [];
	for (const [field, value] of Object.entries(fields)) {
		parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${value}\r\n`));
	}
	parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
	parts.push(file);
	parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
	return Buffer.concat(parts);
}

/** POST one recording to a resident whisper-server and return its transcript. */
function postInference(port, body, boundary, timeoutMs) {
	return new Promise((resolve, reject) => {
		const call = request(
			{
				host: '127.0.0.1',
				port,
				path: '/inference',
				method: 'POST',
				headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
			},
			(response) => {
				const chunks = [];
				response.on('data', (chunk) => chunks.push(chunk));
				response.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					if (response.statusCode !== 200) return reject(new Error(`whisper-server HTTP ${response.statusCode}: ${text.slice(0, 200)}`));
					try {
						resolve(JSON.parse(text));
					} catch {
						reject(new Error(`whisper-server returned malformed JSON: ${text.slice(0, 200)}`));
					}
				});
			}
		);
		call.setTimeout(timeoutMs, () => call.destroy(new Error('whisper-server request timed out')));
		call.once('error', reject);
		call.end(body);
	});
}

/**
 * Register the GPU whisper.cpp recognizer and, when its files exist, the CPU ONNX recognizer.
 * @param ctx - Host context carrying the speechToText service.
 * @param config - validated provider configuration.
 */
function apply(ctx, config) {
	if (!isAbsolute(config.modelDirectory)) throw new Error(`Whisper model directory must be absolute: ${config.modelDirectory}`);
	if (!isAbsolute(config.gpuRoot)) throw new Error(`Whisper GPU root must be absolute: ${config.gpuRoot}`);

	// --- CPU recognizer (sherpa-onnx ONNX), optional ---
	const require = createRequire(import.meta.url);
	const encoderPath = join(config.modelDirectory, config.encoder);
	const decoderPath = join(config.modelDirectory, config.decoder);
	const tokensPath = join(config.modelDirectory, config.tokens);
	const hasOnnx = existsSync(encoderPath) && existsSync(decoderPath) && existsSync(tokensPath);

	let sherpa;
	let recognizer;
	let loadedLanguage;
	const nativeConfig = (language) => ({
		featConfig: { sampleRate: 16000, featureDim: 80 },
		modelConfig: {
			whisper: {
				encoder: encoderPath,
				decoder: decoderPath,
				language: language === 'auto' ? '' : language,
				task: 'transcribe',
				tailPaddings: -1
			},
			tokens: tokensPath,
			numThreads: config.threads,
			provider: 'cpu',
			debug: 0
		}
	});
	const recognizerFor = (language) => {
		if (sherpa === undefined) sherpa = require('./vendor/sherpa-onnx-node/sherpa-onnx.js');
		if (recognizer === undefined) {
			recognizer = new sherpa.OfflineRecognizer(nativeConfig(language));
			loadedLanguage = language;
		} else if (loadedLanguage !== language) {
			recognizer.setConfig(nativeConfig(language));
			loadedLanguage = language;
		}
		return recognizer;
	};
	const transcribeCpu = async (audio, language) => {
		const samples = readSamples(audio);
		const started = performance.now();
		const stream = recognizerFor(language).createStream();
		stream.acceptWaveform({ sampleRate: 16000, samples });
		recognizerFor(language).decode(stream);
		const result = recognizerFor(language).getResult(stream);
		return {
			text: String(result.text ?? '').trim(),
			audioSeconds: samples.length / 16000,
			inferenceSeconds: (performance.now() - started) / 1000
		};
	};

	// --- GPU recognizer (resident whisper.cpp server over loopback) ---
	const backend =
		config.gpuBackend === 'auto'
			? existsSync(join(config.gpuRoot, 'cuda', config.gpuBinary))
				? 'cuda'
				: 'cpu'
			: config.gpuBackend;
	const binaryPath = join(config.gpuRoot, backend, config.gpuBinary);
	const modelPath = join(config.gpuRoot, config.gpuModel);
	const missing = !existsSync(binaryPath) ? binaryPath : !existsSync(modelPath) ? modelPath : undefined;
	if (missing !== undefined) diag(`setup missing: ${missing} (run scripts/setup.mjs)`);

	const gpu = {
		child: undefined,
		port: 0,
		starting: undefined,
		queue: Promise.resolve(),
		log: '',
		idleTimer: undefined,

		/** Release the GPU process after a quiet period so it does not hold VRAM while idle. */
		scheduleIdle() {
			if (this.idleTimer !== undefined) {
				clearTimeout(this.idleTimer);
				this.idleTimer = undefined;
			}
			if (!config.gpuIdleTimeoutMs) return;
			this.idleTimer = setTimeout(() => {
				this.idleTimer = undefined;
				diag('idle timeout: stopping server');
				this.stop();
			}, config.gpuIdleTimeoutMs);
			this.idleTimer.unref?.();
		},

		start() {
			if (this.starting !== undefined) return this.starting;
			this.starting = (async () => {
				if (missing !== undefined) throw new Error(`Whisper GPU files are missing: ${missing}. Run "node scripts/setup.mjs" once.`);
				const port = await freePort();
				diag(`start: spawn backend=${backend} ${binaryPath} model=${modelPath} port=${port}`);
				const child = spawn(binaryPath, ['-m', modelPath, '-l', 'auto', '--host', '127.0.0.1', '--port', String(port), '-t', String(config.gpuThreads)], {
					cwd: dirname(binaryPath),
					windowsHide: true,
					stdio: ['ignore', 'pipe', 'pipe']
				});
				const remember = (chunk) => {
					this.log = (this.log + chunk.toString('utf8')).slice(-8192);
				};
				child.stdout?.on('data', remember);
				child.stderr?.on('data', remember);
				child.once('error', (error) => diag(`spawn error: ${error.code} ${error.message}`));
				child.once('exit', (code, signal) => {
					diag(`server exited code=${code} signal=${signal} tail=${JSON.stringify(this.log.slice(-600))}`);
					if (this.child === child) {
						this.child = undefined;
						this.port = 0;
						this.starting = undefined;
					}
					if (code !== 0 && code !== null) ctx.logger?.('warn', `whisper-server exited with code ${code}`);
				});
				this.child = child;
				await waitForPort(port, config.gpuLoadTimeoutMs);
				diag(`ready port=${port}`);
				this.port = port;
				this.scheduleIdle();
				ctx.logger?.('info', `whisper-server ready on 127.0.0.1:${port}`);
			})().catch((error) => {
				diag(`start failed: ${error.message}`);
				this.starting = undefined;
				this.child?.kill();
				this.child = undefined;
				throw error;
			});
			return this.starting;
		},

		async transcribe(audio, language) {
			const run = async () => {
				this.scheduleIdle();
				await this.start();
				const fields = { response_format: 'json', temperature: '0.0' };
				if (language !== 'auto') fields.language = language;
				const boundary = `----dsh${randomUUID().replaceAll('-', '')}`;
				const body = multipart(boundary, Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength), fields);
				const started = performance.now();
				const result = await postInference(this.port, body, boundary, config.gpuRequestTimeoutMs);
				const seconds = (audio.byteLength - 44) / 32000;
				this.scheduleIdle();
				return {
					text: String(result.text ?? '').trim(),
					audioSeconds: seconds,
					inferenceSeconds: (performance.now() - started) / 1000
				};
			};
			const pending = this.queue.then(run, run);
			this.queue = pending.catch(() => {});
			return pending;
		},

		stop() {
			if (this.idleTimer !== undefined) {
				clearTimeout(this.idleTimer);
				this.idleTimer = undefined;
			}
			this.child?.kill();
			this.child = undefined;
			this.port = 0;
			this.starting = undefined;
		}
	};

	const transcribeGpu = async (audio, language) => {
		try {
			return await gpu.transcribe(audio, language);
		} catch (error) {
			diag(`gpu fallback: ${error.message}`);
			if (!hasOnnx) throw error;
			ctx.logger?.('warn', `Whisper GPU unavailable, falling back to CPU ONNX: ${error.message}`);
			return await transcribeCpu(audio, language);
		}
	};

	ctx.effect(() => {
		const registrations = [];
		if (hasOnnx) {
			registrations.push(
				ctx.speechToText.register({
					info: { id: config.providerId, name: 'Whisper Small (local, CPU)', location: 'host-local', languages },
					transcribe: async (input, signal) => {
						signal?.throwIfAborted?.();
						const result = await transcribeCpu(input.audio, input.language);
						signal?.throwIfAborted?.();
						return result;
					}
				})
			);
		}
		registrations.push(
			ctx.speechToText.register({
				info: { id: config.gpuProviderId, name: `Whisper (GPU, ${backend})`, location: 'host-local', languages },
				transcribe: async (input, signal) => {
					signal?.throwIfAborted?.();
					const result = await transcribeGpu(input.audio, input.language);
					signal?.throwIfAborted?.();
					return result;
				}
			})
		);
		return async () => {
			gpu.stop();
			for (const unregister of registrations) await unregister();
		};
	});
}

export { Config, apply, inject, languages, name };
