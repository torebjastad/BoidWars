
import { BoidsEngine } from './engine.js';

const STARTING_BOIDS = 4;
const STARTING_ENEMY_BOIDS = 4;  // Each enemy flock starting size
const ENEMY_FLOCK_COUNT = 3;     // Number of enemy flocks
const FOOD_COUNT = 50;
const MAX_CAPACITY = 2000;
const ARENA_SIZE = 8.0;
const COLOR_FADE_DURATION = 4.0;

// Flock names pool (20 names for future expansion)
const FLOCK_NAMES = [
    "You",           // 0 - Player (always first)
    "Crimson Tide",  // 2
    "Shadow Legion", // 3
    "Venom Swarm",   // 4
    "Frost Fangs",
    "Thunder Hawks",
    "Ember Wolves",
    "Void Hunters",
    "Storm Riders",
    "Iron Talons",
    "Night Crawlers",
    "Blaze Runners",
    "Phantom Flock",
    "Apex Predators",
    "Omega Squad",
    "Neon Vipers",
    "Chaos Swarm",
    "Glacier Pack",
    "Solar Flares",
    "Dark Matter"
];

const GAME_PARAMS = {
    // Blob Preset (Scaled x3.33 for size 0.1)
    separationDistance: 0.11,   // 0.033 * 3.33
    separationStrength: 0.051,  // Exact from preset
    alignmentDistance: 0.15,    // 0.047 * 3.33
    alignmentStrength: 0.1,     // Exact from preset
    cohesionDistance: 5.0,      // 0.3 * 3.33
    cohesionStrength: 0.002,    // Exact from preset
    triangleSize: 0.1,
    triangleCount: STARTING_BOIDS,
    colorFadeDuration: COLOR_FADE_DURATION,
    arenaSize: ARENA_SIZE,      // Pass to shader for boundary logic
    // Camera initial values
    cameraPos: [0, 0],
    cameraZoom: 0.5,
};

const canvas = document.querySelector("canvas");
const engine = new BoidsEngine(canvas, GAME_PARAMS, [0, 0, 0], true);

let playerBoids = STARTING_BOIDS;
// Flocks array: [{ packId, count, name }]
let flocks = [
    { packId: 0, count: STARTING_BOIDS, name: FLOCK_NAMES[0] },  // Player
    { packId: 2, count: STARTING_ENEMY_BOIDS, name: FLOCK_NAMES[1] },
    { packId: 3, count: STARTING_ENEMY_BOIDS, name: FLOCK_NAMES[2] },
    { packId: 4, count: STARTING_ENEMY_BOIDS, name: FLOCK_NAMES[3] },
];
let totalEntities = STARTING_BOIDS + (STARTING_ENEMY_BOIDS * ENEMY_FLOCK_COUNT) + FOOD_COUNT;

// Spawn positions for each flock (corners)
const SPAWN_POSITIONS = [
    [0, 0],                           // Player: center
    [ARENA_SIZE - 1.5, ARENA_SIZE - 1.5],   // Flock 2: top-right
    [-ARENA_SIZE + 1.5, ARENA_SIZE - 1.5],  // Flock 3: top-left
    [-ARENA_SIZE + 1.5, -ARENA_SIZE + 1.5], // Flock 4: bottom-left
];

// Update stride to 8 floats (32 bytes)
const STRIDE_FLOATS = 8;

// Camera state
const BASE_ZOOM = 0.4;      // Initial zoom (close view)
const MIN_ZOOM = 0.15;      // Max zoomed out
const ZOOM_EXPONENT = 0.15;  // How fast zoom changes with pack size (lower = slower zoom out)
const CAMERA_SMOOTHING = 0.1; // Lower = smoother camera
let cameraX = 0, cameraY = 0;
let cameraZoom = BASE_ZOOM;
let targetZoom = BASE_ZOOM;  // Target zoom for smooth interpolation
let packCenterX = 0, packCenterY = 0;
let lastMouseScreenX = 0.5, lastMouseScreenY = 0.5; // Normalized screen coords

async function initGame() {
    const success = await engine.init();
    if (!success) return;

    resetGame();

    // Hook Input - store normalized screen coords, convert to world in gameLoop
    canvas.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        lastMouseScreenX = (e.clientX - rect.left) / rect.width;
        lastMouseScreenY = (e.clientY - rect.top) / rect.height;
        updateMouseWorldPos();
    });

    document.getElementById('start-btn').addEventListener('click', () => {
        document.getElementById('intro').style.display = 'none';
        engine.start();
        gameLoop();
    });
}

