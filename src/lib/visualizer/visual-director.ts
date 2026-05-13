// Facade — re-exports the v2 director so existing imports keep working while
// the renderer code migrates to the modular pipeline under ./director/.

export {
	VisualDirector,
	createVisualDirector,
	hsvToRgb
} from './director/index.js';
export type {
	VisualDirectorFrame,
	VisualizerSection,
	VisualizerMotif,
	PaletteHSV,
	MusicalClock,
	DropState
} from './director/index.js';
