import { expect, test } from '@playwright/test';

// Signal's WGSL Params struct and its TypeScript packing helper must never
// drift apart, and with layout: 'auto' every declared binding has to be used
// or Chrome rejects the bind group (a silent black screen). This spec checks
// both on every Signal shader module.
test.describe('Signal uniform contract', () => {
	test('WGSL Params layout matches packing, and every binding is referenced', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const layout = await import('/src/lib/visualizer/signal/uniform-layout.ts');
			const shaders = await import('/src/lib/visualizer/signal/shaders.ts');

			const parseParams = (source: string) => {
				const match = source.match(/struct Params \{([\s\S]*?)\};/);
				if (!match) return null;
				const fields: Array<{ group: string; slots: string[] }> = [];
				const fieldPattern = /\/\/\s*([a-zA-Z]+(?:,\s*[a-zA-Z]+){3})\s*\n\s*(\w+): vec4<f32>/g;
				let field: RegExpExecArray | null;
				while ((field = fieldPattern.exec(match[1])) !== null) {
					fields.push({
						group: field[2],
						slots: field[1].split(',').map((slot) => slot.trim())
					});
				}
				return fields;
			};

			const unusedBindings = (source: string) => {
				const names = [...source.matchAll(/@binding\(\d+\)\s+var(?:<[^>]+>)?\s+(\w+)\s*:/g)].map(
					(match) => match[1]
				);
				return names.filter((name) => source.split(name).length - 1 < 2);
			};

			const modules = {
				scene: shaders.SIGNAL_SCENE_WGSL,
				feedback: shaders.SIGNAL_FEEDBACK_WGSL,
				bloomDown: shaders.SIGNAL_BLOOM_DOWN_WGSL,
				blurH: shaders.SIGNAL_BLOOM_BLUR_H_WGSL,
				blurV: shaders.SIGNAL_BLOOM_BLUR_V_WGSL,
				composite: shaders.SIGNAL_COMPOSITE_WGSL
			};
			const layoutGroups = layout.SIGNAL_UNIFORM_GROUPS.map(([group, slots]) => ({
				group,
				slots: [...slots]
			}));
			const values = Object.fromEntries(
				layout.SIGNAL_UNIFORM_GROUPS.flatMap(([, slots], groupIndex) =>
					slots.map((slot, slotIndex) => [slot, groupIndex * 4 + slotIndex + 1])
				)
			) as Parameters<typeof layout.packSignalUniforms>[1];
			const packed = layout.packSignalUniforms(
				new Float32Array(layout.SIGNAL_UNIFORM_FLOATS),
				values
			);
			return {
				fields: Object.fromEntries(
					Object.entries(modules).map(([name, source]) => [name, parseParams(source)])
				),
				unused: Object.fromEntries(
					Object.entries(modules).map(([name, source]) => [name, unusedBindings(source)])
				),
				layoutGroups,
				floats: layout.SIGNAL_UNIFORM_FLOATS,
				bytes: layout.SIGNAL_UNIFORM_BYTES,
				packed: Array.from(packed)
			};
		});

		expect(result.floats).toBe(result.layoutGroups.length * 4);
		expect(result.bytes % 16).toBe(0);
		for (const fields of Object.values(result.fields)) {
			expect(fields).toEqual(result.layoutGroups);
		}
		for (const unused of Object.values(result.unused)) {
			expect(unused).toEqual([]);
		}
		expect(result.packed).toEqual(
			Array.from({ length: result.floats }, (_, index) => index + 1)
		);
	});
});
