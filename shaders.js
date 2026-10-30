
export const getCommonWGSL = (isGame) => /* wgsl */`
struct SimParams {
  separationDistance: f32,
  separationStrength: f32,
  alignmentDistance: f32,
  alignmentStrength: f32,
  cohesionDistance: f32,
  cohesionStrength: f32,
  triangleSize: f32,
  triangleCount: u32,
  // Game Params
  mousePos: vec2f,
  gameMode: u32, 
  time: f32,    
  clickState: u32,
  colorFadeDuration: f32,
  // Camera Params
  cameraPos: vec2f,
  cameraZoom: f32,
  aspectRatio: f32, // width / height
  arenaSize: f32,   // Arena boundary size
};

struct TriangleInfo {
  position: vec2f,
  velocity: vec2f,
  ${isGame ? 'packId: f32,' : ''}
  ${isGame ? 'captureTime: f32,' : ''} 
  ${isGame ? 'prevPackId: f32,' : ''}  // Previous pack for color fade 
  ${isGame ? 'padC: f32,' : ''} 
};
`;

export const getComputeWGSL = (isGame) => {
    const common = getCommonWGSL(isGame);
    return common + /* wgsl */`
// Bind definition for Compute
@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> currentTriangles: array<TriangleInfo>;
@group(0) @binding(2) var<storage, read_write> nextTriangles: array<TriangleInfo>;

// --- Spatial Grid ---
// Boids are bucketed by key = (cell, pack) with a counting sort each frame:
// gridCount -> gridScan -> gridScatter -> gridAggregate -> gridCoarse, then mainCompute.
// Fine cell size is >= every neighbor radius except cohesion, so separation, alignment
// and food sensing only need the 3x3 cells around a boid. Cohesion has a much larger
// radius, so it walks coarse blocks of coarseFactor x coarseFactor fine cells: blocks
// fully inside the radius add their position sums, blocks that straddle it drop down to
// fine cells, and only fine cells that straddle it check boids one by one. Results match
// the old brute-force loop.
struct GridParams {
  gridMin: vec2f,
  cellSize: f32,
  packCount: u32,
  dims: vec2u,
  keyCount: u32,
  coarseFactor: u32,
  coarseDims: vec2u,
  coarseKeyCount: u32,
  pad: u32,
};

@group(1) @binding(0) var<uniform> grid: GridParams;
@group(1) @binding(1) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(1) @binding(2) var<storage, read_write> cellStart: array<u32>;
@group(1) @binding(3) var<storage, read_write> boidSlot: array<vec2u>;     // (key, rank within key)
@group(1) @binding(4) var<storage, read_write> sortedIndex: array<u32>;
@group(1) @binding(5) var<storage, read_write> cellAgg: array<vec4f>;      // (sum x, sum y, count, 0): fine keys, then coarse keys
@group(1) @binding(6) var<storage, read_write> sortedBoids: array<vec4f>;  // (position, velocity) in key order

fn packIndex(t: TriangleInfo) -> u32 {
    ${isGame ? 'return min(u32(max(round(t.packId), 0.0)), grid.packCount - 1u);' : 'return 0u;'}
}

fn cellCoord(p: vec2f) -> vec2i {
    let c = vec2i(floor((p - grid.gridMin) / grid.cellSize));
    return clamp(c, vec2i(0), vec2i(grid.dims) - 1);
}

fn keyOf(c: vec2i, pack: u32) -> u32 {
    return (u32(c.y) * grid.dims.x + u32(c.x)) * grid.packCount + pack;
}

fn coarseKeyOf(c: vec2i, pack: u32) -> u32 {
    return (u32(c.y) * grid.coarseDims.x + u32(c.x)) * grid.packCount + pack;
}

// How much of cell c (side 'size', last index 'last') lies within 'radius' of p:
// 0 = none, 1 = partly, 2 = all. Edge cells also hold boids clamped in from outside
// the grid, so they are treated as unbounded and never count as fully inside.
fn cellCoverage(p: vec2f, c: vec2i, size: f32, last: vec2i, radius: f32) -> u32 {
    var lo = grid.gridMin + vec2f(c) * size;
    var hi = lo + size;
    lo = select(lo, vec2f(-1e30), c == vec2i(0));
    hi = select(hi, vec2f(1e30), c == last);
    if (distance(p, clamp(p, lo, hi)) >= radius) { return 0u; }
    if (length(max(abs(p - lo), abs(p - hi))) < radius) { return 2u; }
    return 1u;
}

@compute @workgroup_size(64)
fn gridCount(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= params.triangleCount) { return; }
    let t = currentTriangles[i];
    let key = keyOf(cellCoord(t.position), packIndex(t));
    let rank = atomicAdd(&cellCount[key], 1u);
    boidSlot[i] = vec2u(key, rank);
}

// Exclusive prefix sum of cellCount into cellStart, in a single workgroup
var<workgroup> scanPartial: array<u32, 256>;

@compute @workgroup_size(256)
fn gridScan(@builtin(local_invocation_index) li: u32) {
    let chunk = (grid.keyCount + 255u) / 256u;
    let begin = li * chunk;
    let end = min(begin + chunk, grid.keyCount);

    var sum = 0u;
    for (var k = begin; k < end; k++) {
        sum += atomicLoad(&cellCount[k]);
    }
    scanPartial[li] = sum;
    workgroupBarrier();

    for (var offset = 1u; offset < 256u; offset *= 2u) {
        var v = 0u;
        if (li >= offset) { v = scanPartial[li - offset]; }
        workgroupBarrier();
        scanPartial[li] += v;
        workgroupBarrier();
    }

    var running = scanPartial[li] - sum;
    for (var k = begin; k < end; k++) {
        cellStart[k] = running;
        running += atomicLoad(&cellCount[k]);
    }
}

@compute @workgroup_size(64)
fn gridScatter(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= params.triangleCount) { return; }
    let slot = boidSlot[i];
    let dst = cellStart[slot.x] + slot.y;
    let t = currentTriangles[i];
    sortedIndex[dst] = i;
    sortedBoids[dst] = vec4f(t.position, t.velocity);
}

@compute @workgroup_size(64)
fn gridAggregate(@builtin(global_invocation_id) gid: vec3u) {
    let k = gid.x;
    if (k >= grid.keyCount) { return; }
    let start = cellStart[k];
    let n = atomicLoad(&cellCount[k]);
    var s = vec2f(0.0, 0.0);
    for (var j = 0u; j < n; j++) {
        s += sortedBoids[start + j].xy;
    }
    cellAgg[k] = vec4f(s, f32(n), 0.0);
}

// Sum fine cell aggregates into coarse blocks (stored after the fine keys)
@compute @workgroup_size(64)
fn gridCoarse(@builtin(global_invocation_id) gid: vec3u) {
    let ck = gid.x;
    if (ck >= grid.coarseKeyCount) { return; }
    let pack = ck % grid.packCount;
    let cell = ck / grid.packCount;
    let block = vec2i(i32(cell % grid.coarseDims.x), i32(cell / grid.coarseDims.x));
    let f0 = block * i32(grid.coarseFactor);
    let f1 = min(f0 + i32(grid.coarseFactor) - 1, vec2i(grid.dims) - 1);
    var s = vec4f(0.0);
    for (var y = f0.y; y <= f1.y; y++) {
        for (var x = f0.x; x <= f1.x; x++) {
            s += cellAgg[keyOf(vec2i(x, y), pack)];
        }
    }
    cellAgg[grid.keyCount + ck] = s;
}

@compute @workgroup_size(64)
fn mainCompute(@builtin(global_invocation_id) gid: vec3u) {
    // Threads run in key order so a workgroup's boids share cells and read the same memory
    let mySlot = gid.x;
    if (mySlot >= params.triangleCount) {
        return;
    }
    let index = sortedIndex[mySlot];

    var instanceInfo = currentTriangles[index];
    
    // --- Food Physics (Pack 1) ---
    ${isGame ? `
    if (instanceInfo.packId > 0.5 && instanceInfo.packId < 1.5) {  // Only Food (packId 1)
        // Idle: small circular motion
        // Rotate velocity slightly
        let rotSpeed = 0.1;
        let c = cos(rotSpeed);
        let s = sin(rotSpeed);
        let oldV = instanceInfo.velocity;
        instanceInfo.velocity.x = oldV.x * c - oldV.y * s;
        instanceInfo.velocity.y = oldV.x * s + oldV.y * c;
        instanceInfo.velocity = normalize(instanceInfo.velocity) * 0.005; // Base drift speed

        // Attraction to Player Pack (Pack 0)
        var attraction = vec2(0.0, 0.0);
        var closePlayers = 0u;

        // Only Player or Enemy packs attract food (cellSize >= sensing radius, so 3x3 cells suffice)
        let foodCell = cellCoord(instanceInfo.position);
        for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
                let c = foodCell + vec2i(dx, dy);
                if (any(c < vec2i(0)) || any(c >= vec2i(grid.dims))) { continue; }
                for (var p = 0u; p < grid.packCount; p++) {
                    if (p == 1u) { continue; }
                    let key = keyOf(c, p);
                    let start = cellStart[key];
                    let n = atomicLoad(&cellCount[key]);
                    for (var j = 0u; j < n; j++) {
                        let otherPos = sortedBoids[start + j].xy;
                        let dist = distance(instanceInfo.position, otherPos);
                        // Sensing radius
                        if (dist < 0.8) {
                            attraction += otherPos - instanceInfo.position;
                            closePlayers++;
                        }
                    }
                }
            }
        }

        if (closePlayers > 0u) {
            // Strong pull towards player
            instanceInfo.velocity += normalize(attraction) * 0.05;
            // Match Player Speed (0.02)
            instanceInfo.velocity = normalize(instanceInfo.velocity) * 0.02; 
        }
        
        let bound = params.arenaSize;
        if (instanceInfo.position.x > bound) { instanceInfo.velocity.x = -abs(instanceInfo.velocity.x); }
        if (instanceInfo.position.x < -bound) { instanceInfo.velocity.x = abs(instanceInfo.velocity.x); }
        if (instanceInfo.position.y > bound) { instanceInfo.velocity.y = -abs(instanceInfo.velocity.y); }
        if (instanceInfo.position.y < -bound) { instanceInfo.velocity.y = abs(instanceInfo.velocity.y); }
        
        instanceInfo.position += instanceInfo.velocity;
        nextTriangles[index] = instanceInfo;
        return;
    }
    ` : ''}

    var separation = vec2(0.0, 0.0);
    var alignment = vec2(0.0, 0.0);
    var alignmentCount = 0u;
    var cohesion = vec2(0.0, 0.0);
    var cohesionCount = 0u;

    ${isGame ? 'let myPack = instanceInfo.packId;' : ''}

    let pos = instanceInfo.position;
    let myCell = cellCoord(pos);
    let myPackIdx = packIndex(instanceInfo);
    let myKey = keyOf(myCell, myPackIdx);
    let lastCell = vec2i(grid.dims) - 1;

    // Separation + alignment: own pack in the 3x3 neighboring cells
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let c = myCell + vec2i(dx, dy);
            if (any(c < vec2i(0)) || any(c > lastCell)) { continue; }
            let key = keyOf(c, myPackIdx);
            let start = cellStart[key];
            let n = atomicLoad(&cellCount[key]);
            for (var j = 0u; j < n; j++) {
                if (start + j == mySlot) { continue; }
                let other = sortedBoids[start + j];
                let dist = distance(pos, other.xy);
                if (dist < params.separationDistance) {
                    separation += pos - other.xy;
                }
                if (dist < params.alignmentDistance) {
                    alignment += other.zw;
                    alignmentCount++;
                }
            }
        }
    }

    // Cohesion: block/cell sums where fully in range, per-boid checks on the rim
    let coh = params.cohesionDistance;
    let k = i32(grid.coarseFactor);
    let blockSize = grid.cellSize * f32(k);
    let lastBlock = vec2i(grid.coarseDims) - 1;
    let myBlock = myCell / k;
    let cohRange = i32(ceil(coh / blockSize));
    let bMin = max(myBlock - vec2i(cohRange), vec2i(0));
    let bMax = min(myBlock + vec2i(cohRange), lastBlock);
    for (var by = bMin.y; by <= bMax.y; by++) {
        for (var bx = bMin.x; bx <= bMax.x; bx++) {
            let b = vec2i(bx, by);
            let blockAgg = cellAgg[grid.keyCount + coarseKeyOf(b, myPackIdx)];
            if (blockAgg.z == 0.0) { continue; }
            let blockCover = cellCoverage(pos, b, blockSize, lastBlock, coh);
            if (blockCover == 0u) { continue; }
            if (blockCover == 2u) {
                let agg = blockAgg;
                cohesion += agg.xy;
                cohesionCount += u32(agg.z);
                if (all(b == myBlock)) {
                    cohesion -= pos;
                    cohesionCount--;
                }
                continue;
            }

            let f0 = b * k;
            let f1 = min(f0 + k - 1, lastCell);
            for (var cy = f0.y; cy <= f1.y; cy++) {
                for (var cx = f0.x; cx <= f1.x; cx++) {
                    let c = vec2i(cx, cy);
                    let key = keyOf(c, myPackIdx);
                    let n = atomicLoad(&cellCount[key]);
                    if (n == 0u) { continue; }
                    let cover = cellCoverage(pos, c, grid.cellSize, lastCell, coh);
                    if (cover == 0u) { continue; }
                    if (cover == 2u) {
                        let agg = cellAgg[key];
                        cohesion += agg.xy;
                        cohesionCount += u32(agg.z);
                        if (key == myKey) {
                            cohesion -= pos;
                            cohesionCount--;
                        }
                        continue;
                    }

                    let start = cellStart[key];
                    for (var j = 0u; j < n; j++) {
                        if (start + j == mySlot) { continue; }
                        let otherPos = sortedBoids[start + j].xy;
                        if (distance(pos, otherPos) < coh) {
                            cohesion += otherPos;
                            cohesionCount++;
                        }
                    }
                }
            }
        }
    }

    if (alignmentCount > 0u) {
        alignment = alignment / f32(alignmentCount);
    }
    if (cohesionCount > 0u) {
        cohesion = (cohesion / f32(cohesionCount)) - instanceInfo.position;
    }

    var force = (separation * params.separationStrength) +
                (alignment * params.alignmentStrength) +
                (cohesion * params.cohesionStrength);
    
    // --- Game Logic: Mouse Attraction (Player Pack 0) ---
    ${isGame ? `
    if (params.gameMode == 1u && myPack < 0.5) {
        let targetPos = params.mousePos; 
        
        // Mouse Attraction
        let mouseDir = targetPos - instanceInfo.position;
        let distToMouse = length(mouseDir);
        
        // Gentle steering towards mouse ONLY IF CLICKED
        // params.clickState == 1
        if (params.clickState == 1u) {
             if (distToMouse > 0.05) { 
                // Stronger pull when active
                force += normalize(mouseDir) * 0.02; 
            }
        }
    }
    ` : `
    // Simulator mode: all boids attracted to mouse when clicked
    if (params.clickState == 1u) {
        let mouseDir = params.mousePos - instanceInfo.position;
        let distToMouse = length(mouseDir);
        if (distToMouse > 0.05) {
            force += normalize(mouseDir) * 0.02;
        }
    }
    `}

    instanceInfo.velocity += force;
    
    let maxSpeed = ${isGame ? '0.06' : '0.06'}; 
    instanceInfo.velocity = normalize(instanceInfo.velocity) * clamp(length(instanceInfo.velocity), 0.0, maxSpeed);

    // Boundary Logic
    ${isGame ? `
    let bound = params.arenaSize;
    if (instanceInfo.position.x > bound) { instanceInfo.position.x = bound; instanceInfo.velocity.x *= -1.0; }
    if (instanceInfo.position.x < -bound) { instanceInfo.position.x = -bound; instanceInfo.velocity.x *= -1.0; }
    if (instanceInfo.position.y > bound) { instanceInfo.position.y = bound; instanceInfo.velocity.y *= -1.0; }
    if (instanceInfo.position.y < -bound) { instanceInfo.position.y = -bound; instanceInfo.velocity.y *= -1.0; }
    ` : `
    // Simulator mode: larger wrap-around arena
    let bound = 5.0;
    let size = params.triangleSize;
    if (instanceInfo.position.x > bound + size) { instanceInfo.position.x = -bound - size; }
    if (instanceInfo.position.y > bound + size) { instanceInfo.position.y = -bound - size; }
    if (instanceInfo.position.x < -bound - size) { instanceInfo.position.x = bound + size; }
    if (instanceInfo.position.y < -bound - size) { instanceInfo.position.y = bound + size; }
    `}

    instanceInfo.position += instanceInfo.velocity;
    nextTriangles[index] = instanceInfo;
}
`;
};

