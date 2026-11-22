import { defineConfig } from "@vscode/test-cli";

export default defineConfig([
	{
		label: "unitTests",
		files: "out/test/suite/**/*.test.js",
		mocha: {
			ui: "bdd",
			color: true,
			timeout: 20000
		}
	},
	{
		// Runs in its own Extension Host process so real activation (which registers all
		// contributed commands for real) can't collide with commandRegistration.test.ts's
		// intentionally-never-disposed fake-context command registrations in "unitTests".
		label: "activation",
		files: "out/test/activation/**/*.test.js",
		mocha: {
			ui: "bdd",
			color: true,
			timeout: 20000
		}
	}
]);
