
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
  padding: f32,
};

struct TriangleInfo {
  position: vec2f,
  velocity: vec2f,
  ${isGame ? 'packId: f32,' : ''}
  ${isGame ? 'padA: f32,' : ''} 
  ${isGame ? 'padB: f32,' : ''} 
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

@compute @workgroup_size(64)
fn mainCompute(@builtin(global_invocation_id) gid: vec3u) {
    let index = gid.x;
    if (index >= params.triangleCount) {
        return;
    }

    var instanceInfo = currentTriangles[index];
    
    // --- Food Physics (Pack 1) ---
    ${isGame ? `
    if (instanceInfo.packId > 0.5) {
        // Just drift slowly
        instanceInfo.velocity = normalize(instanceInfo.velocity) * 0.002;
        
        let bound = 4.0;
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

    for (var i = 0u; i < params.triangleCount; i = i + 1) {
        if (i == index) {
            continue;
        }
        let other = currentTriangles[i];
        
        ${isGame ? 'if (abs(other.packId - myPack) > 0.1) { continue; }' : ''}

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
    if (params.gameMode == 1u && myPack < 0.5) {
        let targetPos = params.mousePos; 
        
        let mouseDir = targetPos - instanceInfo.position;
        let distToMouse = length(mouseDir);
        if (distToMouse > 0.05) { 
            force += normalize(mouseDir) * 0.03; 
        }
    }
    ` : ''}

    instanceInfo.velocity += force;
    
    let maxSpeed = ${isGame ? '0.02' : '0.01'}; 
    instanceInfo.velocity = normalize(instanceInfo.velocity) * clamp(length(instanceInfo.velocity), 0.0, maxSpeed);

    // Boundary Logic
    ${isGame ? `
    let bound = 4.0;
    if (instanceInfo.position.x > bound) { instanceInfo.position.x = bound; instanceInfo.velocity.x *= -1.0; }
    if (instanceInfo.position.x < -bound) { instanceInfo.position.x = -bound; instanceInfo.velocity.x *= -1.0; }
    if (instanceInfo.position.y > bound) { instanceInfo.position.y = bound; instanceInfo.velocity.y *= -1.0; }
    if (instanceInfo.position.y < -bound) { instanceInfo.position.y = -bound; instanceInfo.velocity.y *= -1.0; }
    ` : `
    let size = params.triangleSize;
    if (instanceInfo.position.x > 1.0 + size) { instanceInfo.position.x = -1.0 - size; }
    if (instanceInfo.position.y > 1.0 + size) { instanceInfo.position.y = -1.0 - size; }
    if (instanceInfo.position.x < -1.0 - size) { instanceInfo.position.x = 1.0 + size; }
    if (instanceInfo.position.y < -1.0 - size) { instanceInfo.position.y = 1.0 + size; }
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

@vertex
fn mainVert(@builtin(instance_index) ii: u32, @location(0) v: vec2f) -> VertexOutput {
    let instanceInfo = currentTriangles[ii];
    let angle = getRotationFromVelocity(instanceInfo.velocity);
    
    // Pulse food size
    var scale = 1.0;
    ${isGame ? `
    if (instanceInfo.packId > 0.5) {
        scale = 1.0 + 0.3 * sin(params.time * 5.0 + f32(ii));
    }
    ` : ''}
    
    let rotated = rotate(v * scale, angle);
    let worldPos = instanceInfo.position + rotated;
    
    var pos = vec4(worldPos, 0.0, 1.0);
    
    ${isGame ? `
    pos.x *= 0.25; 
    pos.y *= 0.25;
    ` : ''}

    var baseColor = vec4(
        sin(angle + colorPalette.r) * 0.45 + 0.45,
        sin(angle + colorPalette.g) * 0.45 + 0.45,
        sin(angle + colorPalette.b) * 0.45 + 0.45,
        1.0
    );

    ${isGame ? `
    if (instanceInfo.packId < 0.5) {
        baseColor = vec4(0.2, 0.8, 1.0, 1.0); 
    } else if (instanceInfo.packId > 0.5) {
        baseColor = vec4(1.0, 0.8, 0.2, 1.0);
    } else {
        baseColor = vec4(1.0, 0.2, 0.2, 1.0);
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

// Backwards compatibility for Sim
export const computeWGSL = getComputeWGSL(false);
export const renderWGSL = getRenderWGSL(false);
