import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { installLocalRelease, pruneManagedArtifacts, pruneManagedRuntimes } from "./install-local-release.mjs";

const SOURCE_COMMIT = "a".repeat(40);

function temporaryDirectory(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-local-release-test-"));
	t.after(() => rmSync(directory, { force: true, recursive: true }));
	return directory;
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function createLegacyRuntime(root, name) {
	const directory = join(root, name);
	mkdirSync(join(directory, "bin"), { recursive: true });
	writeJson(join(directory, "PI-FLEET-INSTALL.json"), {
		schema_version: 1,
		source_commit: SOURCE_COMMIT,
	});
	return directory;
}

function createProcReference(procRoot, pid, field, target) {
	const processDirectory = join(procRoot, String(pid));
	mkdirSync(join(processDirectory, "fd"), { recursive: true });
	symlinkSync(target, join(processDirectory, field));
}

test("prunes only inactive managed runtimes", (t) => {
	const root = temporaryDirectory(t);
	const procRoot = join(root, "proc");
	const runtimeRoot = join(root, "runtimes");
	mkdirSync(procRoot);
	mkdirSync(runtimeRoot);
	const active = createLegacyRuntime(runtimeRoot, "active");
	const live = createLegacyRuntime(runtimeRoot, "live");
	const stale = createLegacyRuntime(runtimeRoot, "stale");
	const base = join(runtimeRoot, "base");
	mkdirSync(base);
	symlinkSync(basename(active), join(runtimeRoot, "current"));
	createProcReference(procRoot, 42, "exe", join(live, "bin", "node"));

	const result = pruneManagedRuntimes(runtimeRoot, procRoot);

	assert.deepEqual(result.removed, [stale]);
	assert.deepEqual(new Set(result.retained), new Set([active, live]));
	assert.ok(existsSync(active));
	assert.ok(existsSync(live));
	assert.ok(existsSync(base));
	assert.ok(!existsSync(stale));
});

test("prunes only unreferenced manifest-owned artifacts", (t) => {
	const root = temporaryDirectory(t);
	const procRoot = join(root, "proc");
	const artifactRoot = join(root, "artifacts");
	mkdirSync(procRoot);
	mkdirSync(artifactRoot);
	const live = join(artifactRoot, "live");
	const stale = join(artifactRoot, "stale");
	const unmanaged = join(artifactRoot, "unmanaged");
	for (const directory of [live, stale]) {
		mkdirSync(directory);
		writeJson(join(directory, "pi-local-release.json"), { schemaVersion: 1, kind: "pi-local-release" });
	}
	mkdirSync(unmanaged);
	createProcReference(procRoot, 43, "cwd", live);

	const result = pruneManagedArtifacts(artifactRoot, procRoot);

	assert.deepEqual(result, { removed: [stale], retained: [live] });
	assert.ok(existsSync(live));
	assert.ok(existsSync(unmanaged));
	assert.ok(!existsSync(stale));
});

test("installs, activates, and reconciles a local release", (t) => {
	const root = temporaryDirectory(t);
	const procRoot = join(root, "proc");
	const runtimeRoot = join(root, "runtimes");
	const artifactRoot = join(root, "artifacts");
	const release = join(artifactRoot, "release");
	const base = join(runtimeRoot, "node-v-test");
	mkdirSync(procRoot);
	mkdirSync(join(base, "bin"), { recursive: true });
	mkdirSync(join(base, "lib", "node_modules", "npm"), { recursive: true });
	mkdirSync(join(base, "lib", "node_modules", "corepack"), { recursive: true });
	symlinkSync(process.execPath, join(base, "bin", "node"));
	writeFileSync(join(base, "base-marker"), "base\n");
	symlinkSync(basename(base), join(runtimeRoot, "current"));
	const stale = createLegacyRuntime(runtimeRoot, "stale");

	const packageRoot = join(release, "node", "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(join(packageRoot, "dist", "bundle"), { recursive: true });
	mkdirSync(join(release, "tarballs"), { recursive: true });
	writeJson(join(packageRoot, "package.json"), { name: "@earendil-works/pi-coding-agent", version: "1.2.3" });
	writeFileSync(
		join(packageRoot, "dist", "bundle", "cli.js"),
		'if (process.argv.includes("--version")) console.log("1.2.3");\n',
	);
	const tarballName = "earendil-works-pi-coding-agent-1.2.3.tgz";
	const tarball = join(release, "tarballs", tarballName);
	writeFileSync(tarball, "test tarball\n");
	const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
	writeJson(join(release, "pi-local-release.json"), {
		schemaVersion: 1,
		kind: "pi-local-release",
		createdAt: "2026-09-01T00:00:00.000Z",
		sourceCommit: SOURCE_COMMIT,
		sourceState: "clean",
		tarballs: { [tarballName]: digest },
	});

	const first = installLocalRelease({ baseRuntime: base, procRoot, release, runtimeRoot });
	const result = installLocalRelease({ artifactRoot, baseRuntime: base, procRoot, release, runtimeRoot });

	assert.equal(result.active, join(runtimeRoot, `node-v-test-pi-${SOURCE_COMMIT.slice(0, 9)}`));
	assert.equal(first.previous, base);
	assert.equal(first.runtimes.removed.includes(stale), true);
	assert.equal(existsSync(stale), false);
	assert.equal(existsSync(release), false);
	assert.equal(existsSync(base), true);
	assert.equal(readFileSync(join(base, "base-marker"), "utf8"), "base\n");
	assert.equal(readFileSync(join(runtimeRoot, "current", "PI-LOCAL-RELEASE.json"), "utf8").includes(SOURCE_COMMIT), true);
});
