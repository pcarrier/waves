import { compare } from "./simulation.mjs";
import { createPlot, createPlotInspector, plotMaximum, setLegend } from "./plots.mjs";
import { restoreValue } from "./workspace.mjs";

const axes = {
  epsilon: { label: "Privacy budget ε", defaults: () => "0.15, 0.65, 2", format: (value) => `ε ${value}` },
  samples: { label: "Sample size N", defaults: () => "250, 1200, 6000", format: (value) => `N ${value.toLocaleString()}` },
  cutoff: {
    label: "Cosine cutoff",
    defaults: ({ max }) => [0, 1, 2, 4, 8].filter((value) => value <= Number(max)).join(", "),
    format: (value) => `Cutoff ${value}`,
  },
  mechanism: { label: "Noise method" },
};

export function createAxis(fieldset, initialKey, mechanismNames, fields, optional, saved, definitions = axes) {
  const select = fieldset.querySelector("select");
  const numberLabel = fieldset.querySelector(".sweep-values");
  const input = numberLabel.querySelector("input");
  const mechanisms = fieldset.querySelector(".sweep-mechanisms");
  const choices = new Map();

  if (optional) select.add(new Option("None", ""));
  for (const [key, { label }] of Object.entries(definitions)) select.add(new Option(label, key));
  select.value = initialKey;
  restoreValue(select, saved?.key);
  for (const [value, name] of Object.entries(mechanismNames)) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = saved?.checked?.[value] !== false;
    choices.set(value, checkbox);
    label.append(checkbox, name);
    mechanisms.append(label);
  }

  const drafts = {};
  for (const [key, { defaults }] of Object.entries(definitions)) {
    const value = saved?.drafts?.[key];
    if (defaults && typeof value === "string") drafts[key] = value;
  }
  let currentKey;
  function update() {
    if (definitions[currentKey]?.defaults) drafts[currentKey] = input.value;
    currentKey = select.value;
    const defaults = definitions[currentKey]?.defaults;
    const numeric = Boolean(defaults);
    input.value = drafts[currentKey] ?? defaults?.(fields[currentKey]) ?? "";
    input.setCustomValidity("");
    numberLabel.hidden = input.disabled = !numeric;
    mechanisms.hidden = mechanisms.disabled = currentKey !== "mechanism";
  }
  select.addEventListener("change", update);
  input.addEventListener("input", () => input.setCustomValidity(""));
  update();

  function saveState() {
    const values = { ...drafts };
    if (definitions[currentKey]?.defaults) values[currentKey] = input.value;
    return {
      key: select.value,
      drafts: values,
      checked: Object.fromEntries(Array.from(choices, ([key, checkbox]) => [key, checkbox.checked])),
    };
  }

  return { select, input, choices, saveState };
}

export function readAxis({ select, input, choices }, fields, mechanismNames, definitions = axes) {
  const key = select.value;
  if (!key) return { key, label: "", values: [null], format: () => "" };
  if (key === "mechanism") {
    const values = [...choices].filter(([, checkbox]) => checkbox.checked).map(([value]) => value);
    if (values.length) return { key, label: definitions[key].label, values, format: (value) => mechanismNames[value] };
    select.setCustomValidity("Choose at least one mechanism for this axis.");
    select.reportValidity();
    return null;
  }

  const { min, max, step } = fields[key];
  const tokens = input.value.trim().split(/[\s,]+/).filter(Boolean);
  const values = [...new Set(tokens.map(Number))];
  const valid = values.length && values.every((value) =>
    Number.isFinite(value) && value >= Number(min) && value <= Number(max)
      && (step !== "1" || Number.isInteger(value)));
  if (!valid) {
    input.setCustomValidity(`Enter ${step === "1" ? "whole numbers" : "values"} from ${min} to ${max}.`);
    input.reportValidity();
    return null;
  }
  return { key, values, label: definitions[key].label, format: definitions[key].format };
}

