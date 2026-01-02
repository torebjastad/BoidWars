
import { BoidsEngine } from './engine.js';

const STARTING_BOIDS = 4;
const FOOD_COUNT = 50;
const MAX_CAPACITY = 2000;
const ARENA_SIZE = 4.0;
const COLOR_FADE_DURATION = 5.0; // Seconds for captured boids to fade from yellow to blue

const GAME_PARAMS = {
    // Blob Preset (Scaled x3.33 for size 0.1)
    separationDistance: 0.11,   // 0.033 * 3.33
    separationStrength: 0.051,  // Exact from preset
    alignmentDistance: 0.15,    // 0.047 * 3.33
    alignmentStrength: 0.1,     // Exact from preset
    cohesionDistance: 5.0,      // 0.3 * 3.33
    cohesionStrength: 0.009,    // Exact from preset
    triangleSize: 0.1,
    triangleCount: STARTING_BOIDS,
    colorFadeDuration: COLOR_FADE_DURATION,
};

const canvas = document.querySelector("canvas");
const engine = new BoidsEngine(canvas, GAME_PARAMS, [0, 0, 0], true);

let playerBoids = STARTING_BOIDS;
let totalEntities = STARTING_BOIDS + FOOD_COUNT;

// Update stride to 8 floats (32 bytes)
const STRIDE_FLOATS = 8;

async function initGame() {
    const success = await engine.init();
    if (!success) return;

    resetGame();

    // Hook Input
    canvas.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        let nx = (e.clientX - rect.left) / rect.width;
        let ny = (e.clientY - rect.top) / rect.height;

        // Map 0 -> -4, 1 -> 4.
        let worldX = (nx * 2 - 1) * ARENA_SIZE;
        let worldY = -(ny * 2 - 1) * ARENA_SIZE;

        engine.setParams({ mousePos: [worldX, worldY] });
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
    // Food
    for (let i = 0; i < FOOD_COUNT; i++) {
        writeBoid(data, playerBoids + i, 1,
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
    document.getElementById('count').innerText = playerBoids;
}

let lastCheck = 0;
const CHECK_INTERVAL = 100;

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

    let changed = false;
    const players = [];
    const foods = [];

    for (let i = 0; i < totalEntities; i++) {
        const base = i * STRIDE_FLOATS;
        const packId = gpuData[base + 4];
        if (packId === 0) players.push(i);
        else if (packId === 1) foods.push(i);
    }

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

            if (distSq < 0.01) {
                gpuData[fBase + 4] = 0; // Set packId to 0 (Player)
                gpuData[fBase + 5] = engine.params.time; // Set captureTime for color fade

                // Calculate pack center for outward push
                let centerX = 0, centerY = 0;
                for (const pIdx of players) {
                    const pBase = pIdx * STRIDE_FLOATS;
                    centerX += gpuData[pBase + 0];
                    centerY += gpuData[pBase + 1];
                }
                centerX /= players.length;
                centerY /= players.length;

                // Push outward from pack center to mix naturally
                const outX = fx - centerX;
                const outY = fy - centerY;
                const outLen = Math.sqrt(outX * outX + outY * outY) || 1;
                gpuData[fBase + 2] = (outX / outLen) * 0.03;
                gpuData[fBase + 3] = (outY / outLen) * 0.03;

                changed = true;
                playerBoids++;
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
}

initGame();
