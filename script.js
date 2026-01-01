
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19/+esm';

// --- Constants & Types ---

const INITIAL_TRIANGLE_COUNT = 1000;
const INITIAL_TRIANGLE_SIZE = 0.03;
const PARAMS_SIZE_BYTES = 32;

const INITIAL_PARAMS = {
    separationDistance: 0.05,
    separationStrength: 0.001,
    alignmentDistance: 0.3,
    alignmentStrength: 0.01,
    cohesionDistance: 0.3,
    cohesionStrength: 0.001,
    triangleSize: INITIAL_TRIANGLE_SIZE,
    triangleCount: INITIAL_TRIANGLE_COUNT,
};

const COLOR_PRESETS = {
    plumTree: [1.0, 2.0, 1.0],
    jeans: [2.0, 1.5, 1.0],
    greyscale: [0.0, 0.0, 0.0],
    hotcold: [0.0, 3.14, 3.14],
};

const SIM_PRESETS = {
    default: { ...INITIAL_PARAMS },
    mosquitoes: {
        separationDistance: 0.02,
        separationStrength: 0.01,
        alignmentDistance: 0.0,
        alignmentStrength: 0.0,
        cohesionDistance: 0.177,
        cohesionStrength: 0.011,
    },
    blobs: {
        separationDistance: 0.033,
        separationStrength: 0.051,
        alignmentDistance: 0.047,
        alignmentStrength: 0.1,
        cohesionDistance: 0.3,
        cohesionStrength: 0.013,
    },
    particles: {
        separationDistance: 0.035,
        separationStrength: 1,
        alignmentDistance: 0.0,
        alignmentStrength: 0.0,
        cohesionDistance: 0.0,
        cohesionStrength: 0.0,
    },
    nanites: {
        separationDistance: 0.067,
        separationStrength: 0.01,
        alignmentDistance: 0.066,
        alignmentStrength: 0.021,
        cohesionDistance: 0.086,
        cohesionStrength: 0.094,
    },
};

// --- Shaders ---

const commonWGSL = /* wgsl */`
struct SimParams {
  separationDistance: f32,
  separationStrength: f32,
  alignmentDistance: f32,
  alignmentStrength: f32,
  cohesionDistance: f32,
  cohesionStrength: f32,
  triangleSize: f32,
  triangleCount: u32,
};

struct TriangleInfo {
  position: vec2f,
  velocity: vec2f,
};
`;

const computeWGSL = commonWGSL + /* wgsl */`
// Bind definition for Compute
@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> currentTriangles: array<TriangleInfo>;
@group(0) @binding(2) var<storage, read_write> nextTriangles: array<TriangleInfo>;
// Binding 3 (Color) is not visible to Compute

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

    for (var i = 0u; i < params.triangleCount; i = i + 1) {
        if (i == index) {
            continue;
        }
        let other = currentTriangles[i];
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

    instanceInfo.velocity += 
        (separation * params.separationStrength) +
        (alignment * params.alignmentStrength) +
        (cohesion * params.cohesionStrength);
    
    // Clamp velocity
    instanceInfo.velocity = normalize(instanceInfo.velocity) * clamp(length(instanceInfo.velocity), 0.0, 0.01);

    // Boundary wrap
    let size = params.triangleSize;
    if (instanceInfo.position.x > 1.0 + size) { instanceInfo.position.x = -1.0 - size; }
    if (instanceInfo.position.y > 1.0 + size) { instanceInfo.position.y = -1.0 - size; }
    if (instanceInfo.position.x < -1.0 - size) { instanceInfo.position.x = 1.0 + size; }
    if (instanceInfo.position.y < -1.0 - size) { instanceInfo.position.y = 1.0 + size; }

    instanceInfo.position += instanceInfo.velocity;
    nextTriangles[index] = instanceInfo;
}
`;

const renderWGSL = commonWGSL + /* wgsl */`
// Bind definition for Render (Vertex stage)
@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> currentTriangles: array<TriangleInfo>;
// Binding 2 (Next) is not visible to Vertex
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

    let color = vec4(
        sin(angle + colorPalette.r) * 0.45 + 0.45,
        sin(angle + colorPalette.g) * 0.45 + 0.45,
        sin(angle + colorPalette.b) * 0.45 + 0.45,
        1.0
    );

    return VertexOutput(pos, color);
}

@fragment
fn mainFrag(@location(0) color: vec4f) -> @location(0) vec4f {
    return color;
}
`;

// --- Main Application ---

