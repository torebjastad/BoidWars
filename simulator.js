
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19/+esm';
import { BoidsEngine } from './engine.js';

const INITIAL_TRIANGLE_COUNT = 1000;
const INITIAL_TRIANGLE_SIZE = 0.1;

// All distances are scaled for triangleSize 0.1 (multiply old 0.03 params by 3.33)
const INITIAL_PARAMS = {
    separationDistance: 0.17,   // 0.05 * 3.33
    separationStrength: 0.001,
    alignmentDistance: 1.0,     // 0.3 * 3.33
    alignmentStrength: 0.01,
    cohesionDistance: 1.0,      // 0.3 * 3.33
    cohesionStrength: 0.001,
    triangleSize: INITIAL_TRIANGLE_SIZE,
    triangleCount: INITIAL_TRIANGLE_COUNT,
    cameraZoom: 0.2,            // Zoom out to see larger arena
    aspectRatio: 1.0,           // Will be updated on resize
};

const COLOR_PRESETS = {
    plumTree: [1.0, 2.0, 1.0],
    jeans: [2.0, 1.5, 1.0],
    greyscale: [0.0, 0.0, 0.0],
    hotcold: [0.0, 3.14, 3.14],
    uniform: [0.0, 0.0, 0.0],   // Uniform color (handled specially in shader)
};

// All presets scaled for triangleSize 0.1 (old presets were for 0.03)
const SIM_PRESETS = {
    default: { ...INITIAL_PARAMS },
    game: {
        separationDistance: 0.11,
        separationStrength: 0.051,
        alignmentDistance: 0.15,
        alignmentStrength: 0.1,
        cohesionDistance: 5.0,
        cohesionStrength: 0.002,
    },
    mosquitoes: {
        separationDistance: 0.067,  // 0.02 * 3.33
        separationStrength: 0.01,
        alignmentDistance: 0.0,
        alignmentStrength: 0.0,
        cohesionDistance: 0.59,     // 0.177 * 3.33
        cohesionStrength: 0.011,
    },
    blobs: {
        separationDistance: 0.11,   // 0.033 * 3.33
        separationStrength: 0.051,
        alignmentDistance: 0.157,   // 0.047 * 3.33
        alignmentStrength: 0.1,
        cohesionDistance: 1.0,      // 0.3 * 3.33
        cohesionStrength: 0.013,
    },
    particles: {
        separationDistance: 0.117,  // 0.035 * 3.33
        separationStrength: 1,
        alignmentDistance: 0.0,
        alignmentStrength: 0.0,
        cohesionDistance: 0.0,
        cohesionStrength: 0.0,
    },
    nanites: {
        separationDistance: 0.223,  // 0.067 * 3.33
        separationStrength: 0.01,
        alignmentDistance: 0.22,    // 0.066 * 3.33
        alignmentStrength: 0.021,
        cohesionDistance: 0.287,    // 0.086 * 3.33
        cohesionStrength: 0.094,
    },
};

const canvas = document.querySelector("canvas");
const engine = new BoidsEngine(canvas, INITIAL_PARAMS, COLOR_PRESETS.jeans);

async function start() {
    const success = await engine.init();
    if (success) {
        // Update aspect ratio on resize
        const updateAspectRatio = () => {
            engine.setParams({ aspectRatio: canvas.width / canvas.height });
        };
        window.addEventListener('resize', updateAspectRatio);
        updateAspectRatio();

        // Add mouse and zoom event handlers
        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const zoom = engine.params.cameraZoom || 1.0;
            const aspectRatio = canvas.width / canvas.height;
            // Convert to world coordinates accounting for zoom
            const x = ((e.clientX - rect.left) / rect.width * 2 - 1) / zoom * aspectRatio;
            const y = -((e.clientY - rect.top) / rect.height * 2 - 1) / zoom;
            engine.setParams({ mousePos: [x, y] });
        });

        canvas.addEventListener('mousedown', () => {
            engine.setParams({ clickState: 1 });
        });

        canvas.addEventListener('mouseup', () => {
            engine.setParams({ clickState: 0 });
        });

        canvas.addEventListener('mouseleave', () => {
            engine.setParams({ clickState: 0 });
        });

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const zoom = engine.params.cameraZoom || 1.0;
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            engine.setParams({ cameraZoom: Math.max(0.1, Math.min(5.0, zoom * delta)) });
        }, { passive: false });

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
    folderParams.add(engine.params, 'triangleSize', 0.01, 0.2).name('Triangle Size').onChange(updateEngine);

    // Ranges scaled for triangleSize 0.1 (3.33x larger than old 0.03)
    folderParams.add(engine.params, 'separationDistance', 0.0, 1.0).name('Separation Dist').onChange(updateEngine);
    folderParams.add(engine.params, 'separationStrength', 0.0, 0.2).name('Separation Str').onChange(updateEngine);
    folderParams.add(engine.params, 'alignmentDistance', 0.0, 2.0).name('Alignment Dist').onChange(updateEngine);
    folderParams.add(engine.params, 'alignmentStrength', 0.0, 0.2).name('Alignment Str').onChange(updateEngine);
    folderParams.add(engine.params, 'cohesionDistance', 0.0, 5.0).name('Cohesion Dist').onChange(updateEngine);
    folderParams.add(engine.params, 'cohesionStrength', 0.0, 0.2).name('Cohesion Str').onChange(updateEngine);

    // --- Presets ---
    const presetFolder = gui.addFolder('Presets');
    Object.keys(SIM_PRESETS).forEach(key => {
        const config = {
            [key]: () => {
                const p = SIM_PRESETS[key];
                // Preserve un-specified params in preset
                const newParams = { ...p };
                if (newParams.triangleCount === undefined) newParams.triangleCount = engine.params.triangleCount;
                if (newParams.triangleSize === undefined) newParams.triangleSize = engine.params.triangleSize;

                engine.setParams(newParams);
                folderParams.children.forEach(c => c.updateDisplay());
            }
        };
        presetFolder.add(config, key);
    });

    const colorFolder = gui.addFolder('Color Themes');
    Object.keys(COLOR_PRESETS).forEach(key => {
        const config = {
            [key]: () => engine.setColor(COLOR_PRESETS[key])
        };
        colorFolder.add(config, key);
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