function resetGame() {
    // Reset flock counts
    flocks[0].count = STARTING_BOIDS;
    for (let i = 1; i < flocks.length; i++) {
        flocks[i].count = STARTING_ENEMY_BOIDS;
    }
    playerBoids = STARTING_BOIDS;

    const totalFlockBoids = STARTING_BOIDS + (STARTING_ENEMY_BOIDS * ENEMY_FLOCK_COUNT);
    totalEntities = totalFlockBoids + FOOD_COUNT;

    const data = new Float32Array(totalEntities * STRIDE_FLOATS);
    const SPAWN_RADIUS = 0.5;
    let boidIndex = 0;

    // Spawn each flock
    for (let f = 0; f < flocks.length; f++) {
        const flock = flocks[f];
        const [spawnX, spawnY] = SPAWN_POSITIONS[f];

        for (let i = 0; i < flock.count; i++) {
            writeBoid(data, boidIndex, flock.packId,
                spawnX + (Math.random() * 2 - 1) * SPAWN_RADIUS,
                spawnY + (Math.random() * 2 - 1) * SPAWN_RADIUS
            );
            boidIndex++;
        }
    }

    // Food
    for (let i = 0; i < FOOD_COUNT; i++) {
        writeBoid(data, boidIndex + i, 1,
            (Math.random() * 2 - 1) * (ARENA_SIZE - 0.2),
            (Math.random() * 2 - 1) * (ARENA_SIZE - 0.2)
        );
    }

    engine.setTriangleData(totalEntities, data);
    updateLeaderboard();
}

function writeBoid(data, index, packId, x, y, captureTime = 0) {
    const base = index * STRIDE_FLOATS;
    data[base + 0] = x;
    data[base + 1] = y;
    data[base + 2] = (Math.random() - 0.5) * 0.05;
    data[base + 3] = (Math.random() - 0.5) * 0.05;
    data[base + 4] = packId;
    data[base + 5] = captureTime; // Time when captured (0 = original pack)
    data[base + 6] = 0; // Padding
    data[base + 7] = 0; // Padding
}

// Flock CSS colors (matching shader colors)
const FLOCK_COLORS = {
    0: '#33ccff', // Blue (player)
    2: '#ff5533', // Red
    3: '#cc55ff', // Purple
    4: '#55ff66', // Green
};

function updateLeaderboard() {
    const countEl = document.getElementById('count');

    // Update player boids count from flocks array
    playerBoids = flocks[0].count;

    if (playerBoids <= 0) {
        countEl.innerHTML = '<span style="color:#ff4444;font-size:24px;">GAME OVER</span>';
        return;
    }

    // Sort flocks by count (descending)
    const sorted = [...flocks].sort((a, b) => b.count - a.count);

    // Build leaderboard HTML
    let html = '<div style="text-align:left;">';
    sorted.forEach((flock, i) => {
        const color = FLOCK_COLORS[flock.packId] || '#fff';
        const isPlayer = flock.packId === 0;
        const style = `color:${color};${isPlayer ? 'font-weight:bold;' : ''}`;
        html += `<div style="${style}">${i + 1}. ${flock.name}: ${flock.count}</div>`;
    });
    html += '</div>';

    countEl.innerHTML = html;
}

// Convert screen coords to world coords using current camera
function updateMouseWorldPos() {
    // Screen normalized -> NDC (-1 to 1) -> World (accounting for camera and aspect ratio)
    const aspectRatio = canvas.width / canvas.height;
    const ndcX = (lastMouseScreenX * 2 - 1);
    const ndcY = -(lastMouseScreenY * 2 - 1);

    // Convert from screen to world: reverse the camera transform
    // Shader does: pos.x = (worldPos.x - cameraX) * zoom / aspectRatio
    // So: worldX = ndcX * aspectRatio / zoom + cameraX
    const worldX = ndcX * aspectRatio / cameraZoom + cameraX;
    const worldY = ndcY / cameraZoom + cameraY;

    engine.setParams({ mousePos: [worldX, worldY] });
}

// Update camera based on pack center and size
function updatePackCenter(gpuData, playerIndices) {
    if (playerIndices.length === 0) return;

    // Calculate pack center
    let sumX = 0, sumY = 0;
    for (const idx of playerIndices) {
        const base = idx * STRIDE_FLOATS;
        sumX += gpuData[base + 0];
        sumY += gpuData[base + 1];
    }
    packCenterX = sumX / playerIndices.length;
    packCenterY = sumY / playerIndices.length;

    // Calculate target zoom based on pack size
    targetZoom = Math.max(MIN_ZOOM, BASE_ZOOM / Math.pow(playerBoids, ZOOM_EXPONENT));
}

// Smooth camera interpolation - called every frame for smoothness
function smoothCameraUpdate() {
    // Smooth camera movement (lerp)
    cameraX += (packCenterX - cameraX) * CAMERA_SMOOTHING;
    cameraY += (packCenterY - cameraY) * CAMERA_SMOOTHING;
    cameraZoom += (targetZoom - cameraZoom) * CAMERA_SMOOTHING;

    // Update engine params
    engine.setParams({
        cameraPos: [cameraX, cameraY],
        cameraZoom: cameraZoom
    });

    // Also update mouse world position since camera moved
    updateMouseWorldPos();
}

let lastCheck = 0;
const CHECK_INTERVAL = 100;

