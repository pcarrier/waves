import { drawHeatmap, gradient, moveCell, pointerCell } from "./heatmap.mjs";

export const inspectHint = "Hover to preview a bin. Click or tap to pin its stats. Press Esc to clear.";
export const percent = (value, digits = 2) => (value * 100).toFixed(digits) + "%";
export const formatR = (value) => value === null ? "—" : value.toFixed(2).replace("-", "−");
const formatPP = (value) => (value * 100).toFixed(3) + " pp";

export function plotMaximum(runs, view, probabilities) {
  const peak = (values, current = 0) => values.reduce((max, value) => Math.max(max, Math.abs(value)), current);
  const histogram = view === "histogram";
  return runs.reduce((max, run) => peak(histogram ? run.values : run.loss, max), histogram ? peak(probabilities) : 0);
}

export function setLegend(target, view, palette, maximum) {
  const signed = view === "signed";
  const endLabel = view === "histogram" ? percent(maximum, 3) : formatPP(maximum);
  target.classList.toggle("symmetric", signed);
  const labels = signed ? [maximum === 0 ? endLabel : "−" + endLabel, "0", endLabel] : ["0", endLabel];
  const fills = signed ? [gradient("negative", true), gradient("positive")] : [gradient(palette)];
  target.replaceChildren();
  for (const [index, value] of labels.entries()) {
    const label = document.createElement("span");
    label.textContent = value;
    target.append(label);
    if (index < fills.length) {
      const bar = document.createElement("span");
      bar.className = "legend-bar";
      bar.style.backgroundImage = fills[index];
      target.append(bar);
    }
  }
}

export function createPlotInspector(readout) {
  function clear() {
    delete readout.dataset.pinned;
    readout.textContent = inspectHint;
  }

  clear();
  return {
    preview(stats = inspectHint) {
      if (!readout.hasAttribute("data-pinned")) readout.textContent = stats;
    },
    pin(stats) {
      readout.dataset.pinned = "true";
      readout.textContent = stats;
    },
    clear,
  };
}

export function createPlot(name, run, { grid, probabilities, view, palette, maximum, inspector, showName = true }) {
  const histogram = view === "histogram";
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", `${name}, ${histogram ? "synthetic histogram" : "loss table"}. Use arrow keys to inspect bins.`);
  drawHeatmap(canvas, histogram ? run.values : run.loss, grid, view === "signed" ? "signed" : palette, maximum);
  if (grid.height > grid.width) canvas.style.width = `${100 * grid.width / grid.height}%`;

  const stats = ({ x, y }) => {
    const bin = y * grid.width + x;
    const delta = run.loss[bin];
    const sign = delta > 0 ? "+" : "";
    const suffix = view === "absolute" ? `|Δ| ${formatPP(Math.abs(delta))}` : `Δ ${sign}${formatPP(delta)}`;
    return `${name} · X ${x + 1} / Y ${y + 1} · Painted ${percent(probabilities[bin], 3)} · Synthetic ${percent(run.values[bin], 3)} · ${suffix}`;
  };
  let keyboardCell = { x: 0, y: 0 };
  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch") inspector.preview(stats(pointerCell(event, canvas, grid)));
  });
  canvas.addEventListener("pointerleave", () => {
    inspector.preview(document.activeElement === canvas ? stats(keyboardCell) : undefined);
  });
  canvas.addEventListener("click", (event) => {
    if (event.detail || event.pointerType) keyboardCell = pointerCell(event, canvas, grid);
    inspector.pin(stats(keyboardCell));
  });
  canvas.addEventListener("focus", () => inspector.preview(stats(keyboardCell)));
  canvas.addEventListener("blur", () => inspector.preview());
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      inspector.clear();
      return;
    }
    const next = moveCell(event.key, keyboardCell, grid);
    if (!next) return;
    event.preventDefault();
    keyboardCell = next;
    inspector.pin(stats(keyboardCell));
  });

  const card = document.createElement("figure");
  card.className = "plot-card";
  const caption = document.createElement("figcaption");
  const title = document.createElement("span");
  const metric = document.createElement("span");
  const variation = percent(run.totalVariation, 1);
  title.textContent = showName ? name : "TV " + variation;
  if (!showName) title.title = "Total variation distance";
  metric.textContent = histogram || !showName ? "r " + formatR(run.correlation) : variation;
  metric.title = histogram || !showName ? "Pearson correlation of the bucket indices" : "Total variation distance";
  caption.append(title, metric);
  card.append(canvas, caption);
  return card;
}
