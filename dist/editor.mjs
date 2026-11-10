import { drawHeatmap, moveCell, pointerCell } from "./heatmap.mjs";
import { restoreValue } from "./workspace.mjs";

function presetWeights(preset, { width, height }) {
  return Float64Array.from({ length: width * height }, (_, bin) => {
    const x = (bin % width + 0.5) / width;
    const y = (Math.floor(bin / width) + 0.5) / height;
    if (preset === "clear") return 0;
    if (preset === "uniform") return 0.58;
    if (preset === "checker") {
      const tileX = Math.floor(x * Math.min(width, 4));
      const tileY = Math.floor(y * Math.min(height, 4));
      return (tileX + tileY) % 2 ? 0.85 : 0.055;
    }
    if (preset === "ridge") return 0.01 + 0.98 * Math.exp(-((x - y) ** 2) / 0.021);
    const first = Math.exp(-((x - 0.31) ** 2 / 0.031 + (y - 0.29) ** 2 / 0.015));
    const second = Math.exp(-((x - 0.70) ** 2 / 0.018 + (y - 0.69) ** 2 / 0.029));
    return Math.min(1, 0.016 + first * 0.96 + second * 0.82);
  });
}

function resizeWeights(weights, before, after) {
  const scaleX = before.width / after.width;
  const scaleY = before.height / after.height;
  const resized = new Float64Array(after.width * after.height);
  for (let y = 0; y < after.height; y++) {
    const top = y * scaleY;
    const bottom = (y + 1) * scaleY;
    for (let x = 0; x < after.width; x++) {
      const left = x * scaleX;
      const right = (x + 1) * scaleX;
      let mass = 0;
      for (let row = Math.floor(top); row < Math.min(before.height, Math.ceil(bottom)); row++) {
        for (let col = Math.floor(left); col < Math.min(before.width, Math.ceil(right)); col++) {
          const area = (Math.min(bottom, row + 1) - Math.max(top, row))
            * (Math.min(right, col + 1) - Math.max(left, col));
          mass += area * weights[row * before.width + col];
        }
      }
      resized[y * after.width + x] = Math.min(1, Math.max(0, mass / (scaleX * scaleY)));
    }
  }
  return resized;
}

function validDimension(value, input) {
  return Number.isInteger(value) && value >= Number(input.min) && value <= Number(input.max);
}

