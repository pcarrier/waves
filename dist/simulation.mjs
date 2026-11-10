import { fitStructureCDF, laplaceNoise } from "./mechanisms.mjs";
import { fitMomentCDF, pearson } from "./moments.mjs";

export function distribution(weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return total > 0 ? Float64Array.from(weights, (weight) => weight / total) : null;
}

function sourceCDF(probabilities) {
  let total = 0;
  const cdf = Float32Array.from(probabilities, (p) => (total += p));
  cdf[cdf.length - 1] = 1;
  return cdf;
}

function uniform(seed, key) {
  let bits = (seed ^ key) >>> 0;
  bits = Math.imul(bits ^ (bits >>> 16), 0x7feb352d);
  bits = Math.imul(bits ^ (bits >>> 15), 0x846ca68b);
  bits ^= bits >>> 16;
  return ((bits >>> 9) + 0.5) / 8388608;
}

function pick(cdf, target) {
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (target < cdf[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function drawObserved({ probabilities, samples, seed }) {
  const source = sourceCDF(probabilities);
  const observed = new Uint32Array(probabilities.length);
  for (let draw = 0; draw < samples; draw++) {
    observed[pick(source, uniform(seed, draw))]++;
  }
  return observed;
}

const noiseStreams = {
  projected: 0x10000000,
  moments: 0x30000000,
  quadtree: 0x40000000,
  marginals: 0x50000000,
  cosine: 0x60000000,
};

export function preparePrivateCDF(parameters) {
  const observed = drawObserved(parameters);
  const random = (key) => uniform(parameters.seed, noiseStreams[parameters.mechanism] + key);
  const fit = parameters.mechanism === "moments" ? fitMomentCDF : fitStructureCDF;
  return fit(observed, parameters, random);
}

export function simulateCPU(parameters) {
  const { probabilities, samples, epsilon, trials, seed, mechanism = "cells" } = parameters;
  const bins = probabilities.length;
  const output = new Uint32Array(bins * trials);
  const fitted = parameters.fitted ?? (mechanism === "cells" ? null : preparePrivateCDF(parameters));
  const observed = fitted ? null : drawObserved(parameters);
  const cdf = new Float32Array(bins);
  const noiseScale = Math.fround(2 / epsilon);

  for (let trial = 0; trial < trials; trial++) {
    const offset = trial * bins;
    if (fitted) {
      cdf.set(fitted.subarray(offset, offset + bins));
    } else {
      let total = 0;
      for (let bin = 0; bin < bins; bin++) {
        const u = uniform(seed, 0x10000000 + offset + bin);
        const noise = laplaceNoise(u, noiseScale);
        const count = Math.fround(Math.max(0, observed[bin] + noise));
        total = Math.fround(total + count);
        cdf[bin] = total;
      }
    }
    const total = cdf[bins - 1];
    for (let draw = 0; draw < samples; draw++) {
      const u = uniform(seed, 0x20000000 + trial * samples + draw);
      const bin = total > 0 ? pick(cdf, Math.fround(u * total)) : Math.floor(u * bins);
      output[offset + bin]++;
    }
  }
  return output;
}

const shader = /* wgsl */ `
struct Parameters {
  bins: u32,
  samples: u32,
  seed: u32,
  noise_scale: f32,
}

@group(0) @binding(0) var<uniform> params: Parameters;
@group(0) @binding(1) var<storage, read> source_cdf: array<f32>;
@group(0) @binding(2) var<storage, read_write> observed: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> private_cdf: array<f32>;
@group(0) @binding(4) var<storage, read_write> output_counts: array<atomic<u32>>;

fn uniform_draw(key: u32) -> f32 {
  var bits = params.seed ^ key;
  bits = (bits ^ (bits >> 16u)) * 0x7feb352du;
  bits = (bits ^ (bits >> 15u)) * 0x846ca68bu;
  bits ^= bits >> 16u;
  return (f32(bits >> 9u) + 0.5) / 8388608.0;
}

@compute @workgroup_size(128)
fn draw_input(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.samples) { return; }
  let threshold = uniform_draw(id.x);
  var lo = 0u;
  var hi = params.bins - 1u;
  while (lo < hi) {
    let mid = (lo + hi) / 2u;
    if (threshold < source_cdf[mid]) { hi = mid; } else { lo = mid + 1u; }
  }
  atomicAdd(&observed[lo], 1u);
}

@compute @workgroup_size(128)
fn add_noise(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.bins) { return; }
  let index = id.y * params.bins + id.x;
  let u = uniform_draw(0x10000000u + index);
  let noise = -sign(u - 0.5) * log(2.0 * min(u, 1.0 - u)) * params.noise_scale;
  private_cdf[index] = max(0.0, f32(atomicLoad(&observed[id.x])) + noise);
}

@compute @workgroup_size(1)
fn cumulative(@builtin(global_invocation_id) id: vec3u) {
  let offset = id.x * params.bins;
  var total = 0.0;
  for (var bin = 0u; bin < params.bins; bin++) {
    total += private_cdf[offset + bin];
    private_cdf[offset + bin] = total;
  }
}

@compute @workgroup_size(128)
fn draw_output(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.samples) { return; }
  let offset = id.y * params.bins;
  let u = uniform_draw(0x20000000u + id.y * params.samples + id.x);
  let total = private_cdf[offset + params.bins - 1u];
  var bin = u32(u * f32(params.bins));
  if (total > 0.0) {
    let threshold = u * total;
    var lo = 0u;
    var hi = params.bins - 1u;
    while (lo < hi) {
      let mid = (lo + hi) / 2u;
      if (threshold < private_cdf[offset + mid]) { hi = mid; } else { lo = mid + 1u; }
    }
    bin = lo;
  }
  atomicAdd(&output_counts[offset + bin], 1u);
}
`;

export async function createGPU(signal) {
  const adapter = await globalThis.navigator?.gpu?.requestAdapter();
  if (!adapter || signal?.aborted) return null;
  const device = await adapter.requestDevice();
  const destroy = () => device.destroy();
  if (signal?.aborted) {
    destroy();
    return null;
  }
  signal?.addEventListener("abort", destroy, { once: true });
  let lost = false;
  device.lost.then(() => { lost = true; });

  try {
    const module = device.createShaderModule({ code: shader });
    const bindings = device.createBindGroupLayout({
      entries: ["uniform", "read-only-storage", "storage", "storage", "storage"].map(
        (type, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } }),
      ),
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindings] });
    const pipelines = await Promise.all(["draw_input", "add_noise", "cumulative", "draw_output"].map(
      (entryPoint) => device.createComputePipelineAsync({ layout, compute: { module, entryPoint } }),
    ));

    if (signal?.aborted) return null;
    return async ({ probabilities, samples, epsilon, trials, seed, mechanism = "cells", fitted }) => {
      if (mechanism !== "cells" && !fitted) throw new Error("This mechanism requires a fitted distribution");
      if (lost) throw new Error("WebGPU device disconnected");
      const bins = probabilities.length;
      const bytes = bins * trials * 4;
      const usage = GPUBufferUsage;
      const buffers = [];
      const allocate = (size, flags) => {
        const buffer = device.createBuffer({ size, usage: flags });
        buffers.push(buffer);
        return buffer;
      };
      try {
        const params = allocate(16, usage.UNIFORM | usage.COPY_DST);
        const source = allocate(bins * 4, usage.STORAGE | usage.COPY_DST);
        const observed = allocate(bins * 4, usage.STORAGE);
        const privateCDF = allocate(bytes, usage.STORAGE | usage.COPY_DST);
        const output = allocate(bytes, usage.STORAGE | usage.COPY_SRC);
        const readback = allocate(bytes, usage.MAP_READ | usage.COPY_DST);
        const uniforms = new DataView(new ArrayBuffer(16));
        uniforms.setUint32(0, bins, true);
        uniforms.setUint32(4, samples, true);
        uniforms.setUint32(8, seed, true);
        uniforms.setFloat32(12, 2 / epsilon, true);
        device.queue.writeBuffer(params, 0, uniforms);
        if (fitted) device.queue.writeBuffer(privateCDF, 0, fitted);
        else device.queue.writeBuffer(source, 0, sourceCDF(probabilities));
        const bindGroup = device.createBindGroup({
          layout: bindings,
          entries: [params, source, observed, privateCDF, output].map(
            (buffer, binding) => ({ binding, resource: { buffer } }),
          ),
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setBindGroup(0, bindGroup);
        const groups = Math.ceil(samples / 128);
        const dispatches = [[groups, 1], [Math.ceil(bins / 128), trials], [trials, 1], [groups, trials]];
        for (let index = fitted ? 3 : 0; index < dispatches.length; index++) {
          const [x, y] = dispatches[index];
          pass.setPipeline(pipelines[index]);
          pass.dispatchWorkgroups(x, y);
        }
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        return new Uint32Array(readback.getMappedRange().slice(0));
      } finally {
        for (const buffer of buffers) buffer.destroy();
      }
    };
  } catch (error) {
    signal?.removeEventListener("abort", destroy);
    if (!signal?.aborted) destroy();
    throw error;
  }
}

export function compare(output, probabilities, samples, grid) {
  const { width, height } = grid;
  const bins = probabilities.length;
  const runs = [];
  for (let offset = 0; offset < output.length; offset += bins) {
    const values = Float64Array.from(output.subarray(offset, offset + bins), (count) => count / samples);
    const loss = Float64Array.from(values, (value, bin) => value - probabilities[bin]);
    const xLoss = new Float64Array(width);
    const yLoss = new Float64Array(height);
    let jointError = 0;
    loss.forEach((delta, bin) => {
      jointError += Math.abs(delta);
      xLoss[bin % width] += delta;
      yLoss[Math.floor(bin / width)] += delta;
    });
    const absSum = (values) => values.reduce((sum, value) => sum + Math.abs(value), 0);
    runs.push({
      values,
      loss,
      totalVariation: jointError / 2,
      axisVariation: (absSum(xLoss) + absSum(yLoss)) / 4,
      correlation: pearson(values, grid),
    });
  }
  return runs;
}
