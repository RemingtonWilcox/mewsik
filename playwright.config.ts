import { defineConfig, devices } from '@playwright/test';

const isCi = Boolean(process.env.CI);
// E2E_PORT runs the suite beside another project's dev server on 5173.
const port = Number(process.env.E2E_PORT ?? 5173);

export default defineConfig({
	testDir: './e2e',
	timeout: 30_000,
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: isCi ? 'retain-on-failure' : 'on-first-retry'
	},
	webServer: {
		command: `pnpm dev --host 127.0.0.1 --port ${port} --strictPort`,
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: !isCi,
		// The first cold SSR compile of the app now takes over a minute on a
		// busy machine; a 60 s limit failed before the server ever answered.
		timeout: 180_000
	},
	projects: [
		{
			name: 'warmup',
			testMatch: /cold-start\.setup\.ts/,
			use: { ...devices['Desktop Chrome'] }
		},
		{
			name: 'chromium',
			testIgnore: /cold-start\.setup\.ts/,
			dependencies: ['warmup'],
			use: { ...devices['Desktop Chrome'] }
		}
	]
});
