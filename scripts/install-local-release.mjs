#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ARTIFACT_MANIFEST = "pi-local-release.json";
const INSTALL_MANIFEST = "PI-LOCAL-RELEASE.json";
const LEGACY_INSTALL_MANIFEST = "PI-FLEET-INSTALL.json";
const LOCK_DIRECTORY = ".pi-local-release.lock";
const SOURCE_COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function printUsage() {
	console.log(`Usage:
  node scripts/install-local-release.mjs --release <dir> --runtime-root <dir> --base-runtime <dir> [--artifact-root <dir>]
  node scripts/install-local-release.mjs --prune --runtime-root <dir> [--artifact-root <dir>]

Installs a completed npm run release:local artifact into an isolated Node
runtime, atomically activates it through <runtime-root>/current, and removes
managed runtime variants that are neither active nor referenced by a process.
When --artifact-root is supplied, consumed managed release artifacts are also
removed unless a process still references them. --prune runs only the cleanup.`);
}

function parseArgs(args) {
	const options = {
		artifactRoot: undefined,
		baseRuntime: undefined,
		prune: false,
		release: undefined,
		runtimeRoot: undefined,
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help") {
			printUsage();
			return undefined;
		}
		if (arg === "--prune") {
			options.prune = true;
			continue;
		}
		const key = {
			"--artifact-root": "artifactRoot",
			"--base-runtime": "baseRuntime",
			"--release": "release",
			"--runtime-root": "runtimeRoot",
		}[arg];
		if (!key) throw new Error(`Unknown option: ${arg}`);
		const value = args[++index];
		if (!value) throw new Error(`${arg} requires a directory`);
		options[key] = resolve(value);
	}
	if (!options.runtimeRoot) throw new Error("--runtime-root is required");
	if (!options.prune && (!options.release || !options.baseRuntime)) {
		throw new Error("--release and --base-runtime are required for installation");
	}
	return options;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function validatedArtifactManifest(releaseDirectory) {
	const manifestPath = join(releaseDirectory, ARTIFACT_MANIFEST);
	if (!existsSync(manifestPath)) throw new Error(`Release is missing ${ARTIFACT_MANIFEST}: ${releaseDirectory}`);
	const manifest = readJson(manifestPath);
	if (
		manifest?.schemaVersion !== 1 ||
		manifest?.kind !== "pi-local-release" ||
		!SOURCE_COMMIT_RE.test(manifest.sourceCommit) ||
		!(["clean", "dirty"].includes(manifest.sourceState)) ||
		typeof manifest.tarballs !== "object" ||
		manifest.tarballs === null ||
		Array.isArray(manifest.tarballs)
	) {
		throw new Error(`Invalid ${ARTIFACT_MANIFEST}: ${manifestPath}`);
	}
	for (const [filename, digest] of Object.entries(manifest.tarballs)) {
		if (basename(filename) !== filename || !SHA256_RE.test(digest)) {
			throw new Error(`Invalid tarball entry in ${manifestPath}: ${filename}`);
		}
		const tarball = join(releaseDirectory, "tarballs", filename);
		if (!existsSync(tarball) || sha256(tarball) !== digest) {
			throw new Error(`Release tarball does not match its manifest: ${tarball}`);
		}
	}
	return manifest;
}

function codingAgentTarball(releaseDirectory, manifest) {
	const matches = Object.entries(manifest.tarballs).filter(([filename]) =>
		filename.startsWith("earendil-works-pi-coding-agent-"),
	);
	if (matches.length !== 1) throw new Error("Release must contain exactly one pi-coding-agent tarball");
	return { path: join(releaseDirectory, "tarballs", matches[0][0]), sha256: matches[0][1] };
}

function readProcessLink(path) {
	try {
		const target = readlinkSync(path).replace(/ \(deleted\)$/, "");
		return isAbsolute(target) ? resolve(target) : resolve(dirname(path), target);
	} catch {
		return undefined;
	}
}

export function referencedDirectories(directories, procRoot = "/proc") {
	const candidates = directories.map((directory) => resolve(directory));
	const referenced = new Set();
	let processEntries = [];
	try {
		processEntries = readdirSync(procRoot, { withFileTypes: true }).filter(
			(entry) => entry.isDirectory() && /^\d+$/.test(entry.name),
		);
	} catch {
		return referenced;
	}

	for (const entry of processEntries) {
		const processDirectory = join(procRoot, entry.name);
		const references = [
			readProcessLink(join(processDirectory, "exe")),
			readProcessLink(join(processDirectory, "cwd")),
		];
		try {
			for (const fd of readdirSync(join(processDirectory, "fd"))) {
				references.push(readProcessLink(join(processDirectory, "fd", fd)));
			}
		} catch {
			// Processes may exit or deny inspection while /proc is scanned.
		}
		for (const reference of references) {
			if (!reference) continue;
			for (const candidate of candidates) {
				if (isInsidePath(reference, candidate)) referenced.add(candidate);
			}
		}
	}
	return referenced;
}

