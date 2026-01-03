
import { BoidsEngine } from './engine.js';

const STARTING_BOIDS = 4;
const STARTING_ENEMY_BOIDS = 4;  // Each enemy flock starting size
const ENEMY_FLOCK_COUNT = 16;     // Number of enemy flocks
const FOOD_COUNT = 1000;
const MAX_CAPACITY = 6000;
const ARENA_SIZE = 10.0;
const COLOR_FADE_DURATION = 4.0;

// AI Tuning Parameters
const AI_STRENGTH = 0.003;       // How strongly enemies hunt smaller flocks
const AI_FLEE_STRENGTH = 0.004;  // How strongly enemies flee from larger flocks

// Capture Detection Radii (squared distance thresholds)
const CAPTURE_RADIUS_FOOD = 0.02;   // Food capture radius (increase for faster speeds)
const CAPTURE_RADIUS_FLOCK = 0.02;  // Flock vs flock capture radius

// Flock names pool (40 names)
const FLOCK_NAMES = [
    "You",              // Player
    "Crimson Tide",
    "Shadow Legion",
    "Venom Swarm",
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
    "Dark Matter",
    "Cyber Sharks",
    "Plasma Horde",
    "Nebula Swarm",
    "Toxic Wasps",
    "Crystal Claws",
    "Obsidian Wings",
    "Quantum Drift",
    "Savage Pulse",
    "Binary Flock",
    "Magma Core",
    "Azure Storm",
    "Primal Fury",
    "Static Surge",
    "Lunar Eclipse",
    "Inferno Clan",
    "Turbo Swarm",
    "Vortex Squad",
    "Crimson Dawn",
    "Arctic Blitz",
    "Nova Burst"
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
    triangleCount: STARTING_BOIDS + (STARTING_ENEMY_BOIDS * ENEMY_FLOCK_COUNT) + FOOD_COUNT,
    colorFadeDuration: COLOR_FADE_DURATION,
    arenaSize: ARENA_SIZE,      // Pass to shader for boundary logic
    // Camera initial values
    cameraPos: [0, 0],
    cameraZoom: 0.5,
};

const canvas = document.querySelector("canvas");
const engine = new BoidsEngine(canvas, GAME_PARAMS, [0, 0, 0], true);

let playerBoids = STARTING_BOIDS;

// Generate flocks dynamically based on ENEMY_FLOCK_COUNT
function generateFlocks() {
    const result = [{ packId: 0, count: STARTING_BOIDS, name: FLOCK_NAMES[0] }]; // Player
    for (let i = 0; i < ENEMY_FLOCK_COUNT; i++) {
        result.push({
            packId: i + 2,  // packId 2, 3, 4, ...
            count: STARTING_ENEMY_BOIDS,
            name: FLOCK_NAMES[(i + 1) % FLOCK_NAMES.length]  // Cycle through names
        });
    }
    return result;
}
let flocks = generateFlocks();
let totalEntities = STARTING_BOIDS + (STARTING_ENEMY_BOIDS * ENEMY_FLOCK_COUNT) + FOOD_COUNT;

// Generate spawn positions around the arena perimeter
function generateSpawnPositions() {
    const result = [[0, 0]]; // Player: center
    const radius = ARENA_SIZE - 1.5;
    for (let i = 0; i < ENEMY_FLOCK_COUNT; i++) {
        const angle = (i / ENEMY_FLOCK_COUNT) * 2 * Math.PI;
        result.push([
            Math.cos(angle) * radius,
            Math.sin(angle) * radius
        ]);
    }
    return result;
}
const SPAWN_POSITIONS = generateSpawnPositions();

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

// Generate dual flock colors: {line, fill} (matching shader algorithm)
function getFlockColors(packId) {
    if (packId === 0) return { line: '#ffffff', fill: '#33ccff' }; // Player - white/blue
    if (packId === 1) return { line: '#ffcc33', fill: '#ffcc33' }; // Food - yellow
    // Enemy flocks: use two offset hues for line and fill
    const enemyIndex = packId - 2;
    const hue1 = ((enemyIndex * 0.13) % 1) * 360;
    const hue2 = ((enemyIndex * 0.13 + 0.5) % 1) * 360;  // Complementary color
    return {
        line: `hsl(${hue1}, 90%, 65%)`,
        fill: `hsl(${hue2}, 80%, 45%)`
    };
}

