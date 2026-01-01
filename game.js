
import { BoidsEngine } from './engine.js';

const STARTING_BOIDS = 4;
const FOOD_COUNT = 20;
const MAX_CAPACITY = 2000;

const GAME_PARAMS = {
    separationDistance: 0.1, // Larger for game feel
    separationStrength: 0.05,
    alignmentDistance: 0.2,
    alignmentStrength: 0.05,
    cohesionDistance: 0.3,
    cohesionStrength: 0.02,
    triangleSize: 0.04,
    triangleCount: STARTING_BOIDS,
};

const canvas = document.querySelector("canvas");
const engine = new BoidsEngine(canvas, GAME_PARAMS, [0, 0, 0], true);

// Game State
let playerBoids = STARTING_BOIDS;
let totalEntities = STARTING_BOIDS + FOOD_COUNT;

const STRIDE_FLOATS = 6; // vec2(2) + vec2(2) + f32(1) + pad(1)
const PACK_OFFSET = 4;

// Keep data locally to manage spawns. 
// However, since simulation updates positions on GPU, our local copy gets stale instantly.
// We only use this local copy when RE-UPLOADING everything (e.g. after a collision).
// Actually, `checkCollisions` will READ from GPU, Update logic, then WRITE back.
// If we write back, we overwrite GPU simulation for that frame, which is fine.

async function initGame() {
    const success = await engine.init();
    if (!success) return;

    resetGame();

    // Hook Input
    canvas.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
        engine.setParams({ mousePos: [x, y] });
    });

    document.getElementById('start-btn').addEventListener('click', () => {
        document.getElementById('intro').style.display = 'none';
        engine.start();
        gameLoop();
    });
}

function resetGame() {
    playerBoids = STARTING_BOIDS;
    totalEntities = playerBoids + FOOD_COUNT;

    // Initial Spawn
    const data = new Float32Array(totalEntities * STRIDE_FLOATS);

    // Player
    for (let i = 0; i < playerBoids; i++) {
        writeBoid(data, i, 0, 0, 0);
    }
    // Food
    for (let i = 0; i < FOOD_COUNT; i++) {
        writeBoid(data, playerBoids + i, 1,
            (Math.random() * 2 - 1) * 0.9,
            (Math.random() * 2 - 1) * 0.9
        );
    }

    engine.setTriangleData(totalEntities, data);
    updateScore();
}

function writeBoid(data, index, packId, x, y) {
    const base = index * STRIDE_FLOATS;
    data[base + 0] = x;
    data[base + 1] = y;
    data[base + 2] = (Math.random() - 0.5) * 0.05;
    data[base + 3] = (Math.random() - 0.5) * 0.05;
    data[base + 4] = packId;
    data[base + 5] = 0;
}

function updateScore() {
    document.getElementById('count').innerText = playerBoids;
}

let lastCheck = 0;
const CHECK_INTERVAL = 100; // ms

function gameLoop() {
    if (!engine.isRunning) return;

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

    // Logic:
    // Find all Player Boids (Pack 0)
    // Find all Food Boids (Pack 1)
    // Check collisions.
    // If collision:
    //   Change Food -> Player
    //   Spawn New Food
    //   Upload NEW data.

    let changed = false;
    const players = [];
    const foods = [];

    for (let i = 0; i < totalEntities; i++) {
        const base = i * STRIDE_FLOATS;
        const packId = gpuData[base + 4];
        if (packId === 0) players.push(i);
        else if (packId === 1) foods.push(i);
    }

    // Simple N*M check (optimize if needed)
    for (const fIdx of foods) {
        const fBase = fIdx * STRIDE_FLOATS;
        const fx = gpuData[fBase + 0];
        const fy = gpuData[fBase + 1];

        for (const pIdx of players) {
            const pBase = pIdx * STRIDE_FLOATS;
            const px = gpuData[pBase + 0];
            const py = gpuData[pBase + 1];

            const dx = fx - px;
            const dy = fy - py;
            const distSq = dx * dx + dy * dy;

            // Eat threshold (0.05 is roughly triangle size)
            if (distSq < 0.005) {
                // EAT!
                gpuData[fBase + 4] = 0; // Convert to player
                // No velocity change logic for now
                changed = true;
                playerBoids++;

                // Spawn new food?
                // We need to APPEND or find a dead slot. 
                // But efficient buffer usage requires append.
                // For this MVP, let's just convert.
                // We want exponential growth? 
                // "Eat glowing bird food to grow your pack"
                // converting IS growing.

                // Spawn new food elsewhere to keep game going?
                // If we convert, we lose food. eventually no food.
                // So we should ALSO spawn a new boid (Food) at random pos.

                // Add new entity
                // This requires resizing buffer.
                // We can't resize `gpuData` in place easily if it's a view.
                // It's a Float32Array copy.
                // But `setTriangleData` handles it.
                break; // One food eaten by one player is enough
            }
        }
    }

    if (changed) {
        // If we want to add strictly new food (to replace eaten):
        // append to data.
        let newData = gpuData;
        const newFoodCount = 1; // Replenish
        const newTotal = totalEntities + newFoodCount;

        const biggerData = new Float32Array(newTotal * STRIDE_FLOATS);
        biggerData.set(gpuData);

        // Add new food at end
        writeBoid(biggerData, totalEntities, 1,
            (Math.random() * 2 - 1) * 0.9,
            (Math.random() * 2 - 1) * 0.9
        );

        totalEntities = newTotal;
        engine.setTriangleData(totalEntities, biggerData);
        updateScore();
    }
}

initGame();