function isManagedRuntime(directory) {
	for (const filename of [INSTALL_MANIFEST, LEGACY_INSTALL_MANIFEST]) {
		const path = join(directory, filename);
		if (!existsSync(path)) continue;
		try {
			const manifest = readJson(path);
			const schemaVersion = manifest.schemaVersion ?? manifest.schema_version;
			const sourceCommit = manifest.sourceCommit ?? manifest.source_commit;
			return schemaVersion === 1 && SOURCE_COMMIT_RE.test(sourceCommit);
		} catch {
			return false;
		}
	}
	return false;
}

function managedArtifactDirectories(artifactRoot) {
	if (!artifactRoot || !existsSync(artifactRoot)) return [];
	return readdirSync(artifactRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(artifactRoot, entry.name))
		.filter((directory) => {
			try {
				const manifest = readJson(join(directory, ARTIFACT_MANIFEST));
				return manifest?.schemaVersion === 1 && manifest?.kind === "pi-local-release";
			} catch {
				return false;
			}
		});
}

function removeIfStillUnused(directory, procRoot) {
	const retiredPrefix = join(dirname(directory), `.${basename(directory)}.retiring-${process.pid}`);
	let retired = retiredPrefix;
	let collision = 0;
	while (existsSync(retired)) retired = `${retiredPrefix}-${++collision}`;
	renameSync(directory, retired);
	if (referencedDirectories([retired], procRoot).has(resolve(retired))) {
		renameSync(retired, directory);
		return false;
	}
	rmSync(retired, { force: true, recursive: true });
	return true;
}

export function pruneManagedRuntimes(runtimeRoot, procRoot = "/proc") {
	const root = resolve(runtimeRoot);
	const currentPath = join(root, "current");
	const active = existsSync(currentPath) ? realpathSync(currentPath) : undefined;
	const candidates = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== LOCK_DIRECTORY)
		.map((entry) => join(root, entry.name))
		.filter(isManagedRuntime);
	const live = referencedDirectories(candidates, procRoot);
	const removed = [];
	const retained = [];
	for (const candidate of candidates) {
		const resolvedCandidate = resolve(candidate);
		if (resolvedCandidate === active || live.has(resolvedCandidate)) {
			retained.push(candidate);
			continue;
		}
		if (removeIfStillUnused(candidate, procRoot)) removed.push(candidate);
		else retained.push(candidate);
	}
	return { removed, retained };
}

export function pruneManagedArtifacts(artifactRoot, procRoot = "/proc") {
	const candidates = managedArtifactDirectories(resolve(artifactRoot));
	const live = referencedDirectories(candidates, procRoot);
	const removed = [];
	const retained = [];
	for (const candidate of candidates) {
		if (live.has(resolve(candidate))) {
			retained.push(candidate);
			continue;
		}
		if (removeIfStillUnused(candidate, procRoot)) removed.push(candidate);
		else retained.push(candidate);
	}
	return { removed, retained };
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env ?? process.env,
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
	}
	return result.stdout ?? "";
}

function copyTree(source, destination) {
	run("cp", ["-a", "--reflink=auto", `${source}/.`, destination]);
}

function acquireLock(runtimeRoot) {
	const lockDirectory = join(runtimeRoot, LOCK_DIRECTORY);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			mkdirSync(lockDirectory);
			writeFileSync(join(lockDirectory, "pid"), `${process.pid}\n`);
			return () => rmSync(lockDirectory, { force: true, recursive: true });
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			let owner;
			try {
				owner = Number(readFileSync(join(lockDirectory, "pid"), "utf8").trim());
			} catch {
				owner = undefined;
			}
			if (owner && owner !== process.pid) {
				try {
					process.kill(owner, 0);
					throw new Error(`Another local Pi release operation is running as PID ${owner}`);
				} catch (ownerError) {
					if (ownerError?.code !== "ESRCH") throw ownerError;
				}
			}
			rmSync(lockDirectory, { force: true, recursive: true });
		}
	}
	throw new Error(`Could not acquire local Pi release lock: ${lockDirectory}`);
}

function candidateName(baseRuntime, manifest, tarballDigest) {
	const suffix = manifest.sourceState === "clean" ? manifest.sourceCommit.slice(0, 9) : `${manifest.sourceCommit.slice(0, 9)}-dirty-${tarballDigest.slice(0, 9)}`;
	return `${basename(baseRuntime)}-pi-${suffix}`;
}

function validateRuntimeBoundary(runtimeRoot, runtime) {
	const root = realpathSync(runtimeRoot);
	const target = realpathSync(runtime);
	if (dirname(target) !== root) throw new Error(`Runtime must be a direct child of ${root}: ${target}`);
	return target;
}

function activate(runtimeRoot, candidate) {
	const temporaryLink = join(runtimeRoot, `.current-${process.pid}`);
	rmSync(temporaryLink, { force: true });
	symlinkSync(basename(candidate), temporaryLink);
	renameSync(temporaryLink, join(runtimeRoot, "current"));
}

