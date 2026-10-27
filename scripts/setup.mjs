#!/usr/bin/env node
/**
 * One-time setup for dsh-speech-whisper-local.
 *
 * Downloads the whisper.cpp Windows build (CUDA and/or CPU) and the Whisper ggml model
 * into the DSH home, verifying every file against the pinned SHA-256 in assets.json.
 *
 * Usage:
 *   node scripts/setup.mjs [--model=large-v3|medium|small] [--backend=auto|cuda|cpu|both] [--root=<dir>]
 *
 * Defaults: --model=large-v3 --backend=auto (CUDA + CPU when an NVIDIA GPU is present, otherwise CPU).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const assets = JSON.parse(readFileSync(new URL('./assets.json', import.meta.url), 'utf8'));

function arg(name, fallback) {
	const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
}

const modelKey = arg('model', 'large-v3');
const backendArg = arg('backend', 'auto');
const root = arg('root', join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'speech-to-text', 'whisper-cpp'));

if (process.platform !== 'win32') {
	console.error('This build of dsh-speech-whisper-local supports Windows x64 only.');
	process.exit(1);
}
if (!assets.models[modelKey]) {
	console.error(`Unknown model "${modelKey}". Available: ${Object.keys(assets.models).join(', ')}`);
	process.exit(1);
}

function hasNvidia() {
	const probe = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8' });
	return probe.status === 0 && String(probe.stdout).trim().length > 0;
}

function backends() {
	if (backendArg === 'both') return ['cuda', 'cpu'];
	if (backendArg === 'cuda' || backendArg === 'cpu') return [backendArg];
	return hasNvidia() ? ['cuda', 'cpu'] : ['cpu'];
}

async function sha256File(target) {
	const hash = createHash('sha256');
	await pipeline(createReadStream(target), hash);
	return hash.digest('hex');
}

function format(bytes) {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function download(url, dest, expected, label) {
	if (existsSync(dest) && statSync(dest).size === expected.size) {
		const digest = await sha256File(dest);
		if (digest === expected.sha256) {
			console.log(`  ${label}: already downloaded`);
			return;
		}
	}
	console.log(`  ${label}: downloading ${format(expected.size)} ...`);
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok || !response.body) throw new Error(`${label}: HTTP ${response.status}`);
	const part = `${dest}.part`;
	const hash = createHash('sha256');
	let received = 0;
	let lastReported = 0;
	const sink = createWriteStream(part);
	const source = Readable.fromWeb(response.body);
	await pipeline(
		source,
		async function* (chunks) {
			for await (const chunk of chunks) {
				hash.update(chunk);
				received += chunk.length;
				if (received - lastReported > expected.size / 20) {
					lastReported = received;
					process.stdout.write(`\r    ${label}: ${Math.floor((received / expected.size) * 100)}% (${format(received)})   `);
				}
				yield chunk;
			}
		},
		sink
	);
	process.stdout.write('\r');
	renameSync(part, dest);
	const digest = hash.digest('hex');
	if (received !== expected.size || digest !== expected.sha256) {
		rmSync(dest, { force: true });
		throw new Error(`${label}: integrity check failed (got ${received} bytes / ${digest})`);
	}
	console.log(`  ${label}: verified`);
}

function extract(zip, dest) {
	mkdirSync(dest, { recursive: true });
	const staging = `${dest}.__staging`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	const tar = spawnSync('tar', ['-xf', zip, '-C', staging], { encoding: 'utf8' });
	if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr || tar.stdout}`);
	const inner = existsSync(join(staging, 'Release')) ? join(staging, 'Release') : staging;
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(dest, { recursive: true });
	const move = spawnSync('cmd', ['/c', 'move', '/Y', join(inner, '*'), dest], { encoding: 'utf8' });
	if (move.status !== 0) throw new Error(`move failed: ${move.stderr || move.stdout}`);
	rmSync(staging, { recursive: true, force: true });
}

const downloads = join(root, '.downloads');
mkdirSync(downloads, { recursive: true });
mkdirSync(join(root, 'models'), { recursive: true });

console.log(`dsh-speech-whisper-local setup`);
console.log(`  install root: ${root}`);
console.log(`  model: ${modelKey} (${format(assets.models[modelKey].size)}, ~${assets.models[modelKey].vramMb} MB VRAM)`);

for (const backend of backends()) {
	const spec = assets.binaries[backend];
	const markerPath = join(root, backend, '.installed.json');
	if (existsSync(markerPath) && existsSync(join(root, backend, 'whisper-server.exe'))) {
		const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
		if (marker.sha256 === spec.sha256) {
			console.log(`\n[${backend}] ${spec.name}: already installed`);
			continue;
		}
	}
	console.log(`\n[${backend}] ${spec.name}`);
	const zip = join(downloads, `${backend}.zip`);
	await download(spec.url, zip, spec, spec.name);
	extract(zip, join(root, backend));
	writeFileSync(join(root, backend, '.installed.json'), JSON.stringify({ sha256: spec.sha256, release: assets.release }, null, 2));
	rmSync(zip, { force: true });
	console.log(`  [${backend}]: installed to ${join(root, backend)}`);
}

const model = assets.models[modelKey];
console.log(`\n[model] ${model.file}`);
const modelPath = join(root, 'models', model.file);
await download(model.url, modelPath, model, model.file);
console.log(`  [model]: installed to ${modelPath}`);

writeFileSync(
	join(root, 'install.json'),
	JSON.stringify({ installedAt: new Date().toISOString(), model: modelKey, backends: backends(), release: assets.release }, null, 2)
);

console.log(`\nDone.`);
console.log(`Next steps:`);
console.log(`  1. DeepSeek Harness > Plugins > Add plugin > this folder path`);
console.log(`  2. Enable the plugin, then enable its row (Components > speech-to-text-whisper)`);
console.log(`  3. Settings > Voice recognition should list "Whisper (GPU, ${backends()[0]})"`);
if (modelKey !== 'large-v3') {
	console.log(`  Note: the plugin defaults to models/ggml-large-v3.bin. To use ${model.file},`);
	console.log(`  add "gpuModel: models/${model.file}" to the row config in the profile's cordis.patch.yml.`);
}
