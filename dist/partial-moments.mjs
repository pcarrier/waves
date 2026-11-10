import { laplaceNoise } from "./mechanisms.mjs";

function randomStream(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let bits = Math.imul(seed ^ (seed >>> 15), seed | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    return (((bits ^ (bits >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
}

export const partialMechanisms = {
  moments: "Laplace moments",
  split: "Split-budget moments",
  covariance: "Direct covariance",
};

export function partialVariableName(index) {
  return ["X", "Y", "Z", "W"][index] ?? `V${index + 1}`;
}

export function defaultPartialFactors(index, preset = "reversal") {
  if (preset === "independent") return [0, 0, 1];
  if (preset === "shared") return [0.8, 0, 0.2];
  const first = [[0.58, 0.25, 0.17], [0.58, -0.25, 0.17], [1, 0, 0], [0, 1, 0], [0.98, 0, 0.02]];
  if (index < first.length) return first[index];
  const a = [-0.4, 0.26, 0.5][(index - 4) % 3];
  const b = index % 2 ? 0.28 : -0.32;
  return [a, b, Number((1 - Math.abs(a) - Math.abs(b)).toFixed(2))];
}

export function samplePartialMoments({ variables, samples, seed, factors }) {
  const random = randomStream(seed);
  const uniform = () => 2 * random() - 1;
  const rows = Array.from({ length: variables }, (_, i) => {
    const [a, b, own] = factors?.[i] ?? defaultPartialFactors(i);
    const scale = Math.max(1, Math.abs(a) + Math.abs(b) + own);
    const draw = i < 2 ? random : randomStream(seed ^ Math.imul(i - 3, 0x9e3779b9));
    return { a: a / scale, b: b / scale, own: own / scale, draw };
  });
  const values = new Float64Array(variables);
  const mean = new Float64Array(variables);
  const second = new Float64Array(variables * variables);
  for (let row = 0; row < samples; row++) {
    const z = uniform();
    const w = uniform();
    for (let i = 0; i < variables; i++) {
      const { a, b, own, draw } = rows[i];
      values[i] = a * z + b * w + own * (2 * draw() - 1);
    }
    for (let i = 0; i < variables; i++) {
      const value = values[i];
      mean[i] += value;
      for (let j = 0; j <= i; j++) second[i * variables + j] += value * values[j];
    }
  }
  return { mean: mean.map((sum) => sum / samples), second: second.map((sum) => sum / samples) };
}

function covariance({ mean, second }) {
  const variables = mean.length;
  const matrix = new Float64Array(variables * variables);
  for (let i = 0; i < variables; i++) {
    for (let j = 0; j <= i; j++) {
      matrix[i * variables + j] = matrix[j * variables + i] = second[i * variables + j] - mean[i] * mean[j];
    }
  }
  return matrix;
}

function positiveDefinite(matrix, variables, shift, lower) {
  for (let i = 0; i < variables; i++) {
    for (let j = 0; j <= i; j++) {
      let value = matrix[i * variables + j];
      for (let k = 0; k < j; k++) value -= lower[i * variables + k] * lower[j * variables + k];
      if (i === j) {
        if (value + shift <= 0) return false;
        lower[i * variables + j] = Math.sqrt(value + shift);
      } else {
        lower[i * variables + j] = value / lower[j * variables + j];
      }
    }
  }
  return true;
}

function stabilize(matrix, variables, floor) {
  const lower = new Float64Array(matrix.length);
  if (positiveDefinite(matrix, variables, -floor, lower)) return matrix;

  // Find a diagonal shift that gives the noisy covariance a positive eigenvalue floor.
  let low = -floor;
  let high = floor;
  while (!positiveDefinite(matrix, variables, high, lower)) high *= 2;
  for (let step = 0; step < 18; step++) {
    const mid = (low + high) / 2;
    if (positiveDefinite(matrix, variables, mid, lower)) high = mid;
    else low = mid;
  }
  for (let i = 0; i < variables; i++) matrix[i * variables + i] += high + floor;
  return matrix;
}

export function simulatePartialMoments(settings, moments = samplePartialMoments(settings)) {
  const { variables, samples, epsilon, trials, seed, mechanism = "moments", share = 0.7, floor = 0.001 } = settings;
  const reference = covariance(moments);
  const random = randomStream(seed ^ 0x6c8e9cf5);
  // Under replace-one adjacency, the mean, squared and cross-product terms
  // have total L1 sensitivity (2d + d + d(d-1)) / N for d variables in [-1, 1].
  const scale = variables * (variables + 2) / (samples * epsilon);
  const marginalScale = mechanism === "split" ? 3 * variables / (samples * epsilon * (1 - share)) : scale;
  const crossScale = mechanism === "split" ? variables * (variables - 1) / (samples * epsilon * share) : scale;
  const noise = (scale) => laplaceNoise(random(), scale);
  const releases = Array.from({ length: trials }, () => {
    if (mechanism === "covariance") {
      // A replacement changes only the N−1 affected row pairs in the pairwise covariance sum.
      const covarianceScale = 4 * variables ** 2 * (samples - 1) / (samples ** 2 * epsilon);
      const matrix = reference.slice();
      for (let i = 0; i < variables; i++) {
        for (let j = 0; j <= i; j++) {
          const value = reference[i * variables + j] + noise(covarianceScale);
          matrix[i * variables + j] = matrix[j * variables + i] = Math.max(i === j ? 0 : -1, Math.min(1, value));
        }
      }
      return stabilize(matrix, variables, floor);
    }
    const mean = moments.mean.map((value) => Math.max(-1, Math.min(1, value + noise(marginalScale))));
    const second = new Float64Array(moments.second.length);
    for (let i = 0; i < variables; i++) {
      for (let j = 0; j <= i; j++) {
        const index = i * variables + j;
        second[index] = Math.max(i === j ? 0 : -1, Math.min(1, moments.second[index] + noise(i === j ? marginalScale : crossScale)));
      }
    }
    return stabilize(covariance({ mean, second }), variables, floor);
  });
  return { variables, reference, releases };
}

function correlation(matrix, variables, i, j, control) {
  const value = (row, column) => matrix[row * variables + column];
  const varianceX = value(i, i);
  const varianceY = value(j, j);
  let x = varianceX;
  let y = varianceY;
  let xy = value(i, j);
  if (control !== undefined) {
    const variance = value(control, control);
    if (variance <= 1e-12) return { r: null, weak: true };
    const xz = value(i, control);
    const yz = value(j, control);
    x -= xz * xz / variance;
    y -= yz * yz / variance;
    xy -= xz * yz / variance;
  }
  if (x <= 1e-12 || y <= 1e-12) return { r: null, weak: true };
  return {
    r: Math.max(-1, Math.min(1, xy / Math.sqrt(x * y))),
    weak: x < 0.05 * varianceX || y < 0.05 * varianceY,
  };
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = probability * (sorted.length - 1);
  const low = Math.floor(position);
  return sorted[low] + (position - low) * (sorted[Math.ceil(position)] - sorted[low]);
}

export function comparePartialPair({ variables, reference, releases }, control, i, j) {
  const { r: original, weak } = correlation(reference, variables, i, j, control);
  const estimates = releases.map((matrix) => correlation(matrix, variables, i, j, control).r)
    .filter((value) => value !== null).sort((a, b) => a - b);
  const median = quantile(estimates, 0.5);
  return {
    i, j, weak, original, median, estimates,
    ordinary: correlation(reference, variables, i, j).r,
    low: quantile(estimates, 0.1), high: quantile(estimates, 0.9),
    delta: original === null || median === null ? null : median - original,
    validRuns: estimates.length,
    matchingRuns: original === null || Math.abs(original) < 0.05 || !estimates.length ? null
      : estimates.filter((value) => Math.sign(value) === Math.sign(original)).length,
  };
}

export function comparePartialPairs(simulation, control) {
  const { variables } = simulation;
  const pairs = new Map();
  for (let i = 0; i < variables; i++) {
    if (i === control) continue;
    for (let j = i + 1; j < variables; j++) {
      if (j === control) continue;
      pairs.set(`${i}:${j}`, comparePartialPair(simulation, control, i, j));
    }
  }
  return pairs;
}
