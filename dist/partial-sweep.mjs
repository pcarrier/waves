import { drawHeatmap, moveCell, pointerCell } from "./heatmap.mjs";
import { comparePartialPair, partialMechanisms, partialVariableName, samplePartialMoments, simulatePartialMoments } from "./partial-moments.mjs";
import { createPlotInspector, formatR, percent } from "./plots.mjs";
import { createAxis, readAxis } from "./sweep.mjs";
import { restoreValue } from "./workspace.mjs";

const axes = {
  epsilon: { label: "Privacy budget ε", defaults: () => "0.15, 0.65, 2", format: (value) => `ε ${value}` },
  samples: { label: "Sample size N", defaults: () => "250, 2000, 10000", format: (value) => `N ${value.toLocaleString()}` },
  variables: { label: "Variables", defaults: () => "4, 8, 16", format: (value) => `${value} variables` },
  trials: { label: "Noise runs", defaults: () => "16, 64, 128", format: (value) => `${value} runs` },
  floor: { label: "Stabilization floor", defaults: () => "0.0001, 0.001, 0.01", format: (value) => `Floor ${value}` },
  share: { label: "Budget share for pairs", defaults: () => "0.5, 0.7, 0.9", format: (value) => `${percent(value, 0)} for pairs` },
  mechanism: { label: "Noise method" },
};
const bins = 16;
const grid = { width: bins, height: 1 };
const pairName = (i, j) => `${partialVariableName(i)} and ${partialVariableName(j)}`;
const svgNS = "http://www.w3.org/2000/svg";

function histogram(estimates) {
  const counts = new Uint32Array(bins);
  for (const value of estimates) counts[Math.min(bins - 1, Math.floor((value + 1) * bins / 2))]++;
  return counts;
}

function makeChart({ pair, counts, name }, maximum, color, inspector) {
  const figure = document.createElement("figure");
  const chart = document.createElementNS(svgNS, "svg");
  chart.setAttribute("viewBox", "0 0 160 76");
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", `${name}. Adjusted correlation from −1 to +1. Use arrow keys to inspect bins.`);
  chart.setAttribute("tabindex", "0");
  const bars = document.createElementNS(svgNS, "path");
  const paths = Array.from(counts, (count, bin) => {
    const height = maximum ? 76 * count / (pair.validRuns * maximum) : 0;
    return `M${bin * 10} 76v${-height}h9v${height}z`;
  });
  bars.setAttribute("d", paths.join(""));
  bars.setAttribute("fill", color);
  chart.append(bars);
  if (pair.original !== null) {
    const line = document.createElementNS(svgNS, "line");
    const x = Math.max(1, Math.min(159, 80 * (pair.original + 1)));
    line.setAttribute("x1", x);
    line.setAttribute("x2", x);
    line.setAttribute("y1", 0);
    line.setAttribute("y2", 76);
    line.setAttribute("stroke", "currentColor");
    chart.append(line);
  }
  let cell = { x: 0, y: 0 };
  const stats = (bin) => `${name} · ${formatR(2 * bin / bins - 1)} to ${formatR(2 * (bin + 1) / bins - 1)} · ${counts[bin]} of ${pair.validRuns} estimates`;
  chart.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch") inspector.preview(stats(pointerCell(event, chart, grid).x));
  });
  chart.addEventListener("pointerleave", () => inspector.preview());
  chart.addEventListener("blur", () => inspector.preview());
  chart.addEventListener("focus", () => inspector.preview(stats(cell.x)));
  chart.addEventListener("click", (event) => {
    if (event.detail || event.pointerType) cell = pointerCell(event, chart, grid);
    inspector.pin(stats(cell.x));
  });
  chart.addEventListener("keydown", (event) => {
    if (event.key === "Escape") inspector.clear();
    const next = moveCell(event.key, cell, grid);
    if (!next) return;
    event.preventDefault();
    cell = next;
    inspector.pin(stats(cell.x));
  });
  const caption = document.createElement("figcaption");
  const direction = pair.matchingRuns === null ? "" : ` · ${pair.matchingRuns}/${pair.validRuns} same direction`;
  caption.textContent = pair.validRuns ? `Typical ${formatR(pair.median)}${direction}` : "No usable estimates";
  figure.append(chart, caption);
  return figure;
}