export const getRenderWGSL = (isGame) => {
    const common = getCommonWGSL(isGame);
    return common + /* wgsl */`
// Bind definition for Render
@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> currentTriangles: array<TriangleInfo>;
@group(0) @binding(3) var<uniform> colorPalette: vec3f;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) color: vec4f,
    @location(1) uv: vec2f,
    @location(2) worldPos: vec2f,
};

fn rotate(v: vec2f, angle: f32) -> vec2f {
    let pos = vec2(
        (v.x * cos(angle)) - (v.y * sin(angle)),
        (v.x * sin(angle)) + (v.y * cos(angle))
    );
    return pos;
}

fn getRotationFromVelocity(velocity: vec2f) -> f32 {
    return -atan2(velocity.x, velocity.y);
}

${isGame ? `
// Generate color from hue (0-1 range)
fn hueToRGB(h: f32) -> vec3f {
    let r = abs(h * 6.0 - 3.0) - 1.0;
    let g = 2.0 - abs(h * 6.0 - 2.0);
    let b = 2.0 - abs(h * 6.0 - 4.0);
    return clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0));
}

// Get dual flock colors: returns line color (x=0) or fill color (x=1)
fn getFlockLineColor(packId: f32) -> vec4f {
    if (packId < 0.5) { return vec4(1.0, 1.0, 1.0, 1.0); } // Player - white line
    if (packId < 1.5) { return vec4(1.0, 0.8, 0.2, 1.0); } // Food - yellow
    // Enemy flocks: primary hue
    let enemyIndex = packId - 2.0;
    let hue = fract(enemyIndex * 0.13);
    let rgb = hueToRGB(hue);
    return vec4(rgb * 0.9 + 0.1, 1.0);
}