function smokeCandidate(candidate) {
	const packageRoot = join(candidate, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
	const packageJson = readJson(join(packageRoot, "package.json"));
	const cli = realpathSync(join(candidate, "bin", "pi"));
	const environment = { ...process.env, PI_OFFLINE: "1", PI_OTEL_DISABLED: "1" };
	const version = run(join(candidate, "bin", "node"), [cli, "--version"], { capture: true, env: environment }).trim();
	if (version !== packageJson.version) {
		throw new Error(`Installed Pi reported ${version || "no version"}; expected ${packageJson.version}`);
	}
	run(join(candidate, "bin", "node"), [cli, "--help"], { capture: true, env: environment });
}

export function pruneLocalReleases(options) {
	if (process.platform !== "linux") throw new Error("Local release cleanup currently requires Linux /proc semantics");
	const runtimeRoot = realpathSync(options.runtimeRoot);
	const releaseLock = acquireLock(runtimeRoot);
	try {
		return {
			runtimes: pruneManagedRuntimes(runtimeRoot, options.procRoot),
			artifacts: options.artifactRoot
				? pruneManagedArtifacts(options.artifactRoot, options.procRoot)
				: { removed: [], retained: [] },
		};
	} finally {
		releaseLock();
	}
}

export function installLocalRelease(options) {
	if (process.platform !== "linux") throw new Error("Local runtime installation currently requires Linux /proc semantics");
	const runtimeRoot = realpathSync(options.runtimeRoot);
	const releaseLock = acquireLock(runtimeRoot);
	let stage;
	try {
		const releaseDirectory = realpathSync(options.release);
		const baseRuntime = validateRuntimeBoundary(runtimeRoot, options.baseRuntime);
		const current = validateRuntimeBoundary(runtimeRoot, join(runtimeRoot, "current"));
		if (isManagedRuntime(baseRuntime)) {
			throw new Error(`Base runtime must not be a managed release variant: ${baseRuntime}`);
		}
		const manifest = validatedArtifactManifest(releaseDirectory);
		const tarball = codingAgentTarball(releaseDirectory, manifest);
		const releaseNodeModules = join(releaseDirectory, "node", "node_modules");
		if (!existsSync(releaseNodeModules)) throw new Error(`Release has no isolated Node install: ${releaseNodeModules}`);
		const candidate = join(runtimeRoot, candidateName(baseRuntime, manifest, tarball.sha256));

		if (!existsSync(candidate)) {
			stage = mkdtempSync(join(runtimeRoot, ".pi-release."));
			copyTree(baseRuntime, stage);
			const globalModules = join(stage, "lib", "node_modules");
			for (const entry of readdirSync(globalModules)) {
				if (entry !== "npm" && entry !== "corepack") rmSync(join(globalModules, entry), { force: true, recursive: true });
			}
			copyTree(releaseNodeModules, globalModules);
			const piExecutable = join(stage, "bin", "pi");
			rmSync(piExecutable, { force: true });
			symlinkSync("../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", piExecutable);
			writeFileSync(
				join(stage, INSTALL_MANIFEST),
				`${JSON.stringify(
					{
						schemaVersion: 1,
						kind: "pi-local-runtime",
						installedAt: new Date().toISOString(),
						sourceCommit: manifest.sourceCommit,
						sourceState: manifest.sourceState,
						artifactTarballSha256: tarball.sha256,
						baseRuntime,
						previousRuntime: current,
					},
					undefined,
					"\t",
				)}\n`,
			);
			smokeCandidate(stage);
			renameSync(stage, candidate);
			stage = undefined;
		} else {
			const installed = readJson(join(candidate, INSTALL_MANIFEST));
			if (
				installed?.kind !== "pi-local-runtime" ||
				installed?.sourceCommit !== manifest.sourceCommit ||
				installed?.artifactTarballSha256 !== tarball.sha256
			) {
				throw new Error(`Runtime candidate already exists with different contents: ${candidate}`);
			}
			smokeCandidate(candidate);
		}

		activate(runtimeRoot, candidate);
		const runtimes = pruneManagedRuntimes(runtimeRoot, options.procRoot);
		const artifacts = options.artifactRoot
			? pruneManagedArtifacts(options.artifactRoot, options.procRoot)
			: { removed: [], retained: [] };
		return { active: candidate, previous: current, runtimes, artifacts };
	} finally {
		if (stage) rmSync(stage, { force: true, recursive: true });
		releaseLock();
	}
}

function printCleanup(result) {
	for (const path of result.runtimes.removed) console.log(`Removed inactive Pi runtime: ${path}`);
	for (const path of result.runtimes.retained) console.log(`Retained active or live Pi runtime: ${path}`);
	for (const path of result.artifacts.removed) console.log(`Removed consumed local release artifact: ${path}`);
	for (const path of result.artifacts.retained) console.log(`Retained live local release artifact: ${path}`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!options) return;
	if (options.prune) {
		printCleanup(pruneLocalReleases(options));
		return;
	}
	const result = installLocalRelease(options);
	console.log(`Activated local Pi runtime: ${result.active}`);
	printCleanup(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
