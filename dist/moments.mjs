const dimensions = 5;
const ridge = 0.001;

function gridFeatures({ width, height }) {
  const features = new Float64Array(width * height * dimensions);
  for (let y = 0; y < height; y++) {
    const v = (2 * y) / (height - 1) - 1;
    for (let x = 0; x < width; x++) {
      const u = (2 * x) / (width - 1) - 1;
      features.set([u, v, u * u, v * v, u * v], (y * width + x) * dimensions);
    }
  }
  return features;
}

function evaluate(theta, target, features, weights, derivatives) {
  let maxLogWeight = -Infinity;
  for (let bin = 0; bin < weights.length; bin++) {
    let logWeight = 0;
    for (let j = 0; j < dimensions; j++) {
      logWeight += theta[j] * features[bin * dimensions + j];
    }
    weights[bin] = logWeight;
    maxLogWeight = Math.max(maxLogWeight, logWeight);
  }

  let total = 0;
  const mean = new Float64Array(dimensions);
  const hessian = Array.from({ length: dimensions }, () => new Float64Array(dimensions));
  for (let bin = 0; bin < weights.length; bin++) {
    const weight = Math.exp(weights[bin] - maxLogWeight);
    weights[bin] = weight;
    total += weight;
    if (!derivatives) continue;
    const offset = bin * dimensions;
    for (let j = 0; j < dimensions; j++) {
      const weighted = features[offset + j] * weight;
      mean[j] += weighted;
      for (let k = 0; k <= j; k++) hessian[j][k] += weighted * features[offset + k];
    }
  }

  let objective = maxLogWeight + Math.log(total);
  for (let j = 0; j < dimensions; j++) {
    objective += 0.5 * ridge * theta[j] ** 2 - theta[j] * target[j];
  }
  if (!derivatives) return { objective };

  const gradient = Float64Array.from(mean, (sum, j) => sum / total - target[j] + ridge * theta[j]);
  for (let j = 0; j < dimensions; j++) {
    for (let k = 0; k <= j; k++) {
      hessian[j][k] = hessian[j][k] / total - (mean[j] * mean[k]) / total ** 2;
      hessian[k][j] = hessian[j][k];
    }
    hessian[j][j] += ridge;
  }
  return { objective, gradient, hessian };
}

// The regularizer keeps the Hessian positive definite, so elimination needs no pivoting.
function solve(hessian, gradient) {
  for (let j = 0; j < dimensions; j++) {
    for (let k = j + 1; k < dimensions; k++) {
      const scale = hessian[k][j] / hessian[j][j];
      for (let m = j + 1; m < dimensions; m++) hessian[k][m] -= scale * hessian[j][m];
      gradient[k] -= scale * gradient[j];
    }
  }
  const step = new Float64Array(dimensions);
  for (let j = dimensions - 1; j >= 0; j--) {
    let value = gradient[j];
    for (let k = j + 1; k < dimensions; k++) value -= hessian[j][k] * step[k];
    step[j] = value / hessian[j][j];
  }
  return step;
}

function fit(target, features, weights) {
  let theta = new Float64Array(dimensions);
  for (let iteration = 0; iteration < 24; iteration++) {
    const { objective, gradient, hessian } = evaluate(theta, target, features, weights, true);
    if (gradient.every((value) => Math.abs(value) < 1e-7)) break;
    const step = solve(hessian, gradient);
    let accepted = false;
    for (let scale = 1; scale >= 1 / 1024; scale /= 2) {
      const candidate = theta.map((value, j) => value - scale * step[j]);
      if (evaluate(candidate, target, features, weights, false).objective < objective) {
        theta = candidate;
        accepted = true;
        break;
      }
    }
    if (!accepted) break;
  }
  evaluate(theta, target, features, weights, false);
}

export function fitMomentCDF(observed, { samples, epsilon, trials, grid }, random) {
  const features = gridFeatures(grid);
  const sums = new Float64Array(dimensions);
  for (let bin = 0; bin < observed.length; bin++) {
    for (let j = 0; j < dimensions; j++) {
      sums[j] += observed[bin] * features[bin * dimensions + j];
    }
  }

  const lowerBounds = [-1, -1, 0, 0, -1];
  const output = new Float32Array(observed.length * trials);
  const weights = new Float64Array(observed.length);
  for (let trial = 0; trial < trials; trial++) {
    const target = sums.map((sum, j) => {
      const u = random(trial * dimensions + j);
      const range = 1 - lowerBounds[j];
      const scale = (range * dimensions) / (samples * epsilon);
      const noise = -Math.sign(u - 0.5) * Math.log(2 * Math.min(u, 1 - u)) * scale;
      return Math.min(1, Math.max(lowerBounds[j], sum / samples + noise));
    });
    fit(target, features, weights);
    let total = 0;
    for (let bin = 0; bin < weights.length; bin++) {
      total += weights[bin];
      output[trial * weights.length + bin] = total;
    }
  }
  return output;
}

export function pearson(probabilities, { width }) {
  let meanX = 0;
  let meanY = 0;
  for (let bin = 0; bin < probabilities.length; bin++) {
    meanX += (bin % width) * probabilities[bin];
    meanY += Math.floor(bin / width) * probabilities[bin];
  }

  let varianceX = 0;
  let varianceY = 0;
  let covariance = 0;
  for (let bin = 0; bin < probabilities.length; bin++) {
    const dx = bin % width - meanX;
    const dy = Math.floor(bin / width) - meanY;
    const p = probabilities[bin];
    varianceX += p * dx ** 2;
    varianceY += p * dy ** 2;
    covariance += p * dx * dy;
  }
  if (varianceX < 1e-20 || varianceY < 1e-20) return null;
  return Math.max(-1, Math.min(1, covariance / Math.sqrt(varianceX * varianceY)));
}