function updateLeaderboard() {
    const countEl = document.getElementById('count');

    // Update player boids count from flocks array
    playerBoids = flocks[0].count;

    // Check for game end conditions
    const aliveFlocks = flocks.filter(f => f.count > 0);

    if (playerBoids <= 0) {
        showGameEnd(false); // Game over
        return;
    }

    if (aliveFlocks.length === 1 && aliveFlocks[0].packId === 0) {
        showGameEnd(true); // Victory!
        return;
    }

    // Sort flocks by count (descending), but keep eliminated at bottom
    const sorted = [...flocks].sort((a, b) => {
        if (a.count <= 0 && b.count > 0) return 1;
        if (b.count <= 0 && a.count > 0) return -1;
        return b.count - a.count;
    });

    // Build leaderboard HTML - compact style with gradient names
    let html = '<div style="text-align:left;font-size:11px;line-height:1.3;">';
    sorted.forEach((flock, i) => {
        const colors = getFlockColors(flock.packId);
        const isPlayer = flock.packId === 0;
        const isEliminated = flock.count <= 0;
        const name = flock.name.split(' ')[0];

        // Gradient style for name (gray if eliminated)
        const gradientColors = isEliminated ? '#666, #444' : `${colors.line}, ${colors.fill}`;
        const gradientStyle = `background: linear-gradient(90deg, ${gradientColors});-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;display:inline;`;

        const countColor = isEliminated ? '#666' : colors.line;
        const boldStyle = isPlayer ? 'font-weight:bold;' : '';
        const strikeStyle = isEliminated ? 'text-decoration:line-through;opacity:0.6;' : '';

        html += `<div style="${boldStyle}${strikeStyle}">${i + 1}. <span style="${gradientStyle}">${name}</span>: <span style="color:${countColor}">${flock.count}</span></div>`;
    });
    html += '</div>';

    countEl.innerHTML = html;
}

let gameEnded = false;

function showGameEnd(isVictory) {
    if (gameEnded) return;
    gameEnded = true;

    const endDiv = document.getElementById('game-end');
    const title = document.getElementById('end-title');
    const message = document.getElementById('end-message');
    const stats = document.getElementById('end-stats');

    if (isVictory) {
        title.textContent = '🏆 VICTORY!';
        title.style.color = '#4ECDC4';
        message.textContent = 'You dominated all other flocks!';
        stats.innerHTML = `Final pack size: <strong>${playerBoids}</strong> boids`;
    } else {
        title.textContent = '💀 GAME OVER';
        title.style.color = '#ff4444';
        message.textContent = 'Your flock was eliminated!';
        const winner = flocks.reduce((a, b) => a.count > b.count ? a : b);
        stats.innerHTML = `Winner: <strong>${winner.name}</strong> with ${winner.count} boids`;
    }

    endDiv.style.display = 'block';

    if (isVictory) {
        // Victory: keep simulation running but disable mouse influence
        engine.setParams({ clickState: 0 });
    } else {
        // Game over: stop everything
        engine.stop();
    }
}

// Restart button handler
document.getElementById('restart-btn')?.addEventListener('click', () => {
    location.reload();
});

// Press Space to restart game at any time
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault();
        restartGame();
    }
});

