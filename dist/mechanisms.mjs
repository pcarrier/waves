export function laplaceNoise(u, scale) {
  return -Math.sign(u - 0.5) * Math.log(2 * Math.min(u, 1 - u)) * scale;
}

// Euclidean projection onto nonnegative counts with a public total.
function projectCounts(values, total) {
  if (total <= 0) return new Float64Array(values.length);
  const sorted = values.slice().sort((a, b) => b - a);
  let sum = 0;
  let threshold = 0;
  for (const [index, value] of sorted.entries()) {
    sum += value;
    const next = (sum - total) / (index + 1);
    if (value <= next) break;
    threshold = next;
  }
  return Float64Array.from(values, (value) => Math.max(0, value - threshold));
}

function noiseCounts(counts, scale, random) {
  return Float64Array.from(counts, (count) => count + laplaceNoise(random(), scale));
}

export function quadtreeDepth({ width, height }) {
  return Math.ceil(Math.log2(Math.max(width, height)));
}

function quadtreeFitter(observed, { samples, epsilon, grid }) {
  const nodes = [];

  function build(left, top, width, height) {
    const index = nodes.length;
    const node = { children: [], count: 0, variance: 1 };
    nodes.push(node);
    if (width === 1 && height === 1) {
      node.bin = top * grid.width + left;
      node.count = observed[node.bin];
      return index;
    }

    const widths = width > 1 ? [Math.floor(width / 2), Math.ceil(width / 2)] : [1];
    const heights = height > 1 ? [Math.floor(height / 2), Math.ceil(height / 2)] : [1];
    let y = top;
    for (const h of heights) {
      let x = left;
      for (const w of widths) {
        const child = build(x, y, w, h);
        node.children.push(child);
        x += w;
      }
      y += h;
    }
    const variance = node.children.reduce((sum, child) => sum + nodes[child].variance, 0);
    node.variance = variance / (1 + variance);
    node.count = node.children.reduce((sum, child) => sum + nodes[child].count, 0);
    return index;
  }

  build(0, 0, grid.width, grid.height);
  const scale = 2 * quadtreeDepth(grid) / epsilon;
  return (random) => {
    const estimate = new Float64Array(nodes.length);
    // Average a node's own noisy count with its independent child sum.
    for (let index = nodes.length - 1; index > 0; index--) {
      const { children, count, variance } = nodes[index];
      const own = count + laplaceNoise(random(), scale);
      const below = children.reduce((sum, child) => sum + estimate[child], 0);
      estimate[index] = own * variance + below * (1 - variance);
    }

    estimate[0] = samples;
    const weights = new Float64Array(observed.length);
    for (const [index, { children, bin }] of nodes.entries()) {
      if (children.length === 0) {
        weights[bin] = estimate[index];
      } else {
        const consistent = projectCounts(children.map((child) => estimate[child]), estimate[index]);
        children.forEach((child, position) => { estimate[child] = consistent[position]; });
      }
    }
    return weights;
  };
}

export function coarseSide(size) {
  return Math.min(4, size);
}

function balanceBlocks(blocks, columns, rows, total) {
  const width = columns.length;
  const height = rows.length;
  const columnSums = new Float64Array(width);

  // Fit the positive noisy seed table to the coarse versions of the two noisy marginals.
  for (let iteration = 0; iteration < 100; iteration++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = 0; x < width; x++) sum += blocks[y * width + x];
      const factor = sum > 0 ? rows[y] / sum : 0;
      for (let x = 0; x < width; x++) blocks[y * width + x] *= factor;
    }
    columnSums.fill(0);
    for (let i = 0; i < blocks.length; i++) columnSums[i % width] += blocks[i];
    if (columnSums.every((sum, x) => Math.abs(sum - columns[x]) <= total * 1e-9)) return;
    if (iteration === 99) break;
    for (let i = 0; i < blocks.length; i++) {
      const x = i % width;
      blocks[i] *= columnSums[x] > 0 ? columns[x] / columnSums[x] : 0;
    }
  }

  // Correct any remaining column imbalance by moving mass within each row.
  const deficits = columns.map((target, x) => Math.max(0, target - columnSums[x]));
  const missing = deficits.reduce((sum, value) => sum + value, 0);
  if (missing === 0) return;
  for (let y = 0; y < height; y++) {
    let removed = 0;
    for (let x = 0; x < width; x++) {
      if (columnSums[x] <= columns[x]) continue;
      const i = y * width + x;
      const transfer = blocks[i] * (1 - columns[x] / columnSums[x]);
      blocks[i] -= transfer;
      removed += transfer;
    }
    for (let x = 0; x < width; x++) blocks[y * width + x] += removed * (deficits[x] / missing);
  }
}