function gameLoop() {
    if (!engine.isRunning) return;

    // Update camera smoothly every frame
    smoothCameraUpdate();

    const now = performance.now();
    if (now - lastCheck > CHECK_INTERVAL) {
        checkCollisions();
        lastCheck = now;
    }

    requestAnimationFrame(gameLoop);
}

async function checkCollisions() {
    const gpuData = await engine.readData();
    if (!gpuData) return;

    let changed = false;

    // Build boidsByPack: { packId: [indices] }
    const boidsByPack = {};
    for (let i = 0; i < totalEntities; i++) {
        const base = i * STRIDE_FLOATS;
        const packId = Math.round(gpuData[base + 4]);
        if (!boidsByPack[packId]) boidsByPack[packId] = [];
        boidsByPack[packId].push(i);
    }

    const foods = boidsByPack[1] || [];
    const players = boidsByPack[0] || [];

    // Update pack center target (interpolation happens in gameLoop)
    updatePackCenter(gpuData, players);

    // Food capture by any flock
    for (const fIdx of foods) {
        const fBase = fIdx * STRIDE_FLOATS;
        const fx = gpuData[fBase + 0];
        const fy = gpuData[fBase + 1];
        let captured = false;

        // Check against all non-food flocks
        for (const flock of flocks) {
            if (captured) break;
            const flockBoids = boidsByPack[flock.packId] || [];

            for (const bIdx of flockBoids) {
                const bBase = bIdx * STRIDE_FLOATS;
                const bx = gpuData[bBase + 0];
                const by = gpuData[bBase + 1];
                const dx = fx - bx;
                const dy = fy - by;

                if (dx * dx + dy * dy < 0.01) {
                    gpuData[fBase + 6] = gpuData[fBase + 4]; // Store previous packId
                    gpuData[fBase + 4] = flock.packId;
                    gpuData[fBase + 5] = engine.params.time;
                    pushOutward(gpuData, fBase, fx, fy, flockBoids);
                    flock.count++;
                    changed = true;
                    captured = true;
                    break;
                }
            }
        }
    }

    if (changed) {
        const newTotal = totalEntities + 1;
        const biggerData = new Float32Array(newTotal * STRIDE_FLOATS);
        biggerData.set(gpuData);

        writeBoid(biggerData, totalEntities, 1,
            (Math.random() * 2 - 1) * (ARENA_SIZE - 0.2),
            (Math.random() * 2 - 1) * (ARENA_SIZE - 0.2)
        );

        totalEntities = newTotal;
        engine.setTriangleData(totalEntities, biggerData);
        updateLeaderboard();
    }

    // Step 2.1: Flock vs Flock Consumption (size-based)
    // Any flock 1.5x larger can consume another flock's boids
    const CONSUME_RATIO = 1.5;

    for (let i = 0; i < flocks.length; i++) {
        const attackerFlock = flocks[i];
        const attackerBoids = boidsByPack[attackerFlock.packId] || [];

        for (let j = 0; j < flocks.length; j++) {
            if (i === j) continue;
            const defenderFlock = flocks[j];

            // Only attack if significantly larger
            if (attackerFlock.count < defenderFlock.count * CONSUME_RATIO) continue;

            const defenderBoids = boidsByPack[defenderFlock.packId] || [];

            for (const dIdx of defenderBoids) {
                const dBase = dIdx * STRIDE_FLOATS;
                const dx0 = gpuData[dBase + 0];
                const dy0 = gpuData[dBase + 1];

                for (const aIdx of attackerBoids) {
                    const aBase = aIdx * STRIDE_FLOATS;
                    const ax = gpuData[aBase + 0];
                    const ay = gpuData[aBase + 1];
                    const distX = dx0 - ax;
                    const distY = dy0 - ay;

                    if (distX * distX + distY * distY < 0.02) {
                        gpuData[dBase + 6] = gpuData[dBase + 4]; // Store prev
                        gpuData[dBase + 4] = attackerFlock.packId;
                        gpuData[dBase + 5] = engine.params.time;
                        pushOutward(gpuData, dBase, dx0, dy0, attackerBoids);
                        attackerFlock.count++;
                        defenderFlock.count--;
                        engine.setTriangleData(totalEntities, gpuData);
                        updateLeaderboard();
                        break;
                    }
                }
            }
        }
    }
}

// Helper: Push captured boid outward from pack center
function pushOutward(gpuData, boidBase, boidX, boidY, packIndices) {
    if (packIndices.length === 0) return;

    let centerX = 0, centerY = 0;
    for (const idx of packIndices) {
        const base = idx * STRIDE_FLOATS;
        centerX += gpuData[base + 0];
        centerY += gpuData[base + 1];
    }
    centerX /= packIndices.length;
    centerY /= packIndices.length;

    const outX = boidX - centerX;
    const outY = boidY - centerY;
    const outLen = Math.sqrt(outX * outX + outY * outY) || 1;
    gpuData[boidBase + 2] = (outX / outLen) * 0.03;
    gpuData[boidBase + 3] = (outY / outLen) * 0.03;
}

initGame();