function restartGame() {
    // Hide any end dialogs
    document.getElementById('game-end').style.display = 'none';
    document.getElementById('intro').style.display = 'none';

    // Reset game state
    gameEnded = false;
    flocks = generateFlocks();

    // Reset camera
    cameraX = 0;
    cameraY = 0;
    cameraZoom = BASE_ZOOM;
    targetZoom = BASE_ZOOM;

    // Reset game data and start
    resetGame();
    if (!engine.isRunning) {
        engine.start();
        gameLoop();
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

    // Sync flock counts from actual GPU data to fix any desync
    for (const flock of flocks) {
        const actualCount = (boidsByPack[flock.packId] || []).length;
        flock.count = actualCount;
    }

    // Update pack center target (interpolation happens in gameLoop)
    updatePackCenter(gpuData, players);

    // Calculate flock centers for AI
    const flockCenters = {};
    for (const flock of flocks) {
        const indices = boidsByPack[flock.packId] || [];
        if (indices.length === 0) {
            flockCenters[flock.packId] = null;
            continue;
        }
        let cx = 0, cy = 0;
        for (const idx of indices) {
            const base = idx * STRIDE_FLOATS;
            cx += gpuData[base + 0];
            cy += gpuData[base + 1];
        }
        flockCenters[flock.packId] = { x: cx / indices.length, y: cy / indices.length };
    }

    // Apply AI steering to enemy flocks

    for (const flock of flocks) {
        if (flock.packId === 0 || flock.packId === 1) continue; // Skip player and food
        const myIndices = boidsByPack[flock.packId] || [];
        if (myIndices.length === 0) continue;

        const myCenter = flockCenters[flock.packId];
        if (!myCenter) continue;

        let steerX = 0, steerY = 0;

        // Check other flocks (not food)
        for (const other of flocks) {
            if (other.packId === flock.packId || other.packId === 1) continue;
            const otherCenter = flockCenters[other.packId];
            if (!otherCenter || other.count <= 0) continue;

            const dx = otherCenter.x - myCenter.x;
            const dy = otherCenter.y - myCenter.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;

            if (other.count < flock.count * 0.8) {
                // Hunt smaller flocks (attract)
                steerX += (dx / dist) * AI_STRENGTH;
                steerY += (dy / dist) * AI_STRENGTH;
            } else if (other.count > flock.count * 1.2) {
                // Flee from larger flocks (repel)
                steerX -= (dx / dist) * AI_FLEE_STRENGTH;
                steerY -= (dy / dist) * AI_FLEE_STRENGTH;
            }
        }

        // Also seek food
        for (const fIdx of foods) {
            const fBase = fIdx * STRIDE_FLOATS;
            const fx = gpuData[fBase + 0];
            const fy = gpuData[fBase + 1];
            const dx = fx - myCenter.x;
            const dy = fy - myCenter.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            if (dist < 2.0) {
                steerX += (dx / dist) * AI_STRENGTH * 0.5;
                steerY += (dy / dist) * AI_STRENGTH * 0.5;
            }
        }

        // Apply steering to all boids in this flock
        for (const idx of myIndices) {
            const base = idx * STRIDE_FLOATS;
            gpuData[base + 2] += steerX;
            gpuData[base + 3] += steerY;
        }
        changed = true;
    }

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

                if (dx * dx + dy * dy < CAPTURE_RADIUS_FOOD) {
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

    // Track the correct data array (might have been expanded for new food)
    let currentData = gpuData;

    if (changed) {
        const newTotal = totalEntities + 1;
        const biggerData = new Float32Array(newTotal * STRIDE_FLOATS);
        biggerData.set(gpuData);

        writeBoid(biggerData, totalEntities, 1,
            (Math.random() * 2 - 1) * (ARENA_SIZE - 0.2),
            (Math.random() * 2 - 1) * (ARENA_SIZE - 0.2)
        );

        totalEntities = newTotal;
        currentData = biggerData;  // Use the expanded array
    }

    // Step 2.1: Flock vs Flock Consumption (size-based)
    // Any flock 1.5x larger can consume another flock's boids
    const CONSUME_RATIO = 1.5;
    let flockCaptureOccurred = false;

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
                const dx0 = currentData[dBase + 0];
                const dy0 = currentData[dBase + 1];

                for (const aIdx of attackerBoids) {
                    const aBase = aIdx * STRIDE_FLOATS;
                    const ax = currentData[aBase + 0];
                    const ay = currentData[aBase + 1];
                    const distX = dx0 - ax;
                    const distY = dy0 - ay;

                    if (distX * distX + distY * distY < CAPTURE_RADIUS_FLOCK) {
                        currentData[dBase + 6] = currentData[dBase + 4]; // Store prev
                        currentData[dBase + 4] = attackerFlock.packId;
                        currentData[dBase + 5] = engine.params.time;
                        pushOutward(currentData, dBase, dx0, dy0, attackerBoids);
                        attackerFlock.count++;
                        defenderFlock.count--;
                        flockCaptureOccurred = true;
                        break;
                    }
                }
            }
        }
    }

    // Only call setTriangleData once at the end if anything changed
    if (changed || flockCaptureOccurred) {
        engine.setTriangleData(totalEntities, currentData);
        updateLeaderboard();
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
