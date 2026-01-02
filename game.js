
import { BoidsEngine } from './engine.js';

const STARTING_BOIDS = 4;
const STARTING_ENEMY_BOIDS = 4;  // Enemy flock starting size
const FOOD_COUNT = 50;
const MAX_CAPACITY = 2000;
const ARENA_SIZE = 4.0; // Doubled from 4.0
const COLOR_FADE_DURATION = 4.0; // Seconds for captured boids to fade

const GAME_PARAMS = {
    // Blob Preset (Scaled x3.33 for size 0.1)
    separationDistance: 0.11,   // 0.033 * 3.33
    separationStrength: 0.051,  // Exact from preset
    alignmentDistance: 0.15,    // 0.047 * 3.33
    alignmentStrength: 0.1,     // Exact from preset
    cohesionDistance: 5.0,      // 0.3 * 3.33
    cohesionStrength: 0.001,    // Exact from preset
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
let enemyBoids = STARTING_ENEMY_BOIDS;
let totalEntities = STARTING_BOIDS + STARTING_ENEMY_BOIDS + FOOD_COUNT;

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
    playerBoids = STARTING_BOIDS;
    enemyBoids = STARTING_ENEMY_BOIDS;
    totalEntities = playerBoids + enemyBoids + FOOD_COUNT;

    // Allocate buffer
    const data = new Float32Array(totalEntities * STRIDE_FLOATS);

    // Player - spawn concentrated in center
    const SPAWN_RADIUS = 0.5;
    for (let i = 0; i < playerBoids; i++) {
        writeBoid(data, i, 0,
            (Math.random() * 2 - 1) * SPAWN_RADIUS,
            (Math.random() * 2 - 1) * SPAWN_RADIUS
        );
    }
    // Enemy Flock - spawn in opposite corner (top-right)
    for (let i = 0; i < enemyBoids; i++) {
        writeBoid(data, playerBoids + i, 2,  // packId = 2 for enemy
            (ARENA_SIZE - 2.0) + (Math.random() * 2 - 1) * SPAWN_RADIUS,
            (ARENA_SIZE - 2.0) + (Math.random() * 2 - 1) * SPAWN_RADIUS
        );
    }
    // Food
    for (let i = 0; i < FOOD_COUNT; i++) {
        writeBoid(data, playerBoids + enemyBoids + i, 1,
            (Math.random() * 2 - 1) * (ARENA_SIZE - 0.2),
            (Math.random() * 2 - 1) * (ARENA_SIZE - 0.2)
        );
    }

    engine.setTriangleData(totalEntities, data);
    updateScore();
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

function updateScore() {
    const countEl = document.getElementById('count');
    if (playerBoids <= 0) {
        countEl.innerText = "GAME OVER";
        countEl.style.color = "#ff4444";
    } else {
        countEl.innerText = `You: ${playerBoids} | Enemy: ${enemyBoids}`;
        countEl.style.color = "";
    }
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
    const players = [];
    const foods = [];
    const enemies = [];

    for (let i = 0; i < totalEntities; i++) {
        const base = i * STRIDE_FLOATS;
        const packId = gpuData[base + 4];
        if (packId === 0) players.push(i);
        else if (packId === 1) foods.push(i);
        else if (packId === 2) enemies.push(i);
    }

    // Update pack center target (interpolation happens in gameLoop)
    updatePackCenter(gpuData, players);

    for (const fIdx of foods) {
        const fBase = fIdx * STRIDE_FLOATS;
        const fx = gpuData[fBase + 0];
        const fy = gpuData[fBase + 1];
        let captured = false;

        // Check Player Collisions
        for (const pIdx of players) {
            const pBase = pIdx * STRIDE_FLOATS;
            const px = gpuData[pBase + 0];
            const py = gpuData[pBase + 1];
            const dx = fx - px;
            const dy = fy - py;

            if (dx * dx + dy * dy < 0.01) {
                gpuData[fBase + 6] = gpuData[fBase + 4]; // Store previous packId
                gpuData[fBase + 4] = 0; // Set packId to Player
                gpuData[fBase + 5] = engine.params.time;
                pushOutward(gpuData, fBase, fx, fy, players);
                changed = true;
                captured = true;
                playerBoids++;
                break;
            }
        }

        if (captured) continue;

        // Check Enemy Collisions
        for (const eIdx of enemies) {
            const eBase = eIdx * STRIDE_FLOATS;
            const ex = gpuData[eBase + 0];
            const ey = gpuData[eBase + 1];
            const dx = fx - ex;
            const dy = fy - ey;

            if (dx * dx + dy * dy < 0.01) {
                gpuData[fBase + 6] = gpuData[fBase + 4]; // Store previous packId
                gpuData[fBase + 4] = 2; // Set packId to Enemy
                gpuData[fBase + 5] = engine.params.time;
                pushOutward(gpuData, fBase, fx, fy, enemies);
                changed = true;
                enemyBoids++;
                break;
            }
        }
    }

    if (changed) {
        let newData = gpuData;
        const newTotal = totalEntities + 1;

        const biggerData = new Float32Array(newTotal * STRIDE_FLOATS);
        biggerData.set(gpuData);

        writeBoid(biggerData, totalEntities, 1,
            (Math.random() * 2 - 1) * (ARENA_SIZE - 0.2),
            (Math.random() * 2 - 1) * (ARENA_SIZE - 0.2)
        );

        totalEntities = newTotal;
        engine.setTriangleData(totalEntities, biggerData);
        updateScore();
    }

    // Step 2.1: Flock vs Flock Consumption (size-based)
    const CONSUME_RATIO = 1.5; // Must be 1.5x larger to consume

    // Player consumes Enemy boids
    if (playerBoids > enemyBoids * CONSUME_RATIO) {
        for (const eIdx of enemies) {
            const eBase = eIdx * STRIDE_FLOATS;
            const ex = gpuData[eBase + 0];
            const ey = gpuData[eBase + 1];

            for (const pIdx of players) {
                const pBase = pIdx * STRIDE_FLOATS;
                const px = gpuData[pBase + 0];
                const py = gpuData[pBase + 1];
                const dx = ex - px;
                const dy = ey - py;

                if (dx * dx + dy * dy < 0.02) {
                    gpuData[eBase + 6] = gpuData[eBase + 4]; // Store previous packId
                    gpuData[eBase + 4] = 0; // Convert to Player
                    gpuData[eBase + 5] = engine.params.time;
                    pushOutward(gpuData, eBase, ex, ey, players);
                    playerBoids++;
                    enemyBoids--;
                    engine.setTriangleData(totalEntities, gpuData);
                    updateScore();
                    break;
                }
            }
        }
    }
    // Enemy consumes Player boids
    else if (enemyBoids > playerBoids * CONSUME_RATIO) {
        for (const pIdx of players) {
            const pBase = pIdx * STRIDE_FLOATS;
            const px = gpuData[pBase + 0];
            const py = gpuData[pBase + 1];

            for (const eIdx of enemies) {
                const eBase = eIdx * STRIDE_FLOATS;
                const ex = gpuData[eBase + 0];
                const ey = gpuData[eBase + 1];
                const dx = px - ex;
                const dy = py - ey;

                if (dx * dx + dy * dy < 0.02) {
                    gpuData[pBase + 6] = gpuData[pBase + 4]; // Store previous packId
                    gpuData[pBase + 4] = 2; // Convert to Enemy
                    gpuData[pBase + 5] = engine.params.time;
                    pushOutward(gpuData, pBase, px, py, enemies);
                    enemyBoids++;
                    playerBoids--;
                    engine.setTriangleData(totalEntities, gpuData);
                    updateScore();
                    break;
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