export function createPartialSweep({ fields, readSettings, palette, saved, onSettingsChange, initialControl, initialPair }) {
  const get = (id) => document.getElementById(id);
  const form = get("partial-sweep-form");
  const control = get("partial-sweep-control");
  const pair = get("partial-sweep-pair");
  const submit = get("partial-sweep-run");
  const cancel = get("partial-sweep-cancel");
  const status = get("partial-sweep-status");
  const results = get("partial-sweep-results");
  const scroll = get("partial-sweep-scroll");
  const table = get("partial-sweep-table");
  const zoom = get("partial-sweep-zoom");
  const columnsControl = createAxis(get("partial-sweep-columns"), "epsilon", partialMechanisms, fields, false, saved?.columns, axes);
  const columnKey = columnsControl.select.value;
  const savedRows = saved?.rows?.key === columnKey ? { ...saved.rows, key: "" } : saved?.rows;
  const rowsControl = createAxis(get("partial-sweep-rows"), columnKey === "samples" ? "" : "samples", partialMechanisms, fields, true, savedRows, axes);
  let count;
  let result;
  let contextChosen = saved?.control !== undefined || saved?.pair !== undefined;
  let revision = 0;
  let busy = false;
  let canceled = false;
  restoreValue(zoom, saved?.zoom);

  function syncAxes() {
    for (const [axis, other] of [[columnsControl, rowsControl], [rowsControl, columnsControl]]) {
      for (const option of axis.select.options) option.disabled = Boolean(option.value) && option.value === other.select.value;
      axis.select.setCustomValidity("");
    }
  }

  function syncPair(preferred = pair.value) {
    const k = Number(control.value);
    const options = [];
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        if (i !== k && j !== k) options.push(new Option(pairName(i, j), `${i}:${j}`));
      }
    }
    pair.replaceChildren(...options);
    restoreValue(pair, preferred);
  }

  function syncVariables(variables) {
    if (count === variables) return;
    const previousControl = control.value || saved?.control || String(initialControl);
    const previousPair = pair.value || saved?.pair || initialPair;
    count = variables;
    control.replaceChildren(...Array.from({ length: count }, (_, i) => new Option(partialVariableName(i), String(i))));
    control.value = "2";
    restoreValue(control, previousControl);
    syncPair(previousPair);
  }

  function followSelection(variable, key) {
    if (contextChosen || result || busy) return;
    restoreValue(control, String(variable));
    syncPair(key);
  }

  function invalidate() {
    revision++;
    if (!busy && result) status.textContent = "Settings changed. Run the sweep to update the charts.";
  }

  function updateZoom() {
    if (!result || !scroll.clientWidth) return;
    const width = 96 + 170 * result.columns.values.length;
    table.style.width = `${width}px`;
    table.style.zoom = zoom.value === "fit" ? Math.min(1, scroll.clientWidth / width) : Number(zoom.value);
  }

  function render() {
    if (!result) return;
    const { rows, columns, cells, i, j, k, settings } = result;
    const inspector = createPlotInspector(get("partial-sweep-readout"));
    const bitmap = document.createElement("canvas");
    const chosen = palette();
    drawHeatmap(bitmap, [0.65], { width: 1, height: 1 }, chosen === "signed" ? "violet" : chosen, 1);
    const color = `rgb(${Array.from(bitmap.getContext("2d").getImageData(0, 0, 1, 1).data.slice(0, 3)).join(", ")})`;
    let maximum = 0;
    for (const cell of cells) {
      if (cell?.pair.validRuns) maximum = Math.max(maximum, Math.max(...cell.counts) / cell.pair.validRuns);
    }
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    const header = head.insertRow();
    function heading(row, value, scope) {
      const th = document.createElement("th");
      th.scope = scope;
      th.textContent = value;
      row.append(th);
    }
    heading(header, rows.label || "Settings", "col");
    for (const value of columns.values) heading(header, columns.format(value), "col");
    rows.values.forEach((rowValue, y) => {
      const row = body.insertRow();
      heading(row, rows.format(rowValue) || "Sweep", "row");
      columns.values.forEach((_, x) => {
        const td = row.insertCell();
        const cell = cells[y * columns.values.length + x];
        if (cell) td.append(makeChart(cell, maximum, color, inspector));
        else td.textContent = "Pair unavailable at this variable count";
      });
    });
    table.replaceChildren(head, body);
    const varied = new Set([rows.key, columns.key]);
    const mechanisms = [rows, columns].find(({ key }) => key === "mechanism")?.values ?? [settings.mechanism];
    const fixed = Object.entries(axes)
      .filter(([key]) => !varied.has(key) && (key !== "share" || mechanisms.includes("split")))
      .map(([key, axis]) => key === "mechanism" ? partialMechanisms[settings.mechanism] : axis.format(settings[key]));
    get("partial-sweep-info").textContent = [
      pairName(i, j), `accounting for ${partialVariableName(k)}`, ...fixed, `Seed ${settings.seed}`, `Bars show up to ${percent(maximum, 1)} of runs`,
    ].join(" · ");
    results.hidden = false;
    updateZoom();
  }

  for (const axis of [rowsControl, columnsControl]) {
    axis.select.addEventListener("change", syncAxes);
    for (const choice of axis.choices.values()) choice.addEventListener("change", () => axis.select.setCustomValidity(""));
  }
  syncAxes();
  control.addEventListener("change", () => { contextChosen = true; syncPair(); });
  pair.addEventListener("change", () => { contextChosen = true; });
  form.addEventListener("input", () => { invalidate(); onSettingsChange(); });
  form.addEventListener("change", onSettingsChange);
  zoom.addEventListener("change", () => { updateZoom(); onSettingsChange(); });
  new ResizeObserver(updateZoom).observe(scroll);
  cancel.addEventListener("click", () => { canceled = true; cancel.disabled = true; });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const columns = readAxis(columnsControl, fields, partialMechanisms, axes);
    const rows = readAxis(rowsControl, fields, partialMechanisms, axes);
    if (!rows || !columns) return;
    const varied = [rows.key, columns.key];
    const mechanismAxis = [rows, columns].find(({ key }) => key === "mechanism");
    if (varied.includes("share") && mechanismAxis && !mechanismAxis.values.includes("split")) {
      status.textContent = "Select Split-budget moments on the Noise method axis to vary the budget share.";
      return;
    }
    const variableAxis = [rows, columns].find(({ key }) => key === "variables");
    const base = readSettings(varied, variableAxis?.values.reduce((max, value) => Math.max(max, value), 0));
    if (!base) return;
    if (varied.includes("share") && !varied.includes("mechanism")) base.mechanism = "split";
    const [i, j] = pair.value.split(":").map(Number);
    const k = Number(control.value);
    const startingRevision = revision;
    const cells = [];
    const sampleCache = new Map();
    const total = rows.values.length * columns.values.length;
    busy = submit.disabled = true;
    cancel.hidden = cancel.disabled = canceled = false;
    try {
      for (const rowValue of rows.values) {
        for (const columnValue of columns.values) {
          if (canceled) return;
          status.textContent = `Running cell ${cells.length + 1} of ${total}…`;
          const settings = { ...base, [columns.key]: columnValue };
          if (rows.key) settings[rows.key] = rowValue;
          if (Math.max(i, j, k) >= settings.variables) {
            cells.push(null);
          } else {
            const key = `${settings.variables}:${settings.samples}`;
            if (!sampleCache.has(key)) sampleCache.set(key, samplePartialMoments(settings));
            const simulation = simulatePartialMoments(settings, sampleCache.get(key));
            const summary = comparePartialPair(simulation, k, i, j);
            const name = [rows.format(rowValue), columns.format(columnValue)].filter(Boolean).join(" · ");
            cells.push({ pair: summary, name, counts: histogram(summary.estimates) });
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      if (canceled) return;
      result = { rows, columns, cells, i, j, k, settings: base };
      render();
      status.textContent = revision === startingRevision ? `Completed ${total} ${total === 1 ? "cell" : "cells"}.`
        : "Settings changed while the sweep was running. The charts show the previous settings.";
    } catch (error) {
      console.error(error);
      status.textContent = "Sweep failed. Try running it again.";
    } finally {
      if (canceled) status.textContent = "Sweep canceled.";
      busy = submit.disabled = false;
      cancel.hidden = true;
    }
  });

  return {
    invalidate, render, syncVariables, followSelection,
    saveState: () => ({
      rows: rowsControl.saveState(), columns: columnsControl.saveState(), zoom: zoom.value,
      ...(contextChosen || result ? { control: control.value, pair: pair.value } : {}),
    }),
  };
}