async function init() {
    if (!navigator.gpu) {
        alert("WebGPU not supported.");
        return;
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        alert("No appropriate GPU adapter found.");
        return;
    }

    const device = await adapter.requestDevice();
    const canvas = document.querySelector("canvas");
    const context = canvas.getContext("webgpu");
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();

    // --- Resize Handler ---
    function onResize() {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = window.innerWidth * dpr;
        canvas.height = window.innerHeight * dpr;

        context.configure({
            device: device,
            format: presentationFormat,
            alphaMode: "premultiplied",
        });
    }
    window.addEventListener('resize', onResize);
    onResize();

    // --- State ---
    const appState = {
        params: { ...INITIAL_PARAMS },
        colorPreset: 'jeans',
        simPreset: 'default',
    };

    // --- Resources ---

    // Shader Modules
    const computeModule = device.createShaderModule({ code: computeWGSL });
    const renderModule = device.createShaderModule({ code: renderWGSL });

    // Buffers that don't need resizing
    const paramsBuffer = device.createBuffer({
        size: PARAMS_SIZE_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const colorPaletteBuffer = device.createBuffer({
        size: 16, // vec3f + padding
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    let triangleVertexBuffer = device.createBuffer({
        size: 3 * 2 * 4, // 3 verts * 2 floats * 4 bytes
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    function updateVertexBuffer() {
        const s = appState.params.triangleSize;
        const vData = new Float32Array([
            0.0, s,
            -s / 2, -s / 2,
            s / 2, -s / 2
        ]);
        device.queue.writeBuffer(triangleVertexBuffer, 0, vData);
    }
    updateVertexBuffer();

    // Ping-Pong Buffers
    let triangleBufferA;
    let triangleBufferB;

    // Bind Groups
    let bindGroupA;
    let bindGroupB;
    let bindGroupLayout;

    function initTriangleBuffers(count) {
        if (triangleBufferA) triangleBufferA.destroy();
        if (triangleBufferB) triangleBufferB.destroy();

        // Ensure 16-byte alignment of buffer size just in case, though storage is flexible.
        // vec2 + vec2 = 16 bytes. count * 16 is always 16-byte aligned.
        const byteSize = count * 16;

        const initialData = new Float32Array(count * 4);
        for (let i = 0; i < count; ++i) {
            initialData[i * 4 + 0] = Math.random() * 2 - 1;
            initialData[i * 4 + 1] = Math.random() * 2 - 1;
            initialData[i * 4 + 2] = Math.random() * 0.1 - 0.05;
            initialData[i * 4 + 3] = Math.random() * 0.1 - 0.05;
        }

        triangleBufferA = device.createBuffer({
            size: byteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        triangleBufferB = device.createBuffer({
            size: byteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        device.queue.writeBuffer(triangleBufferA, 0, initialData);
        device.queue.writeBuffer(triangleBufferB, 0, initialData);
    }

    // Pipelines
    bindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: "uniform" } }, // Params
            { binding: 1, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }, // Current
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }, // Next
            { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }, // Color
        ]
    });

    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

    const computePipeline = device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module: computeModule, entryPoint: "mainCompute" },
    });

    const renderPipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: renderModule,
            entryPoint: "mainVert",
            buffers: [{
                arrayStride: 8, // 2 floats
                attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }]
            }]
        },
        fragment: {
            module: renderModule,
            entryPoint: "mainFrag",
            targets: [{ format: presentationFormat }]
        },
        primitive: { topology: "triangle-list" }
    });

    function createBindGroups() {
        bindGroupA = device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: paramsBuffer } },
                { binding: 1, resource: { buffer: triangleBufferA } },
                { binding: 2, resource: { buffer: triangleBufferB } },
                { binding: 3, resource: { buffer: colorPaletteBuffer } },
            ]
        });

        bindGroupB = device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: paramsBuffer } },
                { binding: 1, resource: { buffer: triangleBufferB } },
                { binding: 2, resource: { buffer: triangleBufferA } },
                { binding: 3, resource: { buffer: colorPaletteBuffer } },
            ]
        });
    }

    // --- Updates ---

    function updateParamsBuffer() {
        const p = appState.params;
        const data = new ArrayBuffer(PARAMS_SIZE_BYTES);
        const view = new DataView(data);
        view.setFloat32(0, p.separationDistance, true);
        view.setFloat32(4, p.separationStrength, true);
        view.setFloat32(8, p.alignmentDistance, true);
        view.setFloat32(12, p.alignmentStrength, true);
        view.setFloat32(16, p.cohesionDistance, true);
        view.setFloat32(20, p.cohesionStrength, true);
        view.setFloat32(24, p.triangleSize, true);
        view.setUint32(28, p.triangleCount, true);

        device.queue.writeBuffer(paramsBuffer, 0, data);
    }

    function updateColorBuffer() {
        const c = COLOR_PRESETS[appState.colorPreset];
        const data = new Float32Array([...c, 0.0]);
        device.queue.writeBuffer(colorPaletteBuffer, 0, data);
    }

    function onTriangleCountChange() {
        initTriangleBuffers(appState.params.triangleCount);
        createBindGroups();
        updateParamsBuffer();
    }

    // Init logic
    initTriangleBuffers(appState.params.triangleCount);
    createBindGroups();
    updateParamsBuffer();
    updateColorBuffer();

    // --- GUI ---
    const gui = new GUI({ title: 'Boids Tuning' });

    // Define parameters folder first so we can reference it
    const folderParams = gui.addFolder('Parameters');
    folderParams.add(appState.params, 'triangleCount', 100, 20000, 100).name('Triangle Count').onFinishChange(onTriangleCountChange);
    folderParams.add(appState.params, 'triangleSize', 0.01, 0.1).name('Triangle Size').onChange(() => {
        updateVertexBuffer();
        updateParamsBuffer();
    });

    folderParams.add(appState.params, 'separationDistance', 0.0, 0.2).name('Separation Dist').onChange(updateParamsBuffer);
    folderParams.add(appState.params, 'separationStrength', 0.0, 0.1).name('Separation Str').onChange(updateParamsBuffer);
    folderParams.add(appState.params, 'alignmentDistance', 0.0, 0.5).name('Alignment Dist').onChange(updateParamsBuffer);
    folderParams.add(appState.params, 'alignmentStrength', 0.0, 0.1).name('Alignment Str').onChange(updateParamsBuffer);
    folderParams.add(appState.params, 'cohesionDistance', 0.0, 0.5).name('Cohesion Dist').onChange(updateParamsBuffer);
    folderParams.add(appState.params, 'cohesionStrength', 0.0, 0.1).name('Cohesion Str').onChange(updateParamsBuffer);

    // Presets Control (defined after folderParams)
    const presetController = { preset: 'default' };
    gui.add(presetController, 'preset', Object.keys(SIM_PRESETS)).name('Simulation Preset').onChange(v => {
        const p = SIM_PRESETS[v];
        if (p.triangleCount === undefined) p.triangleCount = appState.params.triangleCount;
        if (p.triangleSize === undefined) p.triangleSize = appState.params.triangleSize;

        Object.assign(appState.params, p);

        // Update GUI
        folderParams.children.forEach(c => c.updateDisplay());

        // Apply
        updateParamsBuffer();
    });

    gui.add(appState, 'colorPreset', Object.keys(COLOR_PRESETS)).name('Color Theme').onChange(updateColorBuffer);

    gui.add({
        reset: () => {
            initTriangleBuffers(appState.params.triangleCount);
            createBindGroups();
        }
    }, 'reset').name('Randomize Positions');

    // --- Loop ---

    let frameCount = 0;

    function frame() {
        frameCount++;

        const commandEncoder = device.createCommandEncoder();

        const useBindGroupA = frameCount % 2 === 0;
        const currentBindGroup = useBindGroupA ? bindGroupA : bindGroupB;

        // Compute Pass
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(computePipeline);
        computePass.setBindGroup(0, currentBindGroup);
        const workgroupCount = Math.ceil(appState.params.triangleCount / 64);
        computePass.dispatchWorkgroups(workgroupCount);
        computePass.end();

        // Render Pass
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: context.getCurrentTexture().createView(),
                clearValue: [1, 1, 1, 1], // White background
                loadOp: "clear",
                storeOp: "store"
            }]
        });
        renderPass.setPipeline(renderPipeline);
        renderPass.setVertexBuffer(0, triangleVertexBuffer);

        // If we computed A->B, currentBindGroup is A (entries: 1:A, 2:B).
        // Render needs to show B.
        // bindGroupB entries: 1:B, 2:A.
        // So use bindGroupB for render.
        const renderBindGroup = useBindGroupA ? bindGroupB : bindGroupA;

        renderPass.setBindGroup(0, renderBindGroup);
        renderPass.draw(3, appState.params.triangleCount);
        renderPass.end();

        device.queue.submit([commandEncoder.finish()]);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

init();
