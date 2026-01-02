
import { getComputeWGSL, getRenderWGSL } from './shaders.js';

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
export const PARAMS_SIZE_BYTES = 80; // Increased for camera params

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

        // Add listeners
        window.addEventListener('mousedown', () => { this.params.clickState = 1; this.updateParamsBuffer(); });
        window.addEventListener('mouseup', () => { this.params.clickState = 0; this.updateParamsBuffer(); });
        // Touch support
        window.addEventListener('touchstart', () => { this.params.clickState = 1; this.updateParamsBuffer(); });
        window.addEventListener('touchend', () => { this.params.clickState = 0; this.updateParamsBuffer(); });
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
        this.bindGroupA = null;
        this.bindGroupB = null;

        this.frameCount = 0;
        this.startTime = performance.now();
        this.isRunning = false;

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

        this.updateParamsBuffer();
        this.updateColorBuffer();
        this.updateVertexBuffer();

        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            ]
        });

        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

        this.computePipeline = device.createComputePipeline({
            layout: pipelineLayout,
            compute: { module: computeModule, entryPoint: "mainCompute" },
        });

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
    }

    initTriangleBuffers(count, initialDataArray = null) {
        if (this.triangleBufferA) this.triangleBufferA.destroy();
        if (this.triangleBufferB) this.triangleBufferB.destroy();

        const stride = this.isGame ? 32 : 16;
        const byteSize = count * stride;

        let data;
        if (initialDataArray) {
            data = initialDataArray;
        } else {
            data = new Float32Array((byteSize / 4));
            const floatsPerBoid = stride / 4;
            for (let i = 0; i < count; ++i) {
                const base = i * floatsPerBoid;
                data[base + 0] = Math.random() * 2 - 1;
                data[base + 1] = Math.random() * 2 - 1;
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
    }

    createBindGroups() {
        this.bindGroupA = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: { buffer: this.triangleBufferA } },
                { binding: 2, resource: { buffer: this.triangleBufferB } },
                { binding: 3, resource: { buffer: this.colorPaletteBuffer } },
            ]
        });

        this.bindGroupB = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: { buffer: this.triangleBufferB } },
                { binding: 2, resource: { buffer: this.triangleBufferA } },
                { binding: 3, resource: { buffer: this.colorPaletteBuffer } },
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
        view.setFloat32(44, (performance.now() - this.startTime) / 1000.0, true); // Time
        view.setUint32(48, p.clickState, true); // Click State
        view.setFloat32(52, p.colorFadeDuration || 5.0, true); // Color Fade Duration
        // Camera params
        const camPos = p.cameraPos || [0, 0];
        view.setFloat32(56, camPos[0], true);
        view.setFloat32(60, camPos[1], true);
        view.setFloat32(64, p.cameraZoom || 0.25, true);

        this.device.queue.writeBuffer(this.paramsBuffer, 0, data);
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
        let countChanged = false;
        if (newParams.triangleCount !== undefined && newParams.triangleCount !== this.params.triangleCount) {
            countChanged = true;
        }

        Object.assign(this.params, newParams);

        if (countChanged && !this.isGame) {
            this.initTriangleBuffers(this.params.triangleCount);
            this.createBindGroups();
        }

        if (newParams.triangleSize !== undefined) {
            this.updateVertexBuffer();
        }

        this.updateParamsBuffer();
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
        this.frame();
    }

    stop() {
        this.isRunning = false;
    }

    frame = () => {
        if (!this.isRunning) return;

        this.frameCount++;

        // Update Time per frame
        this.params.time = (performance.now() - this.startTime) / 1000.0;
        this.updateParamsBuffer(); // Potentially expensive if 60fps? 32 bytes is cheap.

        const commandEncoder = this.device.createCommandEncoder();

        const useBindGroupA = this.frameCount % 2 === 0;
        const currentBindGroup = useBindGroupA ? this.bindGroupA : this.bindGroupB;

        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.computePipeline);
        computePass.setBindGroup(0, currentBindGroup);
        const workgroupCount = Math.ceil(this.params.triangleCount / 64);
        computePass.dispatchWorkgroups(workgroupCount);
        computePass.end();

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

        const renderBindGroup = useBindGroupA ? this.bindGroupB : this.bindGroupA;

        renderPass.setBindGroup(0, renderBindGroup);
        renderPass.draw(3, this.params.triangleCount);
        renderPass.end();

        this.device.queue.submit([commandEncoder.finish()]);

        requestAnimationFrame(this.frame);
    }

    async readData() {
        if (!this.isRunning) return null;

        await this.device.queue.onSubmittedWorkDone();

        const resultInBufferA = (this.frameCount % 2 !== 0);
        const latestBuffer = resultInBufferA ? this.triangleBufferA : this.triangleBufferB;

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