function poolRuns(output, { probabilities, grid, samples, trials }) {
  const bins = probabilities.length;
  const counts = output.slice(0, bins);
  for (let offset = bins; offset < output.length; offset += bins) {
    for (let bin = 0; bin < bins; bin++) counts[bin] += output[offset + bin];
  }
  return compare(counts, probabilities, samples * trials, grid)[0];
}

export function createSweep({ captureParameters, simulate, palette, mechanismNames, numericFields, seed, saved, onSettingsChange, setBusy }) {
  const get = (id) => document.getElementById(id);
  const form = get("sweep-form");
  const columnsControl = createAxis(get("sweep-columns"), "epsilon", mechanismNames, numericFields, false, saved?.columns);
  const columnKey = columnsControl.select.value;
  const defaultRow = columnKey === "samples" ? "" : "samples";
  const savedRows = saved?.rows?.key === columnKey ? { ...saved.rows, key: "" } : saved?.rows;
  const rowsControl = createAxis(get("sweep-rows"), defaultRow, mechanismNames, numericFields, true, savedRows);
  const viewControl = get("sweep-view");
  const zoomControl = get("sweep-zoom");
  restoreValue(viewControl, saved?.view);
  restoreValue(zoomControl, saved?.zoom);
  const submit = get("sweep-run");
  const cancel = get("sweep-cancel");
  const status = get("sweep-status");
  const readout = get("sweep-readout");
  const results = get("sweep-results");
  const table = get("sweep-table");
  const scroll = get("sweep-scroll");
  const stale = get("sweep-stale");
  let state;
  let formRevision = 0;
  let result;
  let canceled = false;

  function updateState(next) {
    state = next;
    submit.disabled = Boolean(state.busy) || !state.hasMass;
    stale.hidden = !result || (result.revision === state.revision && result.formRevision === formRevision);
  }

  function syncAxes() {
    for (const [axis, other] of [[columnsControl, rowsControl], [rowsControl, columnsControl]]) {
      for (const option of axis.select.options) {
        option.disabled = Boolean(option.value) && option.value === other.select.value;
      }
    }
    get("sweep-cutoff-help").hidden = columnsControl.select.value !== "cutoff" && rowsControl.select.value !== "cutoff";
  }

  for (const control of [columnsControl, rowsControl]) {
    control.select.addEventListener("change", () => {
      control.select.setCustomValidity("");
      syncAxes();
    });
    for (const choice of control.choices.values()) {
      choice.addEventListener("change", () => control.select.setCustomValidity(""));
    }
  }
  form.addEventListener("input", () => {
    formRevision++;
    updateState(state);
    onSettingsChange();
  });
  form.addEventListener("change", onSettingsChange);
  syncAxes();

  function saveState() {
    return {
      columns: columnsControl.saveState(),
      rows: rowsControl.saveState(),
      view: viewControl.value,
      zoom: zoomControl.value,
    };
  }

  function updateZoom() {
    const available = scroll.clientWidth;
    if (!result || !available) return;
    const columns = result.columns.values.length;
    const width = Math.max(92 + columns * 106, Math.min(available, 100 + columns * 188));
    const scale = zoomControl.value === "fit" ? Math.min(1, available / width) : Number(zoomControl.value);
    table.style.width = `${width}px`;
    table.style.zoom = scale;
  }

  function render() {
    if (!result) return;
    const { rows, columns, runs, parameters } = result;
    const { probabilities, grid, trials, seed } = parameters;
    const view = viewControl.value;
    const colors = palette();
    const maximum = plotMaximum(runs, view, probabilities);
    const inspector = createPlotInspector(readout);
    const head = document.createElement("thead");
    const header = head.insertRow();
    const heading = document.createElement("th");
    heading.scope = "col";
    heading.textContent = rows.label || "Settings";
    header.append(heading);
    for (const value of columns.values) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = columns.format(value);
      header.append(cell);
    }

    const body = document.createElement("tbody");
    rows.values.forEach((rowValue, y) => {
      const row = body.insertRow();
      const rowLabel = rows.format(rowValue);
      const cell = document.createElement("th");
      cell.scope = "row";
      cell.textContent = rowLabel || "Sweep";
      row.append(cell);
      columns.values.forEach((columnValue, x) => {
        const name = [rowLabel, columns.format(columnValue)].filter(Boolean).join(" · ");
        const run = runs[y * columns.values.length + x];
        row.insertCell().append(createPlot(name, run, {
          grid, probabilities, view, palette: colors, maximum, inspector, showName: false,
        }));
      });
    });

    table.replaceChildren(head, body);
    results.style.setProperty("--sweep-columns", columns.values.length);
    setLegend(get("sweep-legend"), view, colors, maximum);
    get("sweep-scale-label").textContent = view === "histogram" ? "Probability per bin" : "Loss in percentage points";
    const varied = new Set([rows.key, columns.key]);
    const mechanisms = [rows, columns].find(({ key }) => key === "mechanism")?.values ?? [parameters.mechanism];
    const fixed = Object.entries(axes)
      .filter(([key]) => !varied.has(key) && (key !== "cutoff" || mechanisms.includes("cosine")))
      .map(([key, axis]) => key === "mechanism" ? mechanismNames[parameters.mechanism] : axis.format(parameters[key]));
    get("sweep-info").textContent = [
      ...fixed, `${grid.width} × ${grid.height}`, `${trials} ${trials === 1 ? "run" : "runs"} per cell`, `Seed ${seed}`,
    ].join(" · ");
    results.hidden = false;
    updateZoom();
    updateState(state);
  }

  viewControl.addEventListener("change", () => {
    render();
    onSettingsChange();
  });
  zoomControl.addEventListener("change", () => {
    updateZoom();
    onSettingsChange();
  });
  new ResizeObserver(updateZoom).observe(scroll);
  cancel.addEventListener("click", () => {
    canceled = true;
    cancel.disabled = true;
    status.textContent = "Stopping after the current cell…";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const columns = readAxis(columnsControl, numericFields, mechanismNames);
    if (!columns) return;
    const rows = readAxis(rowsControl, numericFields, mechanismNames);
    if (!rows) return;
    const variesCutoff = rows.key === "cutoff" || columns.key === "cutoff";
    const mechanismAxis = [rows, columns].find(({ key }) => key === "mechanism");
    if (variesCutoff && mechanismAxis && !mechanismAxis.values.includes("cosine")) {
      status.textContent = "Select Low-frequency cosine on the Noise method axis to vary its cutoff.";
      return;
    }
    const fixedFields = Object.entries(numericFields).filter(([key]) => key !== rows.key && key !== columns.key).map(([, field]) => field);
    const invalid = [...fixedFields, seed].find((field) => !field.validity.valid);
    if (invalid) {
      invalid.reportValidity();
      return;
    }

    const parameters = captureParameters();
    if (!parameters) return;
    if (variesCutoff && !mechanismAxis) parameters.mechanism = "cosine";
    const next = { rows, columns, runs: [], parameters, revision: state.revision, formRevision };
    const total = rows.values.length * columns.values.length;
    canceled = false;
    cancel.disabled = false;
    cancel.hidden = false;
    setBusy(true);
    try {
      for (const rowValue of rows.values) {
        for (const columnValue of columns.values) {
          if (canceled) {
            status.textContent = "Sweep canceled.";
            return;
          }
          status.textContent = `Running cell ${next.runs.length + 1} of ${total}…`;
          const cell = { ...parameters, [columns.key]: columnValue };
          if (rows.key) cell[rows.key] = rowValue;
          const output = await simulate(cell);
          next.runs.push(poolRuns(output, cell));
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      if (canceled) {
        status.textContent = "Sweep canceled.";
        return;
      }
      result = next;
      render();
      status.textContent = `Completed ${total} ${total === 1 ? "cell" : "cells"}.`;
    } catch (error) {
      console.error(error);
      status.textContent = "Sweep failed. Try running it again.";
    } finally {
      cancel.hidden = true;
      setBusy(false);
    }
  });

  return { updateState, render, saveState };
}