function marginalsFitter(observed, { samples, epsilon, grid: { width, height } }) {
  const columnsCount = coarseSide(width);
  const rowsCount = coarseSide(height);
  const groupX = (x) => Math.floor(x * columnsCount / width);
  const groupY = (y) => Math.floor(y * rowsCount / height);
  const xCounts = new Float64Array(width);
  const yCounts = new Float64Array(height);
  const counts = new Float64Array(columnsCount * rowsCount);
  for (const [bin, count] of observed.entries()) {
    const x = bin % width;
    const y = Math.floor(bin / width);
    xCounts[x] += count;
    yCounts[y] += count;
    counts[groupY(y) * columnsCount + groupX(x)] += count;
  }

  function grouped(countsByBin, group, count) {
    const result = new Float64Array(count);
    countsByBin.forEach((count, bin) => { result[group(bin)] += count; });
    return result;
  }

  const scale = 6 / epsilon;
  return (random) => {
    const xWeights = projectCounts(noiseCounts(xCounts, scale, random), samples);
    const yWeights = projectCounts(noiseCounts(yCounts, scale, random), samples);
    const columns = grouped(xWeights, groupX, columnsCount);
    const rows = grouped(yWeights, groupY, rowsCount);
    const blocks = noiseCounts(counts, scale, random).map((value) => Math.max(0, value) + 1);
    balanceBlocks(blocks, columns, rows, samples);
    const xWithin = xWeights.map((weight, bin) => weight > 0 ? weight / columns[groupX(bin)] : 0);
    const yWithin = yWeights.map((weight, bin) => weight > 0 ? weight / rows[groupY(bin)] : 0);
    return Float64Array.from(observed, (_, bin) => {
      const x = bin % width;
      const y = Math.floor(bin / width);
      return blocks[groupY(y) * columnsCount + groupX(x)] * xWithin[x] * yWithin[y];
    });
  };
}

export function cosineModes({ width, height }, cutoff = 4) {
  const modes = [];
  for (let y = 0; y < Math.min(height, cutoff + 1); y++) {
    for (let x = 0; x < Math.min(width, cutoff + 1 - y); x++) {
      if (x + y > 0) modes.push([x, y]);
    }
  }
  return modes;
}

function cosineBasis(size, cutoff) {
  return Array.from({ length: Math.min(size, cutoff + 1) }, (_, frequency) =>
    Float64Array.from({ length: size }, (_, bin) => Math.cos(Math.PI * frequency * (bin + 0.5) / size)));
}

function cosineFitter(observed, { samples, epsilon, grid, cutoff = 4 }) {
  const { width, height } = grid;
  const modes = cosineModes(grid, cutoff);
  if (!modes.length) return () => new Float64Array(observed.length).fill(samples / observed.length);

  const xBasis = cosineBasis(width, cutoff);
  const yBasis = cosineBasis(height, cutoff);
  // Transform one axis at a time to avoid storing a full grid per mode.
  const rows = xBasis.map((basis) => Float64Array.from({ length: height }, (_, y) => {
    let sum = 0;
    for (let x = 0; x < width; x++) sum += observed[y * width + x] * basis[x];
    return sum;
  }));
  const coefficients = modes.map(([kx, ky]) =>
    rows[kx].reduce((sum, value, y) => sum + value * yBasis[ky][y], 0));
  const scale = 2 * modes.length / epsilon;

  return (random) => {
    const vertical = xBasis.map(() => new Float64Array(height));
    modes.forEach(([kx, ky], index) => {
      // The inverse DCT has a factor of two for each nonconstant axis.
      const multiplier = (kx === 0 ? 1 : 2) * (ky === 0 ? 1 : 2);
      const coefficient = (coefficients[index] + laplaceNoise(random(), scale)) * multiplier;
      for (let y = 0; y < height; y++) vertical[kx][y] += yBasis[ky][y] * coefficient;
    });
    const reconstructed = Float64Array.from(observed, (_, bin) => {
      const x = bin % width;
      const y = Math.floor(bin / width);
      let value = samples;
      for (let kx = 0; kx < xBasis.length; kx++) value += xBasis[kx][x] * vertical[kx][y];
      return value / observed.length;
    });
    return projectCounts(reconstructed, samples);
  };
}

const fitters = {
  projected: (observed, { samples, epsilon }) =>
    (random) => projectCounts(noiseCounts(observed, 2 / epsilon, random), samples),
  quadtree: quadtreeFitter,
  marginals: marginalsFitter,
  cosine: cosineFitter,
};

export function fitStructureCDF(observed, parameters, uniform) {
  const fit = fitters[parameters.mechanism](observed, parameters);
  const output = new Float32Array(observed.length * parameters.trials);
  let key = 0;
  const random = () => uniform(key++);

  for (let trial = 0; trial < parameters.trials; trial++) {
    const weights = fit(random);
    let total = 0;
    for (let bin = 0; bin < observed.length; bin++) {
      total += weights[bin];
      output[trial * observed.length + bin] = total;
    }
  }
  return output;
}