fn getFlockFillColor(packId: f32) -> vec4f {
    if (packId < 0.5) { return vec4(0.2, 0.8, 1.0, 1.0); } // Player - blue fill
    if (packId < 1.5) { return vec4(1.0, 0.8, 0.2, 1.0); } // Food - yellow
    // Enemy flocks: complementary hue for fill
    let enemyIndex = packId - 2.0;
    let hue = fract(enemyIndex * 0.13 + 0.5);  // Offset by 0.5 for complementary
    let rgb = hueToRGB(hue);
    return vec4(rgb * 0.7 + 0.1, 1.0);  // Slightly darker
}
` : ''}

@vertex
fn mainVert(@builtin(instance_index) ii: u32, @location(0) v: vec2f) -> VertexOutput {
    let instanceInfo = currentTriangles[ii];
    let angle = getRotationFromVelocity(instanceInfo.velocity);
    
    // No pulsing, constant size
    var scale = 1.0;
    
    let rotated = rotate(v * scale, angle);
    let worldPos = instanceInfo.position + rotated;
    
    var pos = vec4(worldPos, 0.0, 1.0);
    
    ${isGame ? `
    // Camera transform: center on cameraPos, apply zoom, correct aspect ratio
    pos.x = (worldPos.x - params.cameraPos.x) * params.cameraZoom / params.aspectRatio;
    pos.y = (worldPos.y - params.cameraPos.y) * params.cameraZoom;
    ` : `
    // Simulator mode: simple zoom (no camera pan)
    pos.x = worldPos.x * params.cameraZoom / params.aspectRatio;
    pos.y = worldPos.y * params.cameraZoom;
    `}

    // Check for uniform color mode (all palette values are 0)
    var baseColor: vec4f;
    if (colorPalette.r < 0.01 && colorPalette.g < 0.01 && colorPalette.b < 0.01) {
        // Uniform color - nice blue gradient (similar to game player)
        let normalizedY = (v.y + params.triangleSize * 0.5) / (params.triangleSize * 1.5);
        let tipColor = vec4(0.9, 0.95, 1.0, 1.0);    // White tip
        let bodyColor = vec4(0.2, 0.5, 0.9, 1.0);    // Blue body
        baseColor = mix(bodyColor, tipColor, normalizedY);
    } else {
        // Direction-based coloring
        baseColor = vec4(
            sin(angle + colorPalette.r) * 0.45 + 0.45,
            sin(angle + colorPalette.g) * 0.45 + 0.45,
            sin(angle + colorPalette.b) * 0.45 + 0.45,
            1.0
        );
    }

    ${isGame ? `
    let foodColor = vec4(1.0, 0.8, 0.2, 1.0);    // Yellow (packId 1)
    
    // Get dual colors for current and previous pack
    var targetLineColor = getFlockLineColor(instanceInfo.packId);
    var targetFillColor = getFlockFillColor(instanceInfo.packId);
    var fromLineColor = getFlockLineColor(instanceInfo.prevPackId);
    var fromFillColor = getFlockFillColor(instanceInfo.prevPackId);
    
    if (instanceInfo.prevPackId < 0.1 && instanceInfo.captureTime == 0.0) {
        fromLineColor = foodColor;
        fromFillColor = foodColor;
    }
    
    // Edge detection: normalize v.y from triangle coords
    // Triangle: tip at y=size, base at y=-size/2
    // Normalize to 0-1 range where 1=tip, 0=base
    let normalizedY = (v.y + params.triangleSize * 0.5) / (params.triangleSize * 1.5);
    let edgeFactor = smoothstep(0.3, 0.8, normalizedY);
    
    if (instanceInfo.packId > 0.5 && instanceInfo.packId < 1.5) {
        // Food (packId 1) - single yellow color
        baseColor = foodColor;
    } else if (instanceInfo.captureTime > 0.0 && instanceInfo.packId != instanceInfo.prevPackId) {
        // Fading between packs
        let elapsed = params.time - instanceInfo.captureTime;
        let t = clamp(elapsed / params.colorFadeDuration, 0.0, 1.0);
        let lineColor = mix(fromLineColor, targetLineColor, t);
        let fillColor = mix(fromFillColor, targetFillColor, t);
        baseColor = mix(fillColor, lineColor, edgeFactor);
    } else {
        // Normal dual-color rendering for all flocks (player and enemies)
        baseColor = mix(targetFillColor, targetLineColor, edgeFactor);
    }
    ` : ''}

    return VertexOutput(pos, baseColor, v, worldPos); 
}

@fragment
fn mainFrag(@location(0) color: vec4f, @location(1) uv: vec2f, @location(2) worldPos: vec2f) -> @location(0) vec4f {
    return color;
}
`;
};

