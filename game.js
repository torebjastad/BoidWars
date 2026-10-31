
import { BoidsEngine, MAX_PACKS, PACK_CONTROL_FLOATS } from './engine.js';
import { FLOCK_NAMES } from './flockNames.js';
import { FlockBrain, DIFFICULTIES, PERSONALITIES } from './ai.js';
import { Hud } from './hud.js';

// ============================================================================
// GAME TUNING PARAMETERS
// See GAME_DESIGN.md for why these values and how they interact.
// ============================================================================

// Flocks
const STARTING_BOIDS = 5;           // Every flock (player and enemies) starts this size
const ENEMY_FLOCK_COUNT = 15;       // Number of enemy flocks
const CAPACITY = 6000;              // Boid slots on the GPU, shared by flocks and food

// Arena: half-size (the arena spans -size..+size). It shrinks in stages to force a showdown.
const ARENA_START = 14;
const ZONE_SCHEDULE = [             // [seconds before shrinking, seconds to shrink, new size]
    [50, 30, 9],
    [30, 30, 6],
    [25, 25, 3.5],
];
const FINAL_SECONDS = 45;           // After the last shrink: the largest flock wins when this runs out
const MIN_SPAWN_DISTANCE = 6;       // Between flock spawn points

// Food economy
const FOOD_DENSITY = 0.6;           // Target food per unit² of the current arena
const FOOD_RESPAWN_RATE = 14;       // Food per second added while below the target
const FOOD_VALUE = 0.55;            // Chance an eaten food becomes a boid (plenty of food, each worth less)
const FOOD_RADIUS = 0.3;            // Food drifts toward flock boids within this distance
const BLOOM_FIRST = 20;             // Seconds until the first food bloom
const BLOOM_INTERVAL = [15, 25];    // Seconds between blooms (random in range)
const BLOOM_FOOD = 90;              // Food per bloom
const BLOOM_RADIUS = 1.6;

// Eating
const TRUCE_SECONDS = 15;           // No flock eats or steals from another until this many seconds in
const CAPTURE_RADIUS = 0.14;        // Boids this close interact
const CONSUME_RATIO = 1.2;          // A flock needs this many times the boids of another to eat it...
const CONSUME_MARGIN = 4;           // ...and at least this many more boids (keeps early fights from being a coin flip)
const ISOLATION_RADIUS = 0.3;       // A boid with no flockmate this close is a straggler: anyone can steal it
const STEAL_IMMUNITY = 1.0;         // Seconds a newly captured boid can't be stolen back
const DIGEST_TIME = 1.0;            // Seconds before a newly captured boid can capture others
const SPILL = 0.35;                 // Share of eaten boids that burst out as food instead of joining

// Upkeep: flocks above DECAY_FREE boids shed DECAY_RATE * (size - DECAY_FREE) boids per second.
// Shed boids are thrown outward; SHED_FOOD_SHARE of them become food, the rest are gone.
const DECAY_FREE = 40;
const DECAY_RATE = 0.01;
const SHED_FOOD_SHARE = 0.5;
const SHED_SPEED = 0.05;
const SHED_GRACE = 3;               // Seconds before a flock can pick its own shed food back up

// Movement: big flocks are slower (per-step speeds, the simulation runs at 60 steps/s)
const BASE_SPEED = 0.065;           // Max speed of a SPEED_REF-sized flock
const SPEED_REF = 10;
const SPEED_EXPONENT = 0.15;        // speed ~ size^-exponent
const SPEED_MIN_MUL = 0.65;
const SPEED_MAX_MUL = 1.15;
const STEER_FORCE = 0.02;           // How hard a flock turns toward its target

// Abilities
const DASH = { speedMul: 1.7, duration: 0.6, cooldown: 4 };
// Releasing the mouse after holding it (flock pulled into a ball) shoots the boids outward;
// this speed boost makes the burst punchier. Combines with Dash.
const RELEASE_BURST = { speedMul: 1.35, duration: 0.35, minHold: 0.25 };
// Pulse, no cooldown: tap for a quick burst (at least `expand` seconds), hold to stay spread out.
// While spread, boids push out to radiusBase + radiusPerSqrt * sqrt(size); on release the flock
// snaps back together for `contract` seconds.
const PULSE = {
    expand: 0.3, contract: 0.6, spread: 0.03, steerDuringExpand: 0.5, contractCohesion: 4,
    radiusBase: 0.6, radiusPerSqrt: 0.2,
    aiInterval: 2.5,                // Enemy flocks pulse at most this often
};

// Optional organic layer on top of the boid rules (all 0 = the original swarm dynamics):
// boids aim at their own points circling the target, and flocks breathe in and out
const ORGANIC = {
    wobbleBase: 0,                  // Radius of each boid's own circling aim point (e.g. 0.25)...
    wobblePerSqrt: 0,               // ...growing with sqrt(flock size) (e.g. 0.05)
    steerJitter: 0,                 // Steering strength varies +-this between boids (e.g. 0.35)
    breathPeriod: 2.4,              // Seconds per breath (out and in)
    breathCohesion: 0,              // Cohesion swings +-this over a breath (e.g. 0.6)
    breathSpread: 0,                // Outward push at the peak of a breath (e.g. 0.006)...
    breathRadius: 1.4,              // ...out to this multiple of the flock's resting radius
};

