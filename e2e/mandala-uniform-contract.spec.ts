import { expect, test } from '@playwright/test';

// The Mandala WGSL Params struct is generated from the TypeScript contract;
// this spec parses every shader's struct back and checks it matches the
// packing layout exactly, and that every pass binds what it declares.
test.describe('Mandala uniform contract', () => {
	test('every WGSL Params struct matches the TypeScript packing layout', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const layout = await import('/src/lib/visualizer/mandala/uniform-layout.ts');
			const shaders = await import('/src/lib/visualizer/mandala/shaders.ts');

			const parseParams = (source: string) => {
				const match = source.match(/struct Params \{([\s\S]*?)\};/);
				if (!match) return null;
				const fields: Array<{ group: string; slots: string[] }> = [];
				const fieldPattern = /\/\/\s*([a-zA-Z0-9]+(?:,\s*[a-zA-Z0-9]+){3})\s*\n\s*(\w+): vec4<f32>/g;
				let field: RegExpExecArray | null;
				while ((field = fieldPattern.exec(match[1])) !== null) {
					fields.push({ group: field[2], slots: field[1].split(',').map((slot) => slot.trim()) });
				}
				return fields;
			};

			const sources: Record<string, string> = {
				scene: shaders.MANDALA_SCENE_WGSL,
				feedback: shaders.MANDALA_FEEDBACK_WGSL,
				exposure: shaders.MANDALA_EXPOSURE_WGSL,
				bloom: shaders.MANDALA_BLOOM_DOWN_WGSL,
				blurH: shaders.MANDALA_BLUR_H_WGSL,
				blurV: shaders.MANDALA_BLUR_V_WGSL,
				composite: shaders.MANDALA_COMPOSITE_WGSL
			};
			const parsed = Object.fromEntries(
				Object.entries(sources).map(([name, code]) => [name, parseParams(code)])
			);
			const layoutGroups = layout.MANDALA_UNIFORM_GROUPS.map(([group, slots]) => ({
				group,
				slots: [...slots]
			}));
			const values = Object.fromEntries(
				layout.MANDALA_UNIFORM_GROUPS.flatMap(([, slots], groupIndex) =>
					slots.map((slot, slotIndex) => [slot, groupIndex * 4 + slotIndex + 1])
				)
			) as Parameters<typeof layout.packMandalaUniforms>[1];
			const packed = layout.packMandalaUniforms(new Float32Array(layout.MANDALA_UNIFORM_FLOATS), values);
			const slotNames = layout.MANDALA_UNIFORM_GROUPS.flatMap(([, slots]) => [...slots]);

			// layout: 'auto' prunes unreferenced bindings, so every declared one
			// must be used, and a backtick in a WGSL comment would have ended the
			// template literal early (the source would be cut short).
			const bindingsUsed = Object.fromEntries(
				Object.entries(sources).map(([name, code]) => {
					const declared = [...code.matchAll(/@binding\(\d+\) var(?:<[^>]+>)? (\w+)/g)].map((m) => m[1]);
					const body = code.replace(/@binding\(\d+\) var(?:<[^>]+>)? \w+/g, '');
					return [name, declared.every((id) => new RegExp(`\\b${id}\\b`).test(body))];
				})
			);
			return {
				parsed,
				layoutGroups,
				floats: layout.MANDALA_UNIFORM_FLOATS,
				bytes: layout.MANDALA_UNIFORM_BYTES,
				packed: Array.from(packed),
				uniqueSlots: new Set(slotNames).size === slotNames.length,
				bindingsUsed,
				sceneEndsWithFragment: /fn fs_main[\s\S]*return vec4<f32>\(max\(color/.test(shaders.MANDALA_SCENE_WGSL),
				sceneHasBins: shaders.MANDALA_SCENE_WGSL.includes(
					'@group(0) @binding(1) var<storage, read> bins: array<f32, 64>'
				)
			};
		});

		expect(result.floats % 4).toBe(0);
		expect(result.bytes).toBe(result.floats * 4);
		expect(result.uniqueSlots).toBe(true);
		for (const [name, fields] of Object.entries(result.parsed)) {
			expect(fields, `${name} Params`).toEqual(result.layoutGroups);
		}
		for (const [name, used] of Object.entries(result.bindingsUsed)) {
			expect(used, `${name} uses every binding`).toBe(true);
		}
		expect(result.sceneHasBins).toBe(true);
		expect(result.sceneEndsWithFragment).toBe(true);
		for (let i = 0; i < result.floats; i += 1) {
			expect(result.packed[i], `packed float ${i}`).toBe(i + 1);
		}
	});
});
