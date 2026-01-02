
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

@compute @workgroup_size(64)
fn mainCompute(@builtin(global_invocation_id) gid: vec3u) {
    let index = gid.x;
    if (index >= params.triangleCount) {
        return;
    }

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

        for (var i = 0u; i < params.triangleCount; i++) {
            let other = currentTriangles[i];
            // If other is NOT Food (Player or Enemy can attract food)
            if (instanceInfo.packId > 0.5 && instanceInfo.packId < 1.5 && (other.packId < 0.5 || other.packId > 1.5)) { 
                let dist = distance(instanceInfo.position, other.position);
                // Sensing radius
                if (dist < 0.8) { 
                    attraction += other.position - instanceInfo.position;
                    closePlayers++;
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
    ` : ''}

    instanceInfo.velocity += force;
    
    let maxSpeed = ${isGame ? '0.03' : '0.01'}; 
    instanceInfo.velocity = normalize(instanceInfo.velocity) * clamp(length(instanceInfo.velocity), 0.0, maxSpeed);

    // Boundary Logic
    ${isGame ? `
    let bound = params.arenaSize;
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
    
    // No pulsing, constant size
    var scale = 1.0;
    
    let rotated = rotate(v * scale, angle);
    let worldPos = instanceInfo.position + rotated;
    
    var pos = vec4(worldPos, 0.0, 1.0);
    
    ${isGame ? `
    // Camera transform: center on cameraPos, apply zoom, correct aspect ratio
    pos.x = (worldPos.x - params.cameraPos.x) * params.cameraZoom / params.aspectRatio;
    pos.y = (worldPos.y - params.cameraPos.y) * params.cameraZoom;
    ` : ''}

    var baseColor = vec4(
        sin(angle + colorPalette.r) * 0.45 + 0.45,
        sin(angle + colorPalette.g) * 0.45 + 0.45,
        sin(angle + colorPalette.b) * 0.45 + 0.45,
        1.0
    );

    ${isGame ? `
    let playerColor = vec4(0.2, 0.8, 1.0, 1.0);  // Blue
    let foodColor = vec4(1.0, 0.8, 0.2, 1.0);    // Yellow
    let enemyColor = vec4(1.0, 0.3, 0.2, 1.0);   // Red
    
    // Determine "from" color based on prevPackId
    var fromColor = foodColor;
    if (instanceInfo.prevPackId < 0.5) {
        fromColor = playerColor;
    } else if (instanceInfo.prevPackId > 1.5) {
        fromColor = enemyColor;
    }
    
    if (instanceInfo.packId < 0.5) {
        // Player pack (packId 0)
        if (instanceInfo.captureTime > 0.0) {
            let elapsed = params.time - instanceInfo.captureTime;
            let t = clamp(elapsed / params.colorFadeDuration, 0.0, 1.0);
            baseColor = mix(fromColor, playerColor, t);
        } else {
            baseColor = playerColor;
        }
    } else if (instanceInfo.packId < 1.5) {
        // Food (packId 1)
        baseColor = foodColor;
    } else {
        // Enemy pack (packId 2+)
        if (instanceInfo.captureTime > 0.0) {
            let elapsed = params.time - instanceInfo.captureTime;
            let t = clamp(elapsed / params.colorFadeDuration, 0.0, 1.0);
            baseColor = mix(fromColor, enemyColor, t);
        } else {
            baseColor = enemyColor;
        }
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