// Mouse: 'hold' = the flock steers to the cursor only while the left button is held (release to
// burst outward); 'follow' = the flock always chases the cursor and left click dashes
const MOUSE_MODE = 'hold';

// Camera
const BASE_ZOOM = 0.5;
const MIN_ZOOM = 0.15;
const ZOOM_EXPONENT = 0.15;
const CAMERA_SMOOTHING = 0.1;

// Boid physics (tuned in the simulator; distances scale with triangleSize)
const PACK_COUNT = ENEMY_FLOCK_COUNT + 3;   // Player (0) + food (1) + enemies + a bucket for unused slots
const GAME_PARAMS = {
    separationDistance: 0.11,
    separationStrength: 0.051,
    alignmentDistance: 0.15,
    alignmentStrength: 0.1,
    cohesionDistance: 15.0,
    cohesionStrength: 0.002,
    triangleSize: 0.1,
    triangleCount: CAPACITY,
    colorFadeDuration: 0.5,
    arenaSize: ARENA_START,
    foodRadius: FOOD_RADIUS,
    captureRadius: CAPTURE_RADIUS,
    digestTime: DIGEST_TIME,
    spill: SPILL,
    foodValue: FOOD_VALUE,
    packCount: PACK_COUNT,
};

// ============================================================================

const PLAYER = 0;
const FOOD = 1;
const DEAD = -1;                    // packId of an unused slot
const STRIDE = 8;                   // Floats per boid: x, y, vx, vy, packId, captureTime, prevPackId, inertUntil
const CHECK_INTERVAL = 0.1;         // Sim seconds between game-logic passes

const urlParams = new URLSearchParams(location.search);

const canvas = document.getElementById('canvas');
const engine = new BoidsEngine(canvas, GAME_PARAMS, [0, 0, 0], true);
engine.timeScale = Number(urlParams.get('speed')) || 1;   // Debug: ?speed=4
const hud = new Hud(document.getElementById('hud'), { arenaStart: ARENA_START });

let difficultyKey = DIFFICULTIES[urlParams.get('difficulty')] ? urlParams.get('difficulty') : 'normal';
const autopilot = urlParams.has('autopilot');              // Debug: AI plays the player's flock

let flocks = [];
let game = null;
let gameId = 0;
let checkInFlight = false;

let cameraX = 0, cameraY = 0, cameraZoom = BASE_ZOOM, targetZoom = BASE_ZOOM;
let mouseScreen = { x: 0.5, y: 0.5 };
let mouseHeld = false;
const packControls = new Float32Array(MAX_PACKS * PACK_CONTROL_FLOATS);
const packControlBits = new Uint32Array(packControls.buffer);

// ----------------------------------------------------------------------------
// Rules helpers
// ----------------------------------------------------------------------------

function canEat(attackerCount, defenderCount) {
    return attackerCount >= defenderCount * CONSUME_RATIO && attackerCount >= defenderCount + CONSUME_MARGIN;
}

function speedFor(count) {
    const mul = Math.pow(Math.max(count, 1) / SPEED_REF, -SPEED_EXPONENT);
    return BASE_SPEED * Math.min(SPEED_MAX_MUL, Math.max(SPEED_MIN_MUL, mul));
}

function gameTime() {
    return engine.simTime - game.startSim;
}

// Arena half-size at game time t, plus what the HUD needs to announce
function zoneAt(t) {
    let t0 = 0;
    let size = ARENA_START;
    for (const [hold, shrink, next] of ZONE_SCHEDULE) {
        if (t < t0 + hold) return { size, shrinking: false, changeIn: t0 + hold - t, next };
        if (t < t0 + hold + shrink) {
            const f = (t - t0 - hold) / shrink;
            return { size: size + (next - size) * f, shrinking: true, changeIn: t0 + hold + shrink - t, next };
        }
        t0 += hold + shrink;
        size = next;
    }
    return { size, shrinking: false, changeIn: Infinity, next: size, final: true, endsIn: Math.max(0, t0 + FINAL_SECONDS - t) };
}