export function createEditor({ saved, onChange, onSettingsChange }) {
  const get = (id) => document.getElementById(id);
  const canvas = get("paint");
  const viewport = get("viewport");
  const chart = viewport.parentElement;
  const bitmap = document.createElement("canvas");
  const preset = get("preset");
  const palette = get("editor-palette");
  const resolution = get("resolution-form");
  const widthInput = get("resolution-width");
  const heightInput = get("resolution-height");
  const undoButton = get("tool-undo");
  const brushSize = get("size");
  const strength = get("strength");
  const [cellLabel, binLabel] = get("editor-readout").children;
  const zooms = [1, 1.5, 2, 3, 4];
  const undoStack = [];
  const savedGrid = saved?.grid;
  const savedWeights = saved?.weights;
  let grid = { width: Number(widthInput.defaultValue), height: Number(heightInput.defaultValue) };
  let weights;
  if (validDimension(savedGrid?.width, widthInput) && validDimension(savedGrid?.height, heightInput)
      && Array.isArray(savedWeights) && savedWeights.length === savedGrid.width * savedGrid.height
      && savedWeights.every((weight) => Number.isFinite(weight) && weight >= 0 && weight <= 1)) {
    grid = { width: savedGrid.width, height: savedGrid.height };
    weights = Float64Array.from(savedWeights);
    restoreValue(preset, saved.preset);
  } else {
    weights = presetWeights(preset.value, grid);
  }
  widthInput.value = grid.width;
  heightInput.value = grid.height;
  restoreValue(widthInput, saved?.widthDraft);
  restoreValue(heightInput, saved?.heightDraft);
  restoreValue(palette, saved?.palette);
  restoreValue(brushSize, saved?.size);
  restoreValue(strength, saved?.strength);
  let tool = ["brush", "erase", "pan"].includes(saved?.tool) ? saved.tool : "brush";
  let zoom = Number.isInteger(saved?.zoom) && saved.zoom >= 0 && saved.zoom < zooms.length ? saved.zoom : 0;
  let hover = null;
  let keyboardCell = { x: 0, y: 0 };
  let cellSelected = false;
  let scrollX = Number.isFinite(saved?.scrollX) ? saved.scrollX : 0;
  let scrollY = Number.isFinite(saved?.scrollY) ? saved.scrollY : 0;
  let needsScrollRestore = true;
  let stroke = null;
  let pan = null;
  let bitmapDirty = true;
  let pendingFrame = 0;

  function paintFrame() {
    pendingFrame = 0;
    if (bitmapDirty) {
      drawHeatmap(bitmap, weights, grid, palette.value, 1);
      bitmapDirty = false;
    }
    const ctx = canvas.getContext("2d");
    const cellWidth = canvas.width / grid.width;
    const cellHeight = canvas.height / grid.height;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (canvas.clientWidth / grid.width >= 5) {
      ctx.beginPath();
      ctx.strokeStyle = "#0005";
      ctx.lineWidth = 1;
      for (let x = 1; x < grid.width; x++) {
        const step = Math.round(x * cellWidth) + 0.5;
        ctx.moveTo(step, 0);
        ctx.lineTo(step, canvas.height);
      }
      for (let y = 1; y < grid.height; y++) {
        const step = Math.round(y * cellHeight) + 0.5;
        ctx.moveTo(0, step);
        ctx.lineTo(canvas.width, step);
      }
      ctx.stroke();
    }
    const selected = tool === "pan" ? null : hover ?? (cellSelected || document.activeElement === canvas ? keyboardCell : null);
    if (selected) {
      const left = selected.x * cellWidth;
      const top = selected.y * cellHeight;
      ctx.lineWidth = Math.max(1, devicePixelRatio);
      ctx.strokeStyle = "#100c1c";
      ctx.strokeRect(left + 0.5, top + 0.5, cellWidth - 1, cellHeight - 1);
      ctx.strokeStyle = "#eadbff";
      ctx.strokeRect(left + 1.5, top + 1.5, cellWidth - 3, cellHeight - 3);
      cellLabel.textContent = `X ${selected.x + 1} · Y ${selected.y + 1} · Weight ${weights[selected.y * grid.width + selected.x].toFixed(2)}`;
    } else {
      cellLabel.textContent = tool === "pan" ? "Drag to pan" : "Drag to paint";
    }
    binLabel.textContent = `${(grid.width * grid.height).toLocaleString()} bins`;
  }

  function schedulePaint(dirty = false) {
    bitmapDirty ||= dirty;
    if (!pendingFrame) pendingFrame = requestAnimationFrame(paintFrame);
  }

  function resizeCanvas() {
    const available = chart.getBoundingClientRect().right - viewport.getBoundingClientRect().left - 2;
    if (available <= 0) return;
    const cellSize = available * zooms[zoom] / Math.max(grid.width, grid.height);
    const width = cellSize * grid.width;
    const height = cellSize * grid.height;
    chart.style.setProperty("--view-width", `${Math.min(available, width) + 2}px`);
    viewport.style.height = `${Math.min(available, height) + 2}px`;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const pixelRatio = Math.min(devicePixelRatio, 4096 / Math.max(width, height));
    const pixelWidth = Math.max(1, Math.round(width * pixelRatio));
    const pixelHeight = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    schedulePaint();
  }

  function changeZoom(next) {
    const previous = zoom;
    const width = canvas.clientWidth || viewport.clientWidth;
    const height = canvas.clientHeight || viewport.clientHeight;
    const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / width;
    const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / height;
    zoom = Math.max(0, Math.min(zooms.length - 1, next));
    resizeCanvas();
    viewport.scrollLeft = centerX * canvas.clientWidth - viewport.clientWidth / 2;
    viewport.scrollTop = centerY * canvas.clientHeight - viewport.clientHeight / 2;
    get("zoom-fit").textContent = zoom ? `${zooms[zoom] * 100}%` : "Fit";
    get("zoom-out").disabled = zoom === 0;
    get("zoom-in").disabled = zoom === zooms.length - 1;
    if (zoom !== previous) onSettingsChange();
  }

  function setTool(next) {
    const previous = tool;
    tool = next;
    canvas.dataset.tool = tool;
    schedulePaint();
    for (const [id, key] of [["tool-brush", "brush"], ["erase", "erase"], ["pan", "pan"]]) {
      const active = tool === key;
      get(id).classList.toggle("active", active);
      get(id).setAttribute("aria-pressed", active);
    }
    if (tool !== previous) onSettingsChange();
  }

  function snapshot() {
    return { weights: weights.slice(), grid, preset: preset.value };
  }

  function scrollRange() {
    return {
      x: viewport.scrollWidth - viewport.clientWidth,
      y: viewport.scrollHeight - viewport.clientHeight,
    };
  }

  function rememberScroll() {
    if (needsScrollRestore || !viewport.clientWidth) return;
    const range = scrollRange();
    scrollX = range.x ? viewport.scrollLeft / range.x : 0;
    scrollY = range.y ? viewport.scrollTop / range.y : 0;
  }

  function restoreScroll() {
    if (!needsScrollRestore || !viewport.clientWidth) return;
    const range = scrollRange();
    viewport.scrollLeft = range.x * scrollX;
    viewport.scrollTop = range.y * scrollY;
    needsScrollRestore = false;
  }

  function saveState() {
    rememberScroll();
    return {
      grid,
      weights: Array.from(weights),
      preset: preset.value,
      widthDraft: widthInput.value,
      heightDraft: heightInput.value,
      palette: palette.value,
      size: brushSize.value,
      strength: strength.value,
      tool,
      zoom,
      scrollX,
      scrollY,
    };
  }

  function keepUndo(previous) {
    undoStack.push(previous);
    if (undoStack.length > 40) undoStack.shift();
    undoButton.disabled = false;
  }

  function refreshGrid() {
    get("axis-x-max").textContent = String(grid.width).padStart(2, "0");
    get("axis-y-max").textContent = String(grid.height).padStart(2, "0");
    keyboardCell = { x: Math.min(grid.width - 1, keyboardCell.x), y: Math.min(grid.height - 1, keyboardCell.y) };
    hover = null;
    resizeCanvas();
    schedulePaint(true);
  }

  function changed() {
    refreshGrid();
    onChange();
  }

  function undo() {
    if (!undoStack.length || stroke) return;
    const previous = undoStack.pop();
    ({ weights, grid } = previous);
    preset.value = previous.preset;
    widthInput.value = grid.width;
    heightInput.value = grid.height;
    undoButton.disabled = !undoStack.length;
    changed();
  }

  function stamp(cell, state) {
    const width = Number(brushSize.value);
    const reach = (width - 1) / 2;
    const amount = (Number(strength.value) / 100) * (tool === "erase" ? -1 : 1);
    let dirty = false;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = cell.x + dx;
        const y = cell.y + dy;
        if (dx ** 2 + dy ** 2 > (width / 2) ** 2 || x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
        const index = y * grid.width + x;
        if (state.visited.has(index)) continue;
        state.visited.add(index);
        const next = Math.max(0, Math.min(1, weights[index] + amount));
        if (next === weights[index]) continue;
        weights[index] = next;
        dirty = true;
      }
    }
    if (dirty) {
      if (!state.dirty) {
        keepUndo(state.before);
        preset.value = "custom";
      }
      state.dirty = true;
      onChange();
    }
    schedulePaint(dirty);
  }

  function drag(cell) {
    const { x, y } = stroke.last;
    const steps = Math.max(Math.abs(x - cell.x), Math.abs(y - cell.y));
    for (let step = 1; step <= steps; step++) {
      stamp({ x: Math.round(x + (cell.x - x) * step / steps), y: Math.round(y + (cell.y - y) * step / steps) }, stroke);
    }
    stroke.last = cell;
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || stroke || pan) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    if (tool === "pan") {
      pan = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      canvas.dataset.panning = "true";
      return;
    }
    hover = keyboardCell = pointerCell(event, canvas, grid);
    cellSelected = true;
    stroke = { pointer: event.pointerId, before: snapshot(), last: hover, visited: new Set(), dirty: false };
    stamp(hover, stroke);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!event.isPrimary) return;
    if (pan?.pointer === event.pointerId) {
      viewport.scrollLeft = pan.left + pan.x - event.clientX;
      viewport.scrollTop = pan.top + pan.y - event.clientY;
      return;
    }
    hover = pointerCell(event, canvas, grid);
    if (stroke?.pointer === event.pointerId) drag(hover);
    schedulePaint();
  });
  canvas.addEventListener("pointerleave", () => { hover = null; schedulePaint(); });
  canvas.addEventListener("pointerup", (event) => {
    if (stroke?.pointer !== event.pointerId) return;
    drag(pointerCell(event, canvas, grid));
    keyboardCell = stroke.last;
    hover = event.pointerType === "mouse" ? keyboardCell : null;
    stroke = null;
    schedulePaint();
  });
  canvas.addEventListener("lostpointercapture", () => {
    stroke = null;
    pan = null;
    delete canvas.dataset.panning;
  });
  canvas.addEventListener("focus", () => schedulePaint());
  canvas.addEventListener("blur", () => schedulePaint());
  canvas.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const next = moveCell(event.key, keyboardCell, grid);
    if (next) {
      event.preventDefault();
      hover = null;
      keyboardCell = next;
      cellSelected = true;
      const cellWidth = canvas.clientWidth / grid.width;
      const cellHeight = canvas.clientHeight / grid.height;
      const left = keyboardCell.x * cellWidth;
      const top = keyboardCell.y * cellHeight;
      viewport.scrollLeft = Math.min(left, Math.max(left + cellWidth - viewport.clientWidth, viewport.scrollLeft));
      viewport.scrollTop = Math.min(top, Math.max(top + cellHeight - viewport.clientHeight, viewport.scrollTop));
      schedulePaint();
    } else if (event.key === " " && tool !== "pan") {
      event.preventDefault();
      hover = null;
      cellSelected = true;
      stamp(keyboardCell, { before: snapshot(), visited: new Set(), dirty: false });
    } else if (event.key.toLowerCase() === "b") setTool("brush");
    else if (event.key.toLowerCase() === "e") setTool("erase");
    else if (event.key.toLowerCase() === "h") setTool("pan");
  });

  let previousPreset = preset.value;
  // Remember the old preset before the native select updates its value.
  preset.addEventListener("focus", () => { previousPreset = preset.value; });
  preset.addEventListener("change", () => {
    keepUndo({ ...snapshot(), preset: previousPreset });
    previousPreset = preset.value;
    weights = presetWeights(preset.value, grid);
    changed();
  });
  resolution.addEventListener("input", onSettingsChange);
  resolution.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = { width: widthInput.valueAsNumber, height: heightInput.valueAsNumber };
    if (stroke || pan || (next.width === grid.width && next.height === grid.height)) return;
    keepUndo(snapshot());
    weights = preset.value === "custom" ? resizeWeights(weights, grid, next) : presetWeights(preset.value, next);
    grid = next;
    changed();
  });
  palette.addEventListener("change", () => {
    schedulePaint(true);
    onSettingsChange();
  });
  get("tool-brush").addEventListener("click", () => setTool("brush"));
  get("erase").addEventListener("click", () => setTool("erase"));
  get("pan").addEventListener("click", () => setTool("pan"));
  undoButton.addEventListener("click", undo);
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z"
        && !event.target.closest("input, select, textarea, [contenteditable]") && undoStack.length) {
      event.preventDefault();
      undo();
    }
  });
  get("zoom-out").addEventListener("click", () => changeZoom(zoom - 1));
  get("zoom-in").addEventListener("click", () => changeZoom(zoom + 1));
  get("zoom-fit").addEventListener("click", () => changeZoom(0));
  function updateBrushLabels() {
    get("size-value").textContent = brushSize.value === "1" ? "1 cell" : `${brushSize.value} cells`;
    get("strength-value").textContent = strength.value + "%";
  }
  for (const field of [brushSize, strength]) {
    field.addEventListener("input", () => {
      updateBrushLabels();
      onSettingsChange();
    });
  }
  updateBrushLabels();
  setTool(tool);
  refreshGrid();
  changeZoom(zoom);
  restoreScroll();
  viewport.addEventListener("scroll", () => {
    if (!viewport.clientWidth) return;
    rememberScroll();
    onSettingsChange();
  });
  new ResizeObserver(() => {
    if (!chart.clientWidth) {
      needsScrollRestore = true;
      return;
    }
    resizeCanvas();
    restoreScroll();
  }).observe(chart);

  return { snapshot, saveState, get grid() { return grid; }, hasMass: () => weights.some((weight) => weight > 0) };
}
