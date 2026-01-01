
import { getComputeWGSL, getRenderWGSL } from './shaders.js';

export const PARAMS_SIZE_BYTES = 48; // Updated for new fields

export class BoidsEngine {
    constructor(canvas, initialParams, initialColor, isGame = false) {
        this.canvas = canvas;
        this.params = {
            gameMode: isGame ? 1 : 0,
            mousePos: [0, 0],
            ...initialParams
        };
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

        // Shader Modules
        const computeModule = device.createShaderModule({ code: getComputeWGSL(this.isGame) });
        const renderModule = device.createShaderModule({ code: getRenderWGSL(this.isGame) });

        // Buffers
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

        // Initialize Param/Color Buffers
        this.updateParamsBuffer();
        this.updateColorBuffer();
        this.updateVertexBuffer();

        // Pipelines
        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: "uniform" } }, // Params
                { binding: 1, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }, // Current
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }, // Next
                { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }, // Color
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

        // Init simulation state
        this.initTriangleBuffers(this.params.triangleCount);
        this.createBindGroups();
    }

    initTriangleBuffers(count, initialDataArray = null) {
        if (this.triangleBufferA) this.triangleBufferA.destroy();
        if (this.triangleBufferB) this.triangleBufferB.destroy();

        const stride = this.isGame ? 24 : 16;
        const byteSize = count * stride;

        let data;
        if (initialDataArray) {
            data = initialDataArray;
            // Ensure data length matches byteSize requirement (padding?)
            // If passed data is smaller/larger, we might need to handle it.
            // Assumption: caller passes correct usage.
        } else {
            data = new Float32Array((byteSize / 4));
            const floatsPerBoid = stride / 4;
            for (let i = 0; i < count; ++i) {
                const base = i * floatsPerBoid;
                data[base + 0] = Math.random() * 2 - 1; // Pos X
                data[base + 1] = Math.random() * 2 - 1; // Pos Y
                data[base + 2] = Math.random() * 0.1 - 0.05; // Vel X
                data[base + 3] = Math.random() * 0.1 - 0.05; // Vel Y
                if (this.isGame) {
                    data[base + 4] = 0; // Pack ID (Default)
                    data[base + 5] = 0; // Padding
                }
            }
        }

        this.triangleBufferA = this.device.createBuffer({
            size: byteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.triangleBufferB = this.device.createBuffer({
            size: byteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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
                clearValue: [0.05, 0.05, 0.05, 1],
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

        // Ensure we wait for queue to be idle?
        await this.device.queue.onSubmittedWorkDone();

        // Latest buffer is determined by current frameCount state relative to last exec.
        // frame() incremented frameCount.
        // If frameCount = 1 (completed). We computed odd.
        // Odd Frame: useBindGroupA = false. BindGroupB.
        // BindGroupB entries: 2:A (Source), 1:B (Dest?).
        // Wait, my `createBindGroups` logic:
        // GroupA: 0:P, 1:A(Read), 2:B(Write)
        // GroupB: 0:P, 1:B(Read), 2:A(Write)

        // Frame 1 (Odd): useBindGroupA = false. B is used. 1:B(Read), 2:A(Write).
        // Result is in A.
        const resultInBufferA = (this.frameCount % 2 !== 0);
        const latestBuffer = resultInBufferA ? this.triangleBufferA : this.triangleBufferB;

        const stride = this.isGame ? 24 : 16;
        const size = this.params.triangleCount * stride;

        // Align size to 4

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
