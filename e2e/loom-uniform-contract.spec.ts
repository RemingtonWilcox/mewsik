import { expect, test } from '@playwright/test';

// The Loom WGSL Params struct and the TypeScript packing helper must never
// drift apart. The struct carries one comment of four slot names above every
// vec4 field; this spec parses both sides and compares them exactly.
test.describe('Loom uniform contract', () => {
	test('WGSL Params layout matches the TypeScript packing layout', async ({ page }) => {
		await page.goto('/');
		const result = await page.evaluate(async () => {
			const layout = await import('/src/lib/visualizer/loom/uniform-layout.ts');
			const shaders = await import('/src/lib/visualizer/loom/shaders.ts');

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

			const sceneFields = parseParams(shaders.LOOM_SCENE_WGSL);
			const compositeFields = parseParams(shaders.LOOM_COMPOSITE_WGSL);
			const layoutGroups = layout.LOOM_UNIFORM_GROUPS.map(([group, slots]) => ({
				group,
				slots: [...slots]
			}));

			const values = Object.fromEntries(
				layout.LOOM_UNIFORM_GROUPS.flatMap(([, slots], groupIndex) =>
					slots.map((slot, slotIndex) => [slot, groupIndex * 4 + slotIndex + 1])
				)
			) as Parameters<typeof layout.packLoomUniforms>[1];
			const packed = layout.packLoomUniforms(
				new Float32Array(layout.LOOM_UNIFORM_FLOATS),
				values
			);

			return {
				sceneFields,
				compositeFields,
				layoutGroups,
				floats: layout.LOOM_UNIFORM_FLOATS,
				packed: Array.from(packed),
				sceneHasDetailBinding: shaders.LOOM_SCENE_WGSL.includes(
					'@group(0) @binding(1) var<storage, read> detailBins: array<f32, 64>'
				)
			};
		});

		expect(result.floats).toBe(52);
		expect(result.sceneFields).not.toBeNull();
		expect(result.compositeFields).not.toBeNull();
		expect(result.sceneFields).toEqual(result.layoutGroups);
		expect(result.compositeFields).toEqual(result.layoutGroups);
		expect(result.sceneHasDetailBinding).toBe(true);
		for (let i = 0; i < 52; i += 1) {
			expect(result.packed[i], `packed float ${i}`).toBe(i + 1);
		}
	});
});