// Arena border shader - draws the arena boundary as thick walls
export const getArenaBorderWGSL = () => /* wgsl */`
struct BorderParams {
  cameraPos: vec2f,
  cameraZoom: f32,
  arenaSize: f32,
  borderThickness: f32,
  aspectRatio: f32,
};

@group(0) @binding(0) var<uniform> params: BorderParams;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) color: vec4f,
};

@vertex
fn borderVert(@builtin(vertex_index) vi: u32) -> VertexOutput {
    let arena = params.arenaSize;
    let t = params.borderThickness;
    
    // 24 vertices for 4 wall quads (6 vertices per quad, 2 triangles each)
    // Each wall is a rectangle from the arena edge outward
    var vertices = array<vec2f, 24>(
        // Bottom wall (2 triangles)
        vec2f(-arena - t, -arena - t), vec2f( arena + t, -arena - t), vec2f( arena + t, -arena),
        vec2f(-arena - t, -arena - t), vec2f( arena + t, -arena),     vec2f(-arena - t, -arena),
        // Top wall
        vec2f(-arena - t,  arena),     vec2f( arena + t,  arena),     vec2f( arena + t,  arena + t),
        vec2f(-arena - t,  arena),     vec2f( arena + t,  arena + t), vec2f(-arena - t,  arena + t),
        // Left wall
        vec2f(-arena - t, -arena),     vec2f(-arena, -arena),         vec2f(-arena,  arena),
        vec2f(-arena - t, -arena),     vec2f(-arena,  arena),         vec2f(-arena - t,  arena),
        // Right wall
        vec2f( arena, -arena),         vec2f( arena + t, -arena),     vec2f( arena + t,  arena),
        vec2f( arena, -arena),         vec2f( arena + t,  arena),     vec2f( arena,  arena)
    );
    
    let worldPos = vertices[vi];
    
    // Apply camera transform with aspect ratio correction
    var pos = vec4f(
        (worldPos.x - params.cameraPos.x) * params.cameraZoom / params.aspectRatio,
        (worldPos.y - params.cameraPos.y) * params.cameraZoom,
        0.0,
        1.0
    );
    
    // Glowing wall color
    let color = vec4f(0.2, 0.5, 0.7, 0.9);
    
    return VertexOutput(pos, color);
}

@fragment
fn borderFrag(@location(0) color: vec4f) -> @location(0) vec4f {
    return color;
}
`;