function randomInZone(margin) {
    const m = game.zone.size - margin;
    return [(Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m];
}

// ----------------------------------------------------------------------------
// Flock colors (match the render shader)
// ----------------------------------------------------------------------------

export function getFlockColors(packId) {
    if (packId === PLAYER) return { line: '#ffffff', fill: '#33ccff' };
    if (packId === FOOD) return { line: '#ffcc33', fill: '#ffcc33' };
    const enemyIndex = packId - 2;
    const hue1 = ((enemyIndex * 0.13) % 1) * 360;
    const hue2 = ((enemyIndex * 0.13 + 0.5) % 1) * 360;
    return { line: `hsl(${hue1}, 90%, 65%)`, fill: `hsl(${hue2}, 80%, 45%)` };
}

// ----------------------------------------------------------------------------
// Setup
// ----------------------------------------------------------------------------

function createFlocks() {
    const difficulty = DIFFICULTIES[difficultyKey];
    const result = [];
    for (let i = 0; i <= ENEMY_FLOCK_COUNT; i++) {
        const isPlayer = i === 0;
        const brain = (!isPlayer || autopilot)
            ? new FlockBrain(isPlayer ? PERSONALITIES[2] : PERSONALITIES[i % PERSONALITIES.length],
                isPlayer ? DIFFICULTIES.hard : difficulty)
            : null;
        result.push({
            packId: isPlayer ? PLAYER : i + 1,
            name: (isPlayer ? FLOCK_NAMES[0] : FLOCK_NAMES[i % FLOCK_NAMES.length]).split(' ')[0],
            isPlayer,
            brain,
            count: STARTING_BOIDS,
            alive: true,
            // Snapshot summary (updated every check)
            x: 0, y: 0, vx: 0, vy: 0, radius: 0.3, speed: speedFor(STARTING_BOIDS) * 60, seenAt: 0,
            // Abilities (game time)
            dashUntil: -1, dashReady: 0, burstUntil: -1, pulseStart: -10, pulseEnd: -10, pulseHeld: false,
            breathPhase: Math.random() * Math.PI * 2,
            shedAccumulator: 0,
            lastHitBy: -1,
            placement: 0,
        });
    }
    return result;
}

function spawnPoints(n) {
    const points = [];
    const m = ARENA_START - 2;
    for (let i = 0; i < n; i++) {
        let best = null, bestMin = -1;
        for (let attempt = 0; attempt < 200; attempt++) {
            const x = (Math.random() * 2 - 1) * m, y = (Math.random() * 2 - 1) * m;
            const minDist = points.reduce((acc, [px, py]) => Math.min(acc, Math.hypot(x - px, y - py)), Infinity);
            if (minDist >= MIN_SPAWN_DISTANCE) { best = [x, y]; break; }
            if (minDist > bestMin) { bestMin = minDist; best = [x, y]; }
        }
        points.push(best);
    }
    return points;
}

function writeBoid(data, index, packId, x, y, speed = 0.025) {
    const base = index * STRIDE;
    const a = Math.random() * Math.PI * 2;
    data[base + 0] = x;
    data[base + 1] = y;
    data[base + 2] = Math.cos(a) * speed;
    data[base + 3] = Math.sin(a) * speed;
    data[base + 4] = packId;
    data[base + 5] = 0;
    data[base + 6] = packId;
    data[base + 7] = 0;
}

function resetGame() {
    gameId++;
    flocks = createFlocks();
    game = {
        phase: 'playing',
        startSim: engine.simTime,
        zone: zoneAt(0),
        lastCheck: 0,
        lastSnapshot: 0,
        lastSnapshotSim: engine.simTime,
        foodCount: 0,
        foodSpawnAccumulator: 0,
        nextBloomAt: BLOOM_FIRST,
        blooms: [],
        foodGrid: null,
        peak: STARTING_BOIDS,
        kills: 0,
        eaten: 0,
        lastLeaderboard: 0,
    };

    const data = new Float32Array(CAPACITY * STRIDE);
    let slot = 0;
    const points = spawnPoints(flocks.length);
    flocks.forEach((flock, i) => {
        const [sx, sy] = points[i];
        flock.x = sx; flock.y = sy;
        if (flock.brain) flock.brain.target = { x: sx, y: sy };
        for (let k = 0; k < flock.count; k++) {
            writeBoid(data, slot++, flock.packId, sx + (Math.random() - 0.5) * 0.6, sy + (Math.random() - 0.5) * 0.6);
        }
    });
    const startFood = Math.round(FOOD_DENSITY * (2 * ARENA_START) ** 2);
    for (let k = 0; k < startFood; k++) {
        const [x, y] = randomInZone(0.3);
        writeBoid(data, slot++, FOOD, x, y, 0.005);
    }
    game.foodCount = startFood;
    // Unused slots, scattered so they don't all land in one grid cell
    while (slot < CAPACITY) {
        writeBoid(data, slot++, DEAD, (Math.random() * 2 - 1) * ARENA_START, (Math.random() * 2 - 1) * ARENA_START, 0);
    }

    engine.setParams({ arenaSize: ARENA_START });
    engine.setTriangleData(CAPACITY, data);

    const player = flocks[0];
    cameraX = player.x; cameraY = player.y;
    cameraZoom = targetZoom = BASE_ZOOM;
    hud.reset();
    updateLeaderboard();
}

// ----------------------------------------------------------------------------
// Input
// ----------------------------------------------------------------------------

function isUiTarget(e) {
    return e.target.closest && e.target.closest('button, .instructions');
}

window.addEventListener('mousemove', e => {
    mouseScreen = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
});
let mouseHeldSince = 0;
window.addEventListener('mousedown', e => {
    if (isUiTarget(e) || !game || game.phase !== 'playing') return;
    if (e.button === 0) {
        mouseHeld = true;
        mouseHeldSince = gameTime();
        if (MOUSE_MODE === 'follow') useAbility(flocks[0], 'dash');
    } else if (e.button === 2) {
        useAbility(flocks[0], 'dash');
    }
});
window.addEventListener('mouseup', e => {
    if (e.button !== 0 || !mouseHeld) return;
    mouseHeld = false;
    // Let go after pulling the flock together: burst outward
    const player = flocks[0];
    if (MOUSE_MODE === 'hold' && player && game.phase === 'playing' && gameTime() - mouseHeldSince >= RELEASE_BURST.minHold) {
        player.burstUntil = gameTime() + RELEASE_BURST.duration;
    }
});
window.addEventListener('contextmenu', e => e.preventDefault());
window.addEventListener('blur', () => {
    mouseHeld = false;
    if (flocks[0]) releasePulse(flocks[0]);
});

const isSpace = e => e.code === 'Space' || e.key === ' ';
document.addEventListener('keydown', e => {
    if (e.code === 'KeyR' || e.key === 'r' || e.key === 'R') { restartGame(); return; }
    if (!game || game.phase !== 'playing') return;
    if (isSpace(e)) {
        e.preventDefault();
        if (!e.repeat) startPulse(flocks[0], true);
    } else if (e.key === 'Shift') {
        useAbility(flocks[0], 'dash');
    }
});
document.addEventListener('keyup', e => {
    if (isSpace(e) && flocks[0]) releasePulse(flocks[0]);
});

function mouseWorld() {
    const aspect = canvas.width / canvas.height;
    const ndcX = mouseScreen.x * 2 - 1;
    const ndcY = -(mouseScreen.y * 2 - 1);
    return { x: ndcX * aspect / cameraZoom + cameraX, y: ndcY / cameraZoom + cameraY };
}

function useAbility(flock, ability) {
    if (!flock.alive) return false;
    const t = gameTime();
    if (ability === 'dash' && t >= flock.dashReady) {
        flock.dashUntil = t + DASH.duration;
        flock.dashReady = t + DASH.cooldown;
        return true;
    }
    if (ability === 'pulse') {
        startPulse(flock, false);
        return true;
    }
    return false;
}

// held: stay spread until releasePulse; otherwise a single quick burst
function startPulse(flock, held) {
    if (!flock.alive) return;
    const t = gameTime();
    flock.pulseStart = t;
    flock.pulseHeld = held;
    flock.pulseEnd = held ? Infinity : t + PULSE.expand;
}

function releasePulse(flock) {
    if (!flock.pulseHeld) return;
    flock.pulseHeld = false;
    flock.pulseEnd = Math.max(gameTime(), flock.pulseStart + PULSE.expand);
}

// ----------------------------------------------------------------------------
// Per-frame: steering, camera, HUD
// ----------------------------------------------------------------------------

function worldForAi(t) {
    return {
        flocks: flocks.filter(f => f.alive),
        canEat: t < TRUCE_SECONDS - 4 ? () => false : canEat,   // AI gets ready just before the truce ends
        zone: game.zone.size,
        food: game.foodGrid,
        blooms: game.blooms,
    };
}

function updateControls(t) {
    const difficulty = DIFFICULTIES[difficultyKey];
    const world = game.foodGrid ? worldForAi(t) : null;
    const aim = mouseWorld();
    packControls.fill(0);

    for (const flock of flocks) {
        if (!flock.alive) continue;
        let target, steer;
        if (flock.brain) {
            if (world) {
                flock.brain.update(flock, world, t);
                if (flock.brain.wantDash) { useAbility(flock, 'dash'); flock.brain.wantDash = false; }
                if (flock.brain.wantPulse) {
                    if (t - flock.pulseStart > PULSE.aiInterval) useAbility(flock, 'pulse');
                    flock.brain.wantPulse = false;
                }
            }
            target = flock.brain.target;
            steer = STEER_FORCE * (flock.isPlayer ? 1 : difficulty.steer);
        } else {
            target = aim;
            steer = (MOUSE_MODE === 'follow' || mouseHeld) ? STEER_FORCE : 0;
        }

        // Breathing: cohesion eases off and a gentle outward push builds on the out-breath
        const sqrtCount = Math.sqrt(flock.count);
        const restRadius = 0.15 + 0.07 * sqrtCount;
        const breath = Math.sin((2 * Math.PI * t) / ORGANIC.breathPeriod + flock.breathPhase);
        let cohesionScale = 1 - ORGANIC.breathCohesion * breath;
        let spread = Math.max(0, breath) * ORGANIC.breathSpread;
        let spreadRadius = restRadius * ORGANIC.breathRadius;

        // Pulse overrides breathing
        if (t >= flock.pulseStart && t < flock.pulseEnd) {
            cohesionScale = 0;
            spread = PULSE.spread;
            spreadRadius = PULSE.radiusBase + PULSE.radiusPerSqrt * sqrtCount;
            steer *= PULSE.steerDuringExpand;
        } else if (t >= flock.pulseEnd && t < flock.pulseEnd + PULSE.contract) {
            cohesionScale = PULSE.contractCohesion;
            spread = 0;
        }

        const maxSpeed = speedFor(flock.count)
            * (t < flock.dashUntil ? DASH.speedMul : 1)
            * (t < flock.burstUntil ? RELEASE_BURST.speedMul : 1);
        const o = flock.packId * PACK_CONTROL_FLOATS;
        packControls[o + 0] = target.x;
        packControls[o + 1] = target.y;
        packControls[o + 2] = steer;
        packControls[o + 3] = maxSpeed;
        packControls[o + 4] = cohesionScale;
        packControls[o + 5] = spread;
        // Which packs can eat this one (the GPU converts boids on contact)
        let eatenBy = 0;
        for (const other of flocks) {
            if (t < TRUCE_SECONDS) break;
            if (other.alive && other !== flock && canEat(other.count, flock.count)) eatenBy |= 1 << other.packId;
        }
        packControlBits[o + 6] = eatenBy;
        packControls[o + 7] = ORGANIC.wobbleBase + ORGANIC.wobblePerSqrt * sqrtCount;
        packControls[o + 8] = spreadRadius;
        packControls[o + 9] = ORGANIC.steerJitter;
    }
    engine.setPackControls(packControls);
}

// Flock position extrapolated from the last snapshot
function estimatePosition(flock, t) {
    const dt = Math.min(0.3, Math.max(0, t - flock.seenAt));
    return { x: flock.x + flock.vx * dt, y: flock.y + flock.vy * dt };
}

function updateCamera(t) {
    const player = flocks[0];
    if (player.alive) {
        const p = estimatePosition(player, t);
        cameraX += (p.x - cameraX) * CAMERA_SMOOTHING;
        cameraY += (p.y - cameraY) * CAMERA_SMOOTHING;
        targetZoom = Math.max(MIN_ZOOM, BASE_ZOOM / Math.pow(player.count, ZOOM_EXPONENT));
    }
    cameraZoom += (targetZoom - cameraZoom) * CAMERA_SMOOTHING;
    engine.setParams({
        cameraPos: [cameraX, cameraY],
        cameraZoom,
        arenaSize: game.zone.size,
    });
}

function drawHud(t) {
    const player = flocks[0];
    hud.draw({
        t,
        camera: { x: cameraX, y: cameraY, zoom: cameraZoom },
        aspect: canvas.width / canvas.height,
        player: player.alive ? { ...player, ...estimatePosition(player, t) } : null,
        flocks: flocks.filter(f => f.alive && !f.isPlayer).map(f => ({
            ...f,
            ...estimatePosition(f, t),
            color: getFlockColors(f.packId).line,
            relation: !player.alive ? 'neutral'
                : canEat(player.count, f.count) ? 'prey'
                : canEat(f.count, player.count) ? 'threat' : 'neutral',
        })),
        zone: game.zone,
        truceLeft: Math.max(0, TRUCE_SECONDS - t),
        blooms: game.blooms,
        abilities: {
            pulse: { ready: true, frac: 1, active: t >= player.pulseStart && t < player.pulseEnd },
            dash: { ready: player.dashReady - t <= 0, frac: 1 - Math.max(0, player.dashReady - t) / DASH.cooldown, active: t < player.dashUntil },
        },
    });
}

// The world keeps running after the game ends, behind the end dialog
function gameLoop() {
    if (!engine.isRunning) return;
    tick();
    requestAnimationFrame(gameLoop);
}

function tick() {
    const t = gameTime();
    game.zone = zoneAt(t);
    updateControls(t);
    updateCamera(t);
    drawHud(t);
    if (!checkInFlight && t - game.lastCheck >= CHECK_INTERVAL) {
        game.lastCheck = t;
        runCheck();
    }
}

// ----------------------------------------------------------------------------
// Game logic pass (every CHECK_INTERVAL): read boids back, apply rules, patch changes
// ----------------------------------------------------------------------------

const HASH_CELL = 0.3;
const HASH_HALF = ARENA_START + 1;
const HASH_DIM = Math.ceil((2 * HASH_HALF) / HASH_CELL);
const hashHead = new Int32Array(HASH_DIM * HASH_DIM);
const hashNext = new Int32Array(CAPACITY);
const packOf = new Int16Array(CAPACITY);
const ownNear = new Uint8Array(CAPACITY);
const converted = new Uint8Array(CAPACITY);

const FOOD_GRID_CELL = 1.0;
const FOOD_GRID_DIM = Math.ceil((2 * ARENA_START) / FOOD_GRID_CELL);

function hashCell(x, y) {
    const cx = Math.min(HASH_DIM - 1, Math.max(0, Math.floor((x + HASH_HALF) / HASH_CELL)));
    const cy = Math.min(HASH_DIM - 1, Math.max(0, Math.floor((y + HASH_HALF) / HASH_CELL)));
    return [cx, cy];
}

async function runCheck() {
    checkInFlight = true;
    const myGame = gameId;
    try {
        const data = await engine.readData();
        if (!data || myGame !== gameId) return;
        applyRules(data, engine.lastReadSimTime - game.startSim, engine.lastReadSimTime);
    } finally {
        checkInFlight = false;
    }
}

function applyRules(data, t, simNow) {
    const dt = Math.max(0, t - game.lastSnapshot);
    game.lastSnapshot = t;

    // --- Parse snapshot ---
    const members = new Map(flocks.map(f => [f.packId, []]));
    const freeSlots = [];
    let foodCount = 0;
    hashHead.fill(-1);
    for (let i = 0; i < CAPACITY; i++) {
        const base = i * STRIDE;
        const pack = Math.round(data[base + 4]);
        packOf[i] = pack;
        converted[i] = 0;
        if (pack === DEAD) { freeSlots.push(i); continue; }
        if (pack === FOOD) {
            foodCount++;
        } else {
            members.get(pack)?.push(i);
            // Captured on the GPU since the last snapshot: credit the capturing flock
            const prev = Math.round(data[base + 6]);
            if (data[base + 5] > game.lastSnapshotSim && prev !== pack && prev !== FOOD && prev !== DEAD) {
                const victim = flocks.find(f => f.packId === prev);
                if (victim) victim.lastHitBy = pack;
                if (pack === PLAYER) game.eaten++;
            }
        }
        const [cx, cy] = hashCell(data[base], data[base + 1]);
        const h = cy * HASH_DIM + cx;
        hashNext[i] = hashHead[h];
        hashHead[h] = i;
    }

    // --- Flock summaries ---
    for (const flock of flocks) {
        const list = members.get(flock.packId);
        flock.count = list.length;
        if (!flock.alive) continue;
        if (list.length === 0) { eliminate(flock, t); continue; }
        // Center, velocity and size of the main body: one pass over all boids, then a second
        // pass that ignores far-off stragglers so they don't drag the center away
        const n = list.length;
        let sx = 0, sy = 0;
        for (const i of list) { sx += data[i * STRIDE]; sy += data[i * STRIDE + 1]; }
        let cx = sx / n, cy = sy / n;
        let r2 = 0;
        for (const i of list) r2 += (data[i * STRIDE] - cx) ** 2 + (data[i * STRIDE + 1] - cy) ** 2;
        const keep2 = Math.max(1, 4 * r2 / n);
        let m = 0, svx = 0, svy = 0;
        sx = 0; sy = 0;
        for (const i of list) {
            const b = i * STRIDE;
            if ((data[b] - cx) ** 2 + (data[b + 1] - cy) ** 2 > keep2) continue;
            sx += data[b]; sy += data[b + 1]; svx += data[b + 2]; svy += data[b + 3]; m++;
        }
        cx = sx / m; cy = sy / m;
        r2 = 0;
        for (const i of list) {
            const d2 = (data[i * STRIDE] - cx) ** 2 + (data[i * STRIDE + 1] - cy) ** 2;
            if (d2 <= keep2) r2 += d2;
        }
        flock.x = cx; flock.y = cy;
        flock.vx = (svx / m) * 60; flock.vy = (svy / m) * 60;
        flock.radius = Math.sqrt(r2 / m) * 1.4 + 0.15;
        flock.speed = speedFor(n) * 60;
        flock.seenAt = t;
    }
    game.lastSnapshotSim = simNow;
    const flockById = new Map(flocks.map(f => [f.packId, f]));

    // --- Who is a straggler: flock boids with no flockmate within ISOLATION_RADIUS ---
    const iso2 = ISOLATION_RADIUS * ISOLATION_RADIUS;
    const cap2 = CAPTURE_RADIUS * CAPTURE_RADIUS;
    const forNeighbors = (i, fn) => {
        const [cx, cy] = hashCell(data[i * STRIDE], data[i * STRIDE + 1]);
        for (let y = Math.max(0, cy - 1); y <= Math.min(HASH_DIM - 1, cy + 1); y++) {
            for (let x = Math.max(0, cx - 1); x <= Math.min(HASH_DIM - 1, cx + 1); x++) {
                for (let j = hashHead[y * HASH_DIM + x]; j !== -1; j = hashNext[j]) {
                    if (j !== i) fn(j);
                }
            }
        }
    };
    const dist2 = (i, j) => {
        const dx = data[i * STRIDE] - data[j * STRIDE], dy = data[i * STRIDE + 1] - data[j * STRIDE + 1];
        return dx * dx + dy * dy;
    };
    for (const [pack, list] of members) {
        for (const i of list) {
            ownNear[i] = 0;
            forNeighbors(i, j => { if (packOf[j] === pack && !ownNear[i] && dist2(i, j) < iso2) ownNear[i] = 1; });
        }
    }

    // --- Stragglers: a lone boid touched by a boid of another flock that is in formation gets
    // stolen, whatever the sizes. (Eating food and smaller flocks happens on the GPU every step.)
    const convert = (i, toPack) => {
        const b = i * STRIDE;
        const from = packOf[i];
        const to = flockById.get(toPack);
        // Push the new member outward from its new flock's center so it slots in
        const ox = data[b] - to.x, oy = data[b + 1] - to.y;
        const len = Math.hypot(ox, oy) || 1;
        engine.patchBoid(i, 2, [(ox / len) * 0.03, (oy / len) * 0.03, toPack, simNow, from, 0]);
        converted[i] = 1;
        data[b + 4] = toPack;
        to.count++;
        const fromFlock = flockById.get(from);
        fromFlock.count--;
        fromFlock.lastHitBy = toPack;
        if (toPack === PLAYER) game.eaten++;
    };

    for (const [pack, list] of members) {
        if (t < TRUCE_SECONDS) break;
        for (const i of list) {
            if (converted[i] || ownNear[i] || data[i * STRIDE + 5] > simNow - STEAL_IMMUNITY) continue;
            let stealer = -1;
            forNeighbors(i, j => {
                const pj = packOf[j];
                if (stealer !== -1 || converted[j] || pj === pack || pj === FOOD || pj === DEAD || !ownNear[j]) return;
                if (dist2(i, j) < cap2) stealer = pj;
            });
            if (stealer !== -1) convert(i, stealer);
        }
    }

    // --- Upkeep: big flocks shed their outermost boids as food ---
    for (const flock of flocks) {
        if (!flock.alive || flock.count <= DECAY_FREE) { flock.shedAccumulator = 0; continue; }
        flock.shedAccumulator += DECAY_RATE * (flock.count - DECAY_FREE) * dt;
        const shed = Math.floor(flock.shedAccumulator);
        if (shed <= 0) continue;
        flock.shedAccumulator -= shed;
        const list = members.get(flock.packId)
            .filter(i => !converted[i])
            .map(i => [i, (data[i * STRIDE] - flock.x) ** 2 + (data[i * STRIDE + 1] - flock.y) ** 2])
            .sort((a, b) => b[1] - a[1]);
        for (let k = 0; k < Math.min(shed, list.length - 1); k++) {
            const i = list[k][0];
            const b = i * STRIDE;
            converted[i] = 1;
            flock.count--;
            if (Math.random() < SHED_FOOD_SHARE) {
                const ox = data[b] - flock.x, oy = data[b + 1] - flock.y;
                const len = Math.hypot(ox, oy) || 1;
                engine.patchBoid(i, 2, [ox / len * SHED_SPEED, oy / len * SHED_SPEED, FOOD, simNow, flock.packId, simNow + SHED_GRACE]);
                data[b + 4] = FOOD;
                foodCount++;
            } else {
                engine.patchBoid(i, 4, [DEAD, 0, DEAD, 0]);
                data[b + 4] = DEAD;
                freeSlots.push(i);
            }
        }
    }

    // --- Shrinking arena: food stuck on the moving wall respawns inside ---
    if (game.zone.shrinking) {
        const edge = game.zone.size - 0.05;
        for (let i = 0; i < CAPACITY; i++) {
            if (data[i * STRIDE + 4] !== FOOD) continue;
            if (Math.abs(data[i * STRIDE]) >= edge || Math.abs(data[i * STRIDE + 1]) >= edge) {
                spawnFood(i, ...randomInZone(0.5));
            }
        }
    }

    // --- Food supply: steady respawn toward the target, plus periodic blooms ---
    const foodTarget = FOOD_DENSITY * (2 * game.zone.size) ** 2;
    game.foodSpawnAccumulator = Math.min(5, game.foodSpawnAccumulator + FOOD_RESPAWN_RATE * dt);
    while (game.foodSpawnAccumulator >= 1 && foodCount < foodTarget && freeSlots.length) {
        spawnFood(freeSlots.pop(), ...randomInZone(0.3));
        foodCount++;
        game.foodSpawnAccumulator--;
    }
    if (t >= game.nextBloomAt) {
        game.nextBloomAt = t + BLOOM_INTERVAL[0] + Math.random() * (BLOOM_INTERVAL[1] - BLOOM_INTERVAL[0]);
        const [bx, by] = randomInZone(2);
        let placed = 0;
        for (; placed < BLOOM_FOOD && freeSlots.length; placed++) {
            const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * BLOOM_RADIUS;
            spawnFood(freeSlots.pop(), bx + Math.cos(a) * r, by + Math.sin(a) * r);
        }
        foodCount += placed;
        if (placed > 0) {
            game.blooms.push({ x: bx, y: by, food: placed, startedAt: t });
            hud.addEvent('A food bloom appeared!', '#ffcc33');
        }
    }
    game.foodCount = foodCount;

    // --- Food density grid for the AI, and how much food is left in each bloom ---
    const grid = new Uint16Array(FOOD_GRID_DIM * FOOD_GRID_DIM);
    for (const b of game.blooms) b.food = 0;
    for (let i = 0; i < CAPACITY; i++) {
        if (data[i * STRIDE + 4] !== FOOD) continue;
        const x = data[i * STRIDE], y = data[i * STRIDE + 1];
        const cx = Math.min(FOOD_GRID_DIM - 1, Math.max(0, Math.floor((x + ARENA_START) / FOOD_GRID_CELL)));
        const cy = Math.min(FOOD_GRID_DIM - 1, Math.max(0, Math.floor((y + ARENA_START) / FOOD_GRID_CELL)));
        grid[cy * FOOD_GRID_DIM + cx]++;
        for (const b of game.blooms) {
            if ((x - b.x) ** 2 + (y - b.y) ** 2 < (BLOOM_RADIUS + 0.6) ** 2) b.food++;
        }
    }
    game.blooms = game.blooms.filter(b => b.food >= 8 && t - b.startedAt < 40);
    game.foodGrid = { cell: FOOD_GRID_CELL, half: ARENA_START, dim: FOOD_GRID_DIM, counts: grid };

    // --- Eliminations and end of game ---
    for (const flock of flocks) {
        if (flock.alive && flock.count <= 0) eliminate(flock, t);
    }
    game.peak = Math.max(game.peak, flocks[0].count);
    if (game.phase === 'playing') {
        if (!flocks[0].alive) endGame('devoured', t);
        else if (flocks.every(f => f.isPlayer || !f.alive)) endGame('lastStanding', t);
        else if (game.zone.final && game.zone.endsIn <= 0) endGame('timeUp', t);
    }

    if (performance.now() - game.lastLeaderboard > 250) {
        game.lastLeaderboard = performance.now();
        updateLeaderboard();
    }
}

function spawnFood(slot, x, y) {
    const a = Math.random() * Math.PI * 2;
    engine.patchBoid(slot, 0, [x, y, Math.cos(a) * 0.005, Math.sin(a) * 0.005, FOOD, 0, FOOD, 0]);
}

function eliminate(flock, t) {
    flock.alive = false;
    flock.count = 0;
    flock.placement = flocks.filter(f => f.alive).length + 1;
    const by = flocks.find(f => f.packId === flock.lastHitBy);
    if (flock.isPlayer) {
        hud.addEvent(by ? `You were devoured by ${by.name}!` : 'Your flock is gone!', '#ff5555');
    } else if (by?.isPlayer) {
        game.kills++;
        hud.addEvent(`You devoured ${flock.name}!`, '#5dff8a');
    } else {
        hud.addEvent(by ? `${by.name} devoured ${flock.name}` : `${flock.name} vanished`, '#aaaaaa');
    }
}

// ----------------------------------------------------------------------------
// UI: leaderboard, start, end, restart
// ----------------------------------------------------------------------------

function updateLeaderboard() {
    const sorted = [...flocks].sort((a, b) => {
        if (a.alive !== b.alive) return a.alive ? -1 : 1;
        return b.count - a.count;
    });
    const player = flocks[0];
    let html = '<div class="board">';
    sorted.forEach((flock, i) => {
        const colors = getFlockColors(flock.packId);
        const dead = !flock.alive;
        let mark = '';
        if (!dead && !flock.isPlayer && player.alive) {
            if (canEat(player.count, flock.count)) mark = '<span class="tag prey">●</span>';
            else if (canEat(flock.count, player.count)) mark = '<span class="tag threat">●</span>';
        }
        const gradient = dead ? '#666, #444' : `${colors.line}, ${colors.fill}`;
        html += `<div class="row${flock.isPlayer ? ' me' : ''}${dead ? ' dead' : ''}">${i + 1}. `
            + `<span class="name" style="background:linear-gradient(90deg, ${gradient});-webkit-background-clip:text;background-clip:text;">${flock.name}</span>: `
            + `<span style="color:${dead ? '#666' : colors.line}">${flock.count}</span> ${mark}</div>`;
    });
    html += '</div>';
    document.getElementById('count').innerHTML = html;
}

function formatTime(t) {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

// reason: 'devoured' (player eliminated), 'lastStanding' (all others gone) or 'timeUp' (largest wins)
function endGame(reason, t) {
    if (game.phase !== 'playing') return;
    game.phase = 'ended';
    game.endTime = t;
    updateLeaderboard();

    const ranked = flocks.filter(f => f.alive).sort((a, b) => b.count - a.count);
    const placement = reason === 'devoured' ? flocks[0].placement : ranked.indexOf(flocks[0]) + 1;
    const victory = placement === 1;
    game.result = { reason, placement, victory };

    const title = document.getElementById('end-title');
    title.textContent = victory ? 'VICTORY!' : reason === 'timeUp' ? "TIME'S UP" : 'GAME OVER';
    title.style.color = victory ? '#4ECDC4' : reason === 'timeUp' ? '#ffb347' : '#ff4444';
    document.getElementById('end-message').textContent =
        reason === 'lastStanding' ? 'Every other flock has been devoured.'
        : reason === 'timeUp' && victory ? "Time's up, and yours is the largest flock!"
        : reason === 'timeUp' ? `Time's up. ${ranked[0].name} is the largest flock; you finished #${placement} of ${flocks.length}.`
        : `Your flock was devoured. You placed #${placement} of ${flocks.length}.`;
    document.getElementById('end-stats').innerHTML =
        `Time: <strong>${formatTime(t)}</strong> &nbsp; Peak size: <strong>${game.peak}</strong><br>`
        + `Flocks devoured: <strong>${game.kills}</strong> &nbsp; Boids taken from flocks: <strong>${game.eaten}</strong><br>`
        + `Difficulty: <strong>${DIFFICULTIES[difficultyKey].label}</strong>`;
    document.getElementById('game-end').style.display = 'block';

}

function restartGame() {
    if (!engine.device) return;
    document.getElementById('game-end').style.display = 'none';
    document.getElementById('intro').style.display = 'none';
    resetGame();
    if (!engine.isRunning) {
        engine.start();
        gameLoop();
    }
}

function selectDifficulty(key) {
    difficultyKey = key;
    document.querySelectorAll('[data-difficulty]').forEach(b => b.classList.toggle('selected', b.dataset.difficulty === key));
}

async function initGame() {
    const ok = await engine.init();
    if (!ok) return;

    document.querySelectorAll('[data-difficulty]').forEach(b => {
        b.addEventListener('click', () => selectDifficulty(b.dataset.difficulty));
    });
    selectDifficulty(difficultyKey);
    document.getElementById('start-btn').addEventListener('click', restartGame);
    document.getElementById('restart-btn').addEventListener('click', restartGame);
    document.getElementById('menu-btn').addEventListener('click', () => {
        document.getElementById('game-end').style.display = 'none';
        document.getElementById('intro').style.display = 'block';
    });

    // Debug hook for automated playtesting
    window.__game = { get flocks() { return flocks; }, get game() { return game; }, engine, restartGame, selectDifficulty, tick, useAbility, hud };

    if (urlParams.has('autostart')) restartGame();
}

initGame();
