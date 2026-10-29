// Bundles src/extension.ts (and everything it pulls in, including @aws-sdk/*/@smithy/*) into a
// single dist/extension.js. Only `vscode` is left external (it's supplied by the Extension Host,
// not npm). This is purely a packaging/activation optimization: without it, `require("./out/
// extension.js")` transitively resolves and compiles ~1000+ individual CommonJS files across the
// AWS SDK's dependency tree on every Extension Host activation, since `tsc` alone emits one file
// per source module and never combines them. Bundling does not change any runtime logic - it
// only changes how the same code is packaged and loaded.
//
// out/ (from `tsc -p ./`) is unaffected and still built separately: the test suite loads
// individual compiled files from there (see .vscode-test.mjs), which a single bundled file can't
// support.
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
	const context = await esbuild.context({
		entryPoints: ["src/extension.ts"],
		bundle: true,
		format: "cjs",
		platform: "node",
		// Matches the "node": ">=20.0.0" floor in package.json#engines.
		target: "node20",
		outfile: "dist/extension.js",
		external: ["vscode"],
		sourcemap: true,
		minify: production,
		logLevel: "info"
	});

	if (watch) {
		await context.watch();
	} else {
		await context.rebuild();
		await context.dispose();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
