import { defineConfig, devices } from '@playwright/test';

const isCi = Boolean(process.env.CI);

export default defineConfig({
	testDir: './e2e',
	timeout: 30_000,
	use: {
		baseURL: 'http://127.0.0.1:5173',
		trace: isCi ? 'retain-on-failure' : 'on-first-retry'
	},
	webServer: {
		command: 'pnpm dev --host 127.0.0.1',
		url: 'http://127.0.0.1:5173',
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
