
import { getComputeWGSL, getRenderWGSL, getArenaBorderWGSL, getArenaGridWGSL } from './shaders.js';

// Struct Layout:
// ...
// triangleCount (28) (u32)
// mousePos (32) (vec2f)
// gameMode (40) (u32)
// time (44) (f32)
// clickState (48) (u32)
// colorFadeDuration (52) (f32)
// cameraPos (56) (vec2f)
// cameraZoom (64) (f32)
// aspectRatio (68) (f32)
// arenaSize (72) (f32)
// foodRadius (76) (f32)
// captureRadius (80) (f32)
// digestTime (84) (f32)
// spill (88) (f32)
// foodValue (92) (f32)
export const PARAMS_SIZE_BYTES = 96; // Includes camera, aspect ratio, arena size and game params

// Per-pack steering (game mode): PackControl { goal: vec2f, steer, maxSpeed, cohesionScale, spread,
// eatenBy (u32 bits), wobble, spreadRadius, steerJitter, pad, pad }
export const MAX_PACKS = 32;
export const PACK_CONTROL_FLOATS = 12;

// Game mode runs the simulation at a fixed rate so speed doesn't depend on the monitor's refresh rate
export const SIM_STEP_SECONDS = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;

// Spatial grid (neighbor search) tuning
const SPATIAL_GRID_MAX_DIM = 96;        // Max cells per axis
const SPATIAL_GRID_MARGIN = 0.25;       // Extra world space around the arena for overshooting boids

export class BoidsEngine {
    constructor(canvas, initialParams, initialColor, isGame = false) {
        this.canvas = canvas;
        this.params = {
            gameMode: isGame ? 1 : 0,
            mousePos: [0, 0],
            clickState: 0, // 0 = up, 1 = down
            time: 0,
            ...initialParams
        };

        // Mouse handling lives in simulator.js / game.js

        this.color = [...initialColor];
        this.isGame = isGame;

        // State
        this.device = null;
        this.context = null;
        this.presentationFormat = null;

        // Resources
        this.computePipeline = null;
        this.renderPipeline = null;
        this.paramsBuffer = null;
        this.colorPaletteBuffer = null;
        this.triangleVertexBuffer = null;
        this.triangleBufferA = null;
        this.triangleBufferB = null;
        this.allocatedCount = 0;  // Boid capacity of the current triangle buffers
        this.bindGroupA = null;
        this.bindGroupB = null;

        // Spatial grid resources (compute neighbor search)
        this.spatialPipelines = null;
        this.spatialBindGroupLayout = null;
        this.spatialBindGroup = null;
        this.spatialParamsBuffer = null;
        this.spatialKeyCapacity = 0;
        this.spatialKeyCount = 0;
        this.spatialCoarseKeyCount = 0;
        this.cellCountBuffer = null;
        this.cellStartBuffer = null;
        this.cellAggBuffer = null;
        this.boidSlotBuffer = null;
        this.sortedIndexBuffer = null;
        this.sortedBoidsBuffer = null;

        // Border resources (game mode only)
        this.borderPipeline = null;
        this.borderParamsBuffer = null;
        this.borderBindGroup = null;

        // Grid resources (game mode only)
        this.gridPipeline = null;
        this.gridParamsBuffer = null;
        this.gridBindGroup = null;
        this.gridSpacing = 1.0; // Grid line spacing in world units

        this.frameCount = 0;
        this.startTime = performance.now();
        this.isRunning = false;

        // Simulation clock (game mode: fixed steps of SIM_STEP_SECONDS, scaled by timeScale)
        this.stepCount = 0;          // Compute steps run; parity picks the ping-pong buffer
        this.simTime = 0;            // Seconds of simulated time
        this.timeScale = 1;          // Debug: >1 runs the game faster than real time
        this.stepAccumulator = 0;
        this.lastFrameTime = null;
        this.packControlBuffer = null;

        // Resize
        this.onResize = this.onResize.bind(this);
    }

    async init() {
        if (!navigator.gpu) {
            alert("WebGPU not supported.");
            return false;
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            alert("No appropriate GPU adapter found.");
            return false;
        }

        this.device = await adapter.requestDevice();
        this.context = this.canvas.getContext("webgpu");
        this.presentationFormat = navigator.gpu.getPreferredCanvasFormat();

        window.addEventListener('resize', this.onResize);
        this.onResize();

        await this.createResources();

        return true;
    }