// Arena grid shader - draws grid lines in world coordinates
export const getArenaGridWGSL = () => /* wgsl */`
struct GridParams {
  cameraPos: vec2f,
  cameraZoom: f32,
  arenaSize: f32,
  gridSpacing: f32,
  aspectRatio: f32,
};

@group(0) @binding(0) var<uniform> params: GridParams;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) color: vec4f,
};

@vertex
fn gridVert(@builtin(vertex_index) vi: u32) -> VertexOutput {
    let arena = params.arenaSize;
    let spacing = params.gridSpacing;
    
    // Calculate grid line count (how many lines in each direction)
    let lineCount = u32(arena * 2.0 / spacing) + 1u;
    
    // Determine if this is a horizontal or vertical line
    let totalHorizontalVerts = lineCount * 2u;
    let isVertical = vi >= totalHorizontalVerts;
    
    var worldPos: vec2f;
    
    if (!isVertical) {
        // Horizontal lines
        let lineIdx = vi / 2u;
        let isEnd = (vi % 2u) == 1u;
        let y = -arena + f32(lineIdx) * spacing;
        worldPos = vec2f(select(-arena, arena, isEnd), y);
    } else {
        // Vertical lines
        let adjustedVi = vi - totalHorizontalVerts;
        let lineIdx = adjustedVi / 2u;
        let isEnd = (adjustedVi % 2u) == 1u;
        let x = -arena + f32(lineIdx) * spacing;
        worldPos = vec2f(x, select(-arena, arena, isEnd));
    }
    
    // Apply camera transform with aspect ratio correction
    var pos = vec4f(
        (worldPos.x - params.cameraPos.x) * params.cameraZoom / params.aspectRatio,
        (worldPos.y - params.cameraPos.y) * params.cameraZoom,
        0.0,
        1.0
    );
    
    // Subtle grid color
    let color = vec4f(0.2, 0.25, 0.30, 0.5);
    
    return VertexOutput(pos, color);
}

@fragment
fn gridFrag(@location(0) color: vec4f) -> @location(0) vec4f {
    return color;
}
`;

// Backwards compatibility for Sim
export const computeWGSL = getComputeWGSL(false);
export const renderWGSL = getRenderWGSL(false);
