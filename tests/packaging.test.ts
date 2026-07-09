import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// These tests pin the published-package contract: pi-lens ships a precompiled
// dist/ and points its entry at compiled JS, so pi does NOT jiti-transpile ~200
// TypeScript files on every startup (issue #182). A regression here silently
// reintroduces the ~3.5s cold-start cost, so guard it statically.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as {
	main?: string;
	files?: string[];
	scripts?: Record<string, string>;
	pi?: { extensions?: string[]; skills?: string[] };
};

describe("published package entry points (dist mode, #182)", () => {
	it("main points at the compiled dist entry", () => {
		expect(pkg.main).toBe("./dist/index.js");
	});

	it("every pi.extensions entry is a compiled dist .js file", () => {
		const exts = pkg.pi?.extensions ?? [];
		expect(exts.length).toBeGreaterThan(0);
		for (const e of exts) {
			expect(e, e).toMatch(/^\.\/dist\/.+\.js$/);
		}
	});

	it("ships dist/ and never TypeScript source in the npm tarball", () => {
		const files = pkg.files ?? [];
		expect(files).toContain("dist/");
		for (const f of files) {
			// A .ts entry (or a clients/commands/tools source glob) would put pi
			// back on the jiti transpile-on-startup path.
			expect(f.endsWith(".ts"), `files must not ship TS source: ${f}`).toBe(
				false,
			);
		}
	});

	it("prepare builds dist on install (incl. git) and before publish", () => {
		// `prepare` (not `prepack`) is required so a `git:` install — which runs
		// `npm install`, not `npm pack` — also gets the compiled dist (#182).
		expect(pkg.scripts?.prepare ?? "").toContain("build:dist");
		expect(pkg.scripts?.["build:dist"] ?? "").toContain("tsconfig.dist.json");
	});

	it("pi.skills resolves (from the dist entry FILE) back to the real root skills/", () => {
		// pi resolves each `pi.skills` entry relative to the extension entry's
		// **file path** (`dist/index.js`), via `path.resolve(entryFile, skill)` —
		// NOT relative to the entry's directory. So a leading `../` only cancels
		// `index.js` and stays inside `dist/`; reaching the real root `skills/`
		// from `dist/index.js` needs to climb TWO levels: `../../skills`. Getting
		// this wrong (`../skills` → `dist/skills`, missing) silently stops skills
		// from loading and emits pi's "skill path does not exist" warning — and the
		// tarball `skills/` check below does NOT catch it (the dir ships fine; pi
		// just resolves to the wrong place). Verified against pi's resolver. #199.
		expect(pkg.pi?.skills ?? []).toContain("../../skills");
		expect(pkg.scripts?.["build:dist"] ?? "").not.toContain("dist/skills");
		expect(pkg.files ?? []).toContain("skills/");

		// Static guard replicating pi's resolution: joining each pi.skills entry to
		// the extension entry FILE must land on the package's own root skills/ dir.
		const entry = pkg.pi?.extensions?.[0];
		expect(entry, "pi.extensions[0] must exist").toBeTruthy();
		const entryFile = path.resolve(root, entry as string);
		const rootSkills = path.resolve(root, "skills");
		for (const skill of pkg.pi?.skills ?? []) {
			expect(
				path.resolve(entryFile, skill),
				`pi.skills "${skill}" must resolve (entry-file-relative) to the root skills/ dir`,
			).toBe(rootSkills);
		}
	});

	it("bundles core grammars via prepare and ships them in the tarball", () => {
		// Core grammars are downloaded at `prepare` time into grammars/ (shipped in
		// files[]); the tail lazy-fetches at runtime. There is intentionally NO
		// postinstall (it was npm-only and pnpm/bun blocked it) — see the grammar
		// distribution note in AGENTS.md.
		expect(pkg.scripts?.prepare ?? "").toContain("download-grammars");
		expect(pkg.files ?? []).toContain("grammars/");
		expect(pkg.files ?? []).toContain("scripts/download-grammars.js");
		expect(
			pkg.scripts?.postinstall,
			"postinstall was removed — grammars ship bundled + lazy-fetch",
		).toBeUndefined();
	});

	it("wires the bundle step into build:dist after tsc (#335)", () => {
		const bd = pkg.scripts?.["build:dist"] ?? "";
		// tsc must run before the bundle (bundle collapses the tsc emit).
		expect(bd).toContain("bundle:dist");
		expect(bd.indexOf("tsconfig.dist.json")).toBeLessThan(
			bd.indexOf("bundle:dist"),
		);
		expect(pkg.scripts?.["bundle:dist"] ?? "").toContain("bundle-dist.mjs");
	});
});

// Guards the #335 bundle CONTRACT against the built entry: pi's Bun-compiled
// host cannot resolve a bare specifier from the extension's node_modules, so the
// bundle must inline the pure-JS deps and keep only host-provided + native/wasm
// packages external. dist/ is gitignored, so this only runs post-build (CI runs
// build:dist before the suite); a source-only checkout skips it.
describe("bundled dist entry shape (#335)", () => {
	const distEntry = path.join(root, "dist", "index.js");
	const built = fs.existsSync(distEntry);
	const src = built ? fs.readFileSync(distEntry, "utf8") : "";

	it.runIf(built)("inlines the pure-JS deps (no bare import at load)", () => {
		for (const dep of ["minimatch", "js-yaml", "vscode-jsonrpc"]) {
			const bareImport = src.includes(`from "${dep}"`);
			const bareRequire =
				src.includes(`require("${dep}")`) || src.includes(`require('${dep}')`);
			expect(
				bareImport || bareRequire,
				`${dep} must be inlined, not bare-imported`,
			).toBe(false);
		}
	});

	it.runIf(built)("keeps host-provided packages external", () => {
		for (const dep of ["typebox", "@earendil-works/pi-tui"]) {
			expect(
				src.includes(`from "${dep}"`),
				`${dep} must stay an external import`,
			).toBe(true);
		}
	});

	it.runIf(built)(
		"resolves native/wasm via file:// URL, not a bare specifier",
		() => {
			// A raw absolute path is not a valid Windows import specifier; both lazy
			// accessors must convert the createRequire-resolved path via
			// pathToFileURL before dynamic-importing. web-tree-sitter's exports map
			// has only the `.` entry, so the bare package name is resolved (never a
			// custom subpath). esbuild suffixes the require var (_require2 etc.), so
			// match the .resolve(<pkg>) call shape rather than the exact var name.
			expect(src).toMatch(/\.resolve\("@ast-grep\/napi"\)/);
			expect(src).toMatch(/\.resolve\("web-tree-sitter"\)/);
			expect(src).not.toContain('.resolve("web-tree-sitter/tree-sitter');
			expect(src).toContain("pathToFileURL");
		},
	);
});

describe("tsconfig.dist.json", () => {
	const dist = JSON.parse(
		fs.readFileSync(path.join(root, "tsconfig.dist.json"), "utf8"),
	) as {
		compilerOptions?: { outDir?: string; types?: string[] };
		exclude?: string[];
	};

	it("emits to ./dist", () => {
		expect(dist.compilerOptions?.outDir).toBe("./dist");
	});

	it("excludes tests from the published build", () => {
		const ex = dist.exclude ?? [];
		expect(ex.some((e) => e.includes("test"))).toBe(true);
	});

	it("does not require @types/node during production install-time dist builds", () => {
		// pi installs git extensions with `npm install --omit=dev`, then npm runs
		// `prepare`. In that environment dev-only @types/node is absent, so the
		// dist config must not inherit the base config's `types: ["node"]` entry.
		expect(dist.compilerOptions?.types).toEqual([]);
	});
});