    onResize() {
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = window.innerWidth * dpr;
        this.canvas.height = window.innerHeight * dpr;

        if (this.context && this.device) {
            this.context.configure({
                device: this.device,
                format: this.presentationFormat,
                alphaMode: "premultiplied",
            });
        }
    }

    async createResources() {
        const device = this.device;

        const computeModule = device.createShaderModule({ code: getComputeWGSL(this.isGame) });
        computeModule.getCompilationInfo().then((info) => {
            if (info.messages.length > 0) {
                let hasError = false;
                for (const msg of info.messages) {
                    console.log(`Compute Shader: ${msg.message} (Line ${msg.lineNum})`);
                    if (msg.type === 'error') hasError = true;
                }
                if (hasError) {
                    const errorMsg = info.messages.find(m => m.type === 'error')?.message || "Unknown error";
                    alert(`Compute Shader Error: ${errorMsg}`);
                }
            }
        });

        const renderModule = device.createShaderModule({ code: getRenderWGSL(this.isGame) });
        renderModule.getCompilationInfo().then((info) => {
            if (info.messages.length > 0) {
                let hasError = false;
                for (const msg of info.messages) {
                    console.log(`Render Shader: ${msg.message} (Line ${msg.lineNum})`);
                    if (msg.type === 'error') hasError = true;
                }
                if (hasError) {
                    const errorMsg = info.messages.find(m => m.type === 'error')?.message || "Unknown error";
                    alert(`Render Shader Error: ${errorMsg}`);
                }
            }
        });

        this.paramsBuffer = device.createBuffer({
            size: PARAMS_SIZE_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.colorPaletteBuffer = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.triangleVertexBuffer = device.createBuffer({
            size: 3 * 2 * 4,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });

        this.packControlBuffer = device.createBuffer({
            size: MAX_PACKS * PACK_CONTROL_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.updateParamsBuffer();
        this.updateColorBuffer();
        this.updateVertexBuffer();

        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            ]
        });

        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

        this.spatialBindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            ]
        });

        const computeLayout = device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout, this.spatialBindGroupLayout]
        });
        const makeCompute = (entryPoint) => device.createComputePipeline({
            layout: computeLayout,
            compute: { module: computeModule, entryPoint },
        });

        this.spatialPipelines = {
            count: makeCompute("gridCount"),
            scan: makeCompute("gridScan"),
            scatter: makeCompute("gridScatter"),
            aggregate: makeCompute("gridAggregate"),
            coarse: makeCompute("gridCoarse"),
        };
        this.computePipeline = makeCompute("mainCompute");

        this.renderPipeline = device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: renderModule,
                entryPoint: "mainVert",
                buffers: [{
                    arrayStride: 8,
                    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }]
                }]
            },
            fragment: {
                module: renderModule,
                entryPoint: "mainFrag",
                targets: [{ format: this.presentationFormat }]
            },
            primitive: { topology: "triangle-list" }
        });

        this.initTriangleBuffers(this.params.triangleCount);
        this.createBindGroups();

        // Create arena border pipeline (game mode only)
        if (this.isGame) {
            const borderModule = device.createShaderModule({ code: getArenaBorderWGSL() });

            // Border params buffer: cameraPos (vec2f), cameraZoom (f32), arenaSize (f32), borderThickness (f32), aspectRatio (f32)
            this.borderParamsBuffer = device.createBuffer({
                size: 32, // 6 floats = 24 bytes, rounded to 32 for alignment
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });

            const borderBindGroupLayout = device.createBindGroupLayout({
                entries: [{
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: "uniform" }
                }]
            });

            this.borderPipeline = device.createRenderPipeline({
                layout: device.createPipelineLayout({ bindGroupLayouts: [borderBindGroupLayout] }),
                vertex: {
                    module: borderModule,
                    entryPoint: "borderVert",
                },
                fragment: {
                    module: borderModule,
                    entryPoint: "borderFrag",
                    targets: [{
                        format: this.presentationFormat,
                        blend: {
                            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                            alpha: { srcFactor: "one", dstFactor: "one" }
                        }
                    }]
                },
                primitive: { topology: "triangle-list" }
            });

            this.borderBindGroup = device.createBindGroup({
                layout: borderBindGroupLayout,
                entries: [{
                    binding: 0,
                    resource: { buffer: this.borderParamsBuffer }
                }]
            });

            // Create grid pipeline
            const gridModule = device.createShaderModule({ code: getArenaGridWGSL() });

            // Grid params buffer: cameraPos (vec2f), cameraZoom (f32), arenaSize (f32), gridSpacing (f32), aspectRatio (f32)
            this.gridParamsBuffer = device.createBuffer({
                size: 32, // 6 floats = 24 bytes, rounded to 32
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });

            const gridBindGroupLayout = device.createBindGroupLayout({
                entries: [{
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: "uniform" }
                }]
            });

            this.gridPipeline = device.createRenderPipeline({
                layout: device.createPipelineLayout({ bindGroupLayouts: [gridBindGroupLayout] }),
                vertex: {
                    module: gridModule,
                    entryPoint: "gridVert",
                },
                fragment: {
                    module: gridModule,
                    entryPoint: "gridFrag",
                    targets: [{
                        format: this.presentationFormat,
                        blend: {
                            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                            alpha: { srcFactor: "one", dstFactor: "one" }
                        }
                    }]
                },
                primitive: { topology: "line-list" }
            });

            this.gridBindGroup = device.createBindGroup({
                layout: gridBindGroupLayout,
                entries: [{
                    binding: 0,
                    resource: { buffer: this.gridParamsBuffer }
                }]
            });
        }
    }

    initTriangleBuffers(count, initialDataArray = null) {
        if (this.triangleBufferA) this.triangleBufferA.destroy();
        if (this.triangleBufferB) this.triangleBufferB.destroy();

        const stride = this.isGame ? 32 : 16;
        const byteSize = count * stride;
        this.allocatedCount = count;

        let data;
        if (initialDataArray) {
            data = initialDataArray;
        } else {
            data = new Float32Array((byteSize / 4));
            const floatsPerBoid = stride / 4;
            const spawnBound = this.isGame ? 1 : 5;  // Simulator has larger arena
            for (let i = 0; i < count; ++i) {
                const base = i * floatsPerBoid;
                data[base + 0] = (Math.random() * 2 - 1) * spawnBound;
                data[base + 1] = (Math.random() * 2 - 1) * spawnBound;
                data[base + 2] = Math.random() * 0.1 - 0.05;
                data[base + 3] = Math.random() * 0.1 - 0.05;
                if (this.isGame) {
                    data[base + 4] = 0;
                    data[base + 5] = 0;
                    data[base + 6] = 0;
                    data[base + 7] = 0;
                }
            }
        }

        this.triangleBufferA = this.device.createBuffer({
            size: byteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        this.triangleBufferB = this.device.createBuffer({
            size: byteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this.device.queue.writeBuffer(this.triangleBufferA, 0, data);
        this.device.queue.writeBuffer(this.triangleBufferB, 0, data);

        // Per-boid spatial grid buffers (min size 16 so empty flocks still bind)
        if (this.boidSlotBuffer) this.boidSlotBuffer.destroy();
        if (this.sortedIndexBuffer) this.sortedIndexBuffer.destroy();
        if (this.sortedBoidsBuffer) this.sortedBoidsBuffer.destroy();
        this.sortedBoidsBuffer = this.device.createBuffer({
            size: Math.max(16, count * 16),
            usage: GPUBufferUsage.STORAGE,
        });
        this.boidSlotBuffer = this.device.createBuffer({
            size: Math.max(16, count * 8),
            usage: GPUBufferUsage.STORAGE,
        });
        this.sortedIndexBuffer = this.device.createBuffer({
            size: Math.max(16, count * 4),
            usage: GPUBufferUsage.STORAGE,
        });
    }

    // Pick grid cell size and dimensions from the current params, and grow the
    // per-key buffers if needed. Cell size must cover every radius searched in the 3x3 neighborhood.
    updateSpatialGrid() {
        const p = this.params;
        const halfExtent = this.isGame
            ? (p.arenaSize || 4.0) + SPATIAL_GRID_MARGIN
            : 5.0 + p.triangleSize + SPATIAL_GRID_MARGIN;  // Simulator wraps at 5 + triangleSize
        const extent = halfExtent * 2;

        const cellSize = Math.max(
            p.separationDistance,
            p.alignmentDistance,
            this.isGame ? (p.foodRadius || 0) : 0,
            extent / SPATIAL_GRID_MAX_DIM,
        );
        const dim = Math.ceil(extent / cellSize);
        // Coarse blocks of coarseFactor x coarseFactor fine cells, for the large cohesion radius.
        // With r = cohesion radius in fine cells, a boid visits ~4(r/k)^2 blocks plus ~2*pi*r*k fine
        // cells on the rim; that total is smallest near k = cbrt(1.3 * r).
        const cohesionCells = p.cohesionDistance / cellSize;
        const coarseFactor = Math.min(dim, Math.max(1, Math.round(Math.cbrt(1.3 * cohesionCells))));
        const coarseDim = Math.ceil(dim / coarseFactor);
        const packCount = this.isGame ? (p.packCount || 32) : 1;
        const keyCount = dim * dim * packCount;
        const coarseKeyCount = coarseDim * coarseDim * packCount;
        this.spatialKeyCount = keyCount;
        this.spatialCoarseKeyCount = coarseKeyCount;

        const device = this.device;
        if (!this.spatialParamsBuffer) {
            this.spatialParamsBuffer = device.createBuffer({
                size: 48,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
        }
        const data = new ArrayBuffer(48);
        const view = new DataView(data);
        view.setFloat32(0, -halfExtent, true);
        view.setFloat32(4, -halfExtent, true);
        view.setFloat32(8, cellSize, true);
        view.setUint32(12, packCount, true);
        view.setUint32(16, dim, true);
        view.setUint32(20, dim, true);
        view.setUint32(24, keyCount, true);
        view.setUint32(28, coarseFactor, true);
        view.setUint32(32, coarseDim, true);
        view.setUint32(36, coarseDim, true);
        view.setUint32(40, coarseKeyCount, true);
        device.queue.writeBuffer(this.spatialParamsBuffer, 0, data);

        if (keyCount > this.spatialKeyCapacity) {
            if (this.cellCountBuffer) this.cellCountBuffer.destroy();
            if (this.cellStartBuffer) this.cellStartBuffer.destroy();
            if (this.cellAggBuffer) this.cellAggBuffer.destroy();
            this.cellCountBuffer = device.createBuffer({
                size: keyCount * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            this.cellStartBuffer = device.createBuffer({ size: keyCount * 4, usage: GPUBufferUsage.STORAGE });
            // Fine aggregates followed by coarse ones (never more coarse keys than fine keys)
            this.cellAggBuffer = device.createBuffer({ size: keyCount * 2 * 16, usage: GPUBufferUsage.STORAGE });
            this.spatialKeyCapacity = keyCount;
            if (this.triangleBufferA && this.spatialBindGroupLayout) this.createBindGroups();
        }
    }

    // Rebuild the spatial grid from `bindGroup`'s current buffer, then step the simulation
    encodeCompute(commandEncoder, bindGroup) {
        const count = this.params.triangleCount;
        const boidWorkgroups = Math.ceil(count / 64);

        commandEncoder.clearBuffer(this.cellCountBuffer, 0, this.spatialKeyCount * 4);

        const pass = commandEncoder.beginComputePass();
        pass.setBindGroup(0, bindGroup);
        pass.setBindGroup(1, this.spatialBindGroup);
        pass.setPipeline(this.spatialPipelines.count);
        pass.dispatchWorkgroups(boidWorkgroups);
        pass.setPipeline(this.spatialPipelines.scan);
        pass.dispatchWorkgroups(1);
        pass.setPipeline(this.spatialPipelines.scatter);
        pass.dispatchWorkgroups(boidWorkgroups);
        pass.setPipeline(this.spatialPipelines.aggregate);
        pass.dispatchWorkgroups(Math.ceil(this.spatialKeyCount / 64));
        pass.setPipeline(this.spatialPipelines.coarse);
        pass.dispatchWorkgroups(Math.ceil(this.spatialCoarseKeyCount / 64));
        pass.setPipeline(this.computePipeline);
        pass.dispatchWorkgroups(boidWorkgroups);
        pass.end();
    }

    createBindGroups() {
        this.bindGroupA = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: { buffer: this.triangleBufferA } },
                { binding: 2, resource: { buffer: this.triangleBufferB } },
                { binding: 3, resource: { buffer: this.colorPaletteBuffer } },
                { binding: 4, resource: { buffer: this.packControlBuffer } },
            ]
        });

        this.bindGroupB = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: { buffer: this.triangleBufferB } },
                { binding: 2, resource: { buffer: this.triangleBufferA } },
                { binding: 3, resource: { buffer: this.colorPaletteBuffer } },
                { binding: 4, resource: { buffer: this.packControlBuffer } },
            ]
        });

        this.spatialBindGroup = this.device.createBindGroup({
            layout: this.spatialBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.spatialParamsBuffer } },
                { binding: 1, resource: { buffer: this.cellCountBuffer } },
                { binding: 2, resource: { buffer: this.cellStartBuffer } },
                { binding: 3, resource: { buffer: this.boidSlotBuffer } },
                { binding: 4, resource: { buffer: this.sortedIndexBuffer } },
                { binding: 5, resource: { buffer: this.cellAggBuffer } },
                { binding: 6, resource: { buffer: this.sortedBoidsBuffer } },
            ]
        });
    }

    updateParamsBuffer() {
        const p = this.params;
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
        if (p.mousePos) {
            view.setFloat32(32, p.mousePos[0], true);
            view.setFloat32(36, p.mousePos[1], true);
        }
        view.setUint32(40, p.gameMode || 0, true);
        view.setFloat32(44, this.simTime, true); // Time
        view.setUint32(48, p.clickState, true); // Click State
        view.setFloat32(52, p.colorFadeDuration || 5.0, true); // Color Fade Duration
        // Camera params
        const camPos = p.cameraPos || [0, 0];
        view.setFloat32(56, camPos[0], true);
        view.setFloat32(60, camPos[1], true);
        view.setFloat32(64, p.cameraZoom || 0.25, true);
        // Aspect ratio (width / height)
        const aspectRatio = this.canvas.width / this.canvas.height;
        view.setFloat32(68, aspectRatio, true);
        // Arena size
        view.setFloat32(72, p.arenaSize || 4.0, true);
        view.setFloat32(76, p.foodRadius || 0, true);
        view.setFloat32(80, p.captureRadius || 0, true);
        view.setFloat32(84, p.digestTime || 0, true);
        view.setFloat32(88, p.spill || 0, true);
        view.setFloat32(92, p.foodValue ?? 1, true);

        this.device.queue.writeBuffer(this.paramsBuffer, 0, data);
        this.updateSpatialGrid();
    }

    updateColorBuffer() {
        const data = new Float32Array([...this.color, 0.0]);
        this.device.queue.writeBuffer(this.colorPaletteBuffer, 0, data);
    }

    updateVertexBuffer() {
        const s = this.params.triangleSize;
        const vData = new Float32Array([
            0.0, s,
            -s / 2, -s / 2,
            s / 2, -s / 2
        ]);
        this.device.queue.writeBuffer(this.triangleVertexBuffer, 0, vData);
    }

    setParams(newParams) {
        Object.assign(this.params, newParams);

        // Compare against the allocated size, not the old param: the simulator GUI writes
        // triangleCount straight into this.params before calling setParams(this.params)
        if (!this.isGame && this.params.triangleCount !== this.allocatedCount) {
            this.initTriangleBuffers(this.params.triangleCount);
            this.createBindGroups();
        }

        if (newParams.triangleSize !== undefined) {
            this.updateVertexBuffer();
        }

        this.updateParamsBuffer();
    }

    latestIsB() {
        return this.stepCount > 0 && this.stepCount % 2 === 0;
    }

    // Overwrite floats [floatOffset, floatOffset + values.length) of one boid in both ping-pong
    // buffers, leaving every other boid's in-flight state alone
    patchBoid(index, floatOffset, values) {
        const stride = this.isGame ? 32 : 16;
        const byteOffset = index * stride + floatOffset * 4;
        const data = values instanceof Float32Array ? values : new Float32Array(values);
        this.device.queue.writeBuffer(this.triangleBufferA, byteOffset, data);
        this.device.queue.writeBuffer(this.triangleBufferB, byteOffset, data);
    }

    // Game mode: per-pack steering, MAX_PACKS x PACK_CONTROL_FLOATS floats
    setPackControls(data) {
        this.device.queue.writeBuffer(this.packControlBuffer, 0, data);
    }

    setTriangleData(count, dataArray) {
        this.params.triangleCount = count;
        this.initTriangleBuffers(count, dataArray);
        this.createBindGroups();
        this.updateParamsBuffer();
    }

    setColor(newColor) {
        this.color = newColor;
        this.updateColorBuffer();
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastFrameTime = null;
        this.frame();
    }

    stop() {
        this.isRunning = false;
    }

    frame = () => {
        if (!this.isRunning) return;

        this.frameCount++;

        // Simulator: one step per frame. Game: as many fixed steps as real time (x timeScale) calls for.
        const now = performance.now();
        let steps = 1;
        if (this.isGame) {
            const dt = this.lastFrameTime === null ? SIM_STEP_SECONDS : Math.min(0.25, (now - this.lastFrameTime) / 1000);
            this.stepAccumulator += dt * this.timeScale;
            const maxSteps = MAX_STEPS_PER_FRAME * Math.ceil(this.timeScale);
            steps = Math.floor(this.stepAccumulator / SIM_STEP_SECONDS);
            if (steps >= maxSteps) {
                steps = maxSteps;
                this.stepAccumulator = 0;   // Too far behind: drop time rather than spiral
            } else {
                this.stepAccumulator -= steps * SIM_STEP_SECONDS;
            }
        }
        this.lastFrameTime = now;

        this.simTime = this.isGame ? this.stepCount * SIM_STEP_SECONDS : (now - this.startTime) / 1000.0;
        this.params.time = this.simTime;
        this.updateParamsBuffer();

        const commandEncoder = this.device.createCommandEncoder();

        // Even steps read A and write B, odd steps read B and write A
        for (let i = 0; i < steps; i++) {
            this.stepCount++;
            const readsA = this.stepCount % 2 === 0;
            this.encodeCompute(commandEncoder, readsA ? this.bindGroupA : this.bindGroupB);
        }

        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                clearValue: [0.0, 0.0, 0.0, 0.0],
                loadOp: "clear",
                storeOp: "store"
            }]
        });
        renderPass.setPipeline(this.renderPipeline);
        renderPass.setVertexBuffer(0, this.triangleVertexBuffer);

        // Draw from the buffer the last step wrote (binding 1 is the "current" buffer)
        const renderBindGroup = this.latestIsB() ? this.bindGroupB : this.bindGroupA;

        // Draw arena grid first (so boids render on top)
        if (this.isGame && this.gridPipeline) {
            const camPos = this.params.cameraPos || [0, 0];
            const aspectRatio = this.canvas.width / this.canvas.height;
            const gridData = new Float32Array([
                camPos[0], camPos[1],
                this.params.cameraZoom || 0.25,
                this.params.arenaSize || 4.0,
                this.gridSpacing,
                aspectRatio
            ]);
            this.device.queue.writeBuffer(this.gridParamsBuffer, 0, gridData);

            renderPass.setPipeline(this.gridPipeline);
            renderPass.setBindGroup(0, this.gridBindGroup);

            // Calculate vertex count: (lineCount * 2) for horizontal + (lineCount * 2) for vertical
            const lineCount = Math.floor((this.params.arenaSize || 4.0) * 2 / this.gridSpacing) + 1;
            renderPass.draw(lineCount * 2 * 2); // horizontal + vertical lines
        }
        // Draw boids (need to re-set pipeline after grid)
        renderPass.setPipeline(this.renderPipeline);
        renderPass.setBindGroup(0, renderBindGroup);
        renderPass.draw(3, this.params.triangleCount);

        // Draw arena border (game mode only)
        if (this.isGame && this.borderPipeline) {
            // Update border params buffer
            const camPos = this.params.cameraPos || [0, 0];
            const borderThickness = 0.15; // Wall thickness in world units
            const aspectRatio = this.canvas.width / this.canvas.height;
            const borderData = new Float32Array([
                camPos[0], camPos[1],
                this.params.cameraZoom || 0.25,
                this.params.arenaSize || 4.0,
                borderThickness,
                aspectRatio
            ]);
            this.device.queue.writeBuffer(this.borderParamsBuffer, 0, borderData);

            renderPass.setPipeline(this.borderPipeline);
            renderPass.setBindGroup(0, this.borderBindGroup);
            renderPass.draw(24); // 24 vertices for 4 wall quads
        }

        renderPass.end();

        this.device.queue.submit([commandEncoder.finish()]);

        requestAnimationFrame(this.frame);
    }

    async readData() {
        if (!this.isRunning) return null;

        await this.device.queue.onSubmittedWorkDone();

        const latestBuffer = this.latestIsB() ? this.triangleBufferB : this.triangleBufferA;
        this.lastReadSimTime = this.simTime;

        const stride = this.isGame ? 32 : 16;
        const size = this.params.triangleCount * stride;

        const gpuReadBuffer = this.device.createBuffer({
            size: size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const commandEncoder = this.device.createCommandEncoder();
        commandEncoder.copyBufferToBuffer(latestBuffer, 0, gpuReadBuffer, 0, size);
        this.device.queue.submit([commandEncoder.finish()]);

        await gpuReadBuffer.mapAsync(GPUMapMode.READ);
        const arrayBuffer = gpuReadBuffer.getMappedRange();
        const result = new Float32Array(arrayBuffer.slice(0));
        gpuReadBuffer.unmap();
        gpuReadBuffer.destroy();

        return result;
    }
}
