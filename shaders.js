
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
  gameMode: u32, // 0 = Sim, 1 = Game
};

struct TriangleInfo {
  position: vec2f,
  velocity: vec2f,
  ${isGame ? 'packId: f32,' : ''}
  ${isGame ? 'padding: f32,' : ''} // Align to 8/16 bytes if needed, though vec2+vec2+f32+f32 = 24 bytes. 
  // Let's align to 32 bytes for simplicity? Or 16? 
  // vec2(8) + vec2(8) + f32(4) + pad(4) = 24.
  // Closest power of 2 stride is nice but not required for storage.
  // Let's use 24 bytes stride.
};
`;

export const getComputeWGSL = (isGame) => {
    const common = getCommonWGSL(isGame);
    return common + /* wgsl */`
// Bind definition for Compute
@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> currentTriangles: array<TriangleInfo>;
@group(0) @binding(2) var<storage, read_write> nextTriangles: array<TriangleInfo>;

@compute @workgroup_size(64)
fn mainCompute(@builtin(global_invocation_id) gid: vec3u) {
    let index = gid.x;
    if (index >= params.triangleCount) {
        return;
    }

    var instanceInfo = currentTriangles[index];
    var separation = vec2(0.0, 0.0);
    var alignment = vec2(0.0, 0.0);
    var alignmentCount = 0u;
    var cohesion = vec2(0.0, 0.0);
    var cohesionCount = 0u;

    ${isGame ? 'let myPack = instanceInfo.packId;' : ''}

    for (var i = 0u; i < params.triangleCount; i = i + 1) {
        if (i == index) {
            continue;
        }
        let other = currentTriangles[i];
        
        ${isGame ? 'if (other.packId != myPack) { continue; }' : ''}

        let dist = distance(instanceInfo.position, other.position);

        if (dist < params.separationDistance) {
            separation += instanceInfo.position - other.position;
        }
        if (dist < params.alignmentDistance) {
            alignment += other.velocity;
            alignmentCount++;
        }
        if (dist < params.cohesionDistance) {
            cohesion += other.position;
            cohesionCount++;
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
    if (params.gameMode == 1u && myPack == 0.0) {
        let mouseDir = params.mousePos - instanceInfo.position;
        let distToMouse = length(mouseDir);
        if (distToMouse > 0.05) { // Don't orbit too tight
            force += normalize(mouseDir) * 0.02; // Attraction strength
        }
    }
    ` : ''}

    instanceInfo.velocity += force;
    
    // Clamp velocity
    instanceInfo.velocity = normalize(instanceInfo.velocity) * clamp(length(instanceInfo.velocity), 0.0, 0.01);

    // Boundary wrap (Or bounce for game?)
    // Let's keep wrap for now, maybe wall bounce for game later.
    let size = params.triangleSize;
    if (instanceInfo.position.x > 1.0 + size) { instanceInfo.position.x = -1.0 - size; }
    if (instanceInfo.position.y > 1.0 + size) { instanceInfo.position.y = -1.0 - size; }
    if (instanceInfo.position.x < -1.0 - size) { instanceInfo.position.x = 1.0 + size; }
    if (instanceInfo.position.y < -1.0 - size) { instanceInfo.position.y = 1.0 + size; }

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

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) color: vec4f,
};

@vertex
fn mainVert(@builtin(instance_index) ii: u32, @location(0) v: vec2f) -> VertexOutput {
    let instanceInfo = currentTriangles[ii];
    let angle = getRotationFromVelocity(instanceInfo.velocity);
    let rotated = rotate(v, angle);
    let offset = instanceInfo.position;
    let pos = vec4(rotated + offset, 0.0, 1.0);

    var baseColor = vec4(
        sin(angle + colorPalette.r) * 0.45 + 0.45,
        sin(angle + colorPalette.g) * 0.45 + 0.45,
        sin(angle + colorPalette.b) * 0.45 + 0.45,
        1.0
    );

    ${isGame ? `
    // Game Mode Coloring
    if (instanceInfo.packId == 0.0) {
        // Player: Cyan/Blue-ish
        baseColor = vec4(0.2, 0.8, 1.0, 1.0); 
    } else if (instanceInfo.packId == 1.0) {
        // Food: Yellow
        baseColor = vec4(1.0, 1.0, 0.2, 1.0);
    } else {
        // Enemy: Red
        baseColor = vec4(1.0, 0.2, 0.2, 1.0);
    }
    ` : ''}

    return VertexOutput(pos, baseColor);
}

@fragment
fn mainFrag(@location(0) color: vec4f) -> @location(0) vec4f {
    return color;
}
`;
};

// Backwards compatibility for Sim
export const computeWGSL = getComputeWGSL(false);
export const renderWGSL = getRenderWGSL(false);
