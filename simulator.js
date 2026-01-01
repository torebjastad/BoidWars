
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19/+esm';
import { BoidsEngine } from './engine.js';

const INITIAL_TRIANGLE_COUNT = 1000;
const INITIAL_TRIANGLE_SIZE = 0.03;

const INITIAL_PARAMS = {
    separationDistance: 0.05,
    separationStrength: 0.001,
    alignmentDistance: 0.3,
    alignmentStrength: 0.01,
    cohesionDistance: 0.3,
    cohesionStrength: 0.001,
    triangleSize: INITIAL_TRIANGLE_SIZE,
    triangleCount: INITIAL_TRIANGLE_COUNT,
};

const COLOR_PRESETS = {
    plumTree: [1.0, 2.0, 1.0],
    jeans: [2.0, 1.5, 1.0],
    greyscale: [0.0, 0.0, 0.0],
    hotcold: [0.0, 3.14, 3.14],
};

const SIM_PRESETS = {
    default: { ...INITIAL_PARAMS },
    mosquitoes: {
        separationDistance: 0.02,
        separationStrength: 0.01,
        alignmentDistance: 0.0,
        alignmentStrength: 0.0,
        cohesionDistance: 0.177,
        cohesionStrength: 0.011,
    },
    blobs: {
        separationDistance: 0.033,
        separationStrength: 0.051,
        alignmentDistance: 0.047,
        alignmentStrength: 0.1,
        cohesionDistance: 0.3,
        cohesionStrength: 0.013,
    },
    particles: {
        separationDistance: 0.035,
        separationStrength: 1,
        alignmentDistance: 0.0,
        alignmentStrength: 0.0,
        cohesionDistance: 0.0,
        cohesionStrength: 0.0,
    },
    nanites: {
        separationDistance: 0.067,
        separationStrength: 0.01,
        alignmentDistance: 0.066,
        alignmentStrength: 0.021,
        cohesionDistance: 0.086,
        cohesionStrength: 0.094,
    },
};

const canvas = document.querySelector("canvas");
const engine = new BoidsEngine(canvas, INITIAL_PARAMS, COLOR_PRESETS.jeans);

async function start() {
    const success = await engine.init();
    if (success) {
        engine.start();
        initGUI();
    }
}

function initGUI() {
    const gui = new GUI({ title: 'Boids Tuning' });

    // Sim State for GUI to bind to (referencing engine params)
    const guiState = {
        colorPreset: 'jeans',
        preset: 'default'
    };

    // --- Parameters Folder ---
    const folderParams = gui.addFolder('Parameters');

    // Helpers to wrapping engine updates
    const updateEngine = () => engine.setParams(engine.params);

    folderParams.add(engine.params, 'triangleCount', 100, 20000, 100).name('Triangle Count').onFinishChange(updateEngine);
    folderParams.add(engine.params, 'triangleSize', 0.01, 0.1).name('Triangle Size').onChange(updateEngine);

    folderParams.add(engine.params, 'separationDistance', 0.0, 0.2).name('Separation Dist').onChange(updateEngine);
    folderParams.add(engine.params, 'separationStrength', 0.0, 0.1).name('Separation Str').onChange(updateEngine);
    folderParams.add(engine.params, 'alignmentDistance', 0.0, 0.5).name('Alignment Dist').onChange(updateEngine);
    folderParams.add(engine.params, 'alignmentStrength', 0.0, 0.1).name('Alignment Str').onChange(updateEngine);
    folderParams.add(engine.params, 'cohesionDistance', 0.0, 0.5).name('Cohesion Dist').onChange(updateEngine);
    folderParams.add(engine.params, 'cohesionStrength', 0.0, 0.1).name('Cohesion Str').onChange(updateEngine);

    // --- Presets ---
    gui.add(guiState, 'preset', Object.keys(SIM_PRESETS)).name('Simulation Preset').onChange(v => {
        const p = SIM_PRESETS[v];
        // Preserve un-specified params in preset
        const newParams = { ...p };
        if (newParams.triangleCount === undefined) newParams.triangleCount = engine.params.triangleCount;
        if (newParams.triangleSize === undefined) newParams.triangleSize = engine.params.triangleSize;

        engine.setParams(newParams);

        // Update GUI display
        folderParams.children.forEach(c => c.updateDisplay());
    });

    gui.add(guiState, 'colorPreset', Object.keys(COLOR_PRESETS)).name('Color Theme').onChange(v => {
        engine.setColor(COLOR_PRESETS[v]);
    });

    gui.add({
        reset: () => {
            // Just re-init buffers (randomize)
            engine.initTriangleBuffers(engine.params.triangleCount);
            engine.createBindGroups();
        }
    }, 'reset').name('Randomize Positions');
}

start();
