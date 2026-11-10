const palettes = {
  gray: ["14151c", "41424f", "858693", "c5c5d0", "f4f3f8"],
  rainbow: ["151225", "452879", "4753cb", "1baac6", "65d49a", "e7e963", "ff6f86"],
  violet: ["141120", "39245e", "6b469f", "b580e8", "f0deff"],
  negative: ["1c1b28", "3f3679", "6b5cce", "9ba1ff"],
  positive: ["1c1b28", "7b384c", "ce665b", "ffb27c"],
};

const rgb = Object.fromEntries(Object.entries(palettes).map(([name, colors]) => [
  name,
  colors.map((color) => [0, 2, 4].map((index) => parseInt(color.slice(index, index + 2), 16))),
]));

export function gradient(name, reverse = false) {
  const stops = reverse ? [...palettes[name]].reverse() : palettes[name];
  return "linear-gradient(to right, " + stops.map((color) => "#" + color).join(", ") + ")";
}

export function drawHeatmap(canvas, values, { width, height }, palette, maximum) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  for (let bin = 0; bin < values.length; bin++) {
    const value = values[bin];
    const ramp = rgb[palette === "signed" ? (value < 0 ? "negative" : "positive") : palette];
    const position = Math.min(1, Math.abs(value) / (maximum || 1)) * (ramp.length - 1);
    const left = Math.min(ramp.length - 2, Math.floor(position));
    const fraction = position - left;
    for (let channel = 0; channel < 3; channel++) {
      image.data[bin * 4 + channel] = ramp[left][channel] * (1 - fraction) + ramp[left + 1][channel] * fraction;
    }
    image.data[bin * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

export function pointerCell(event, canvas, { width, height }) {
  const bounds = canvas.getBoundingClientRect();
  const index = (position, origin, length, bins) =>
    Math.max(0, Math.min(bins - 1, Math.floor(((position - origin) / length) * bins)));
  return { x: index(event.clientX, bounds.left, bounds.width, width), y: index(event.clientY, bounds.top, bounds.height, height) };
}

export function moveCell(key, { x, y }, { width, height }) {
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (!Object.hasOwn(directions, key)) return null;
  const [dx, dy] = directions[key];
  return { x: Math.max(0, Math.min(width - 1, x + dx)), y: Math.max(0, Math.min(height - 1, y + dy)) };
}
