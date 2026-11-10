import { drawHeatmap, gradient } from "./heatmap.mjs";
import { comparePartialPairs, partialMechanisms, partialVariableName, simulatePartialMoments } from "./partial-moments.mjs";
import { formatR, percent } from "./plots.mjs";
import { restoreValue } from "./workspace.mjs";
import { bindLogSlider, createResultModes } from "./controls.mjs";
import { createPartialInput } from "./partial-input.mjs";
import { createPartialSweep } from "./partial-sweep.mjs";

const numberLabel = (value) => {
  const rounded = value !== null && Math.abs(value) < 0.005 ? 0 : value;
  return (rounded > 0 ? "+" : "") + formatR(rounded);
};
const position = (value) => `${(value + 1) * 50}%`;

function addHeading(row, name, scope) {
  const heading = document.createElement("th");
  heading.scope = scope;
  heading.textContent = name;
  row.append(heading);
}

function colorCell(button, pixels, offset) {
  const channels = pixels.subarray(offset, offset + 3);
  button.style.backgroundColor = `rgb(${channels.join(", ")})`;
  const linear = Array.from(channels, (channel) => {
    const x = channel / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  button.style.color = luminance > 0.179 ? "#000" : "#fff";
}

export function createPartialView({ saved, onSettingsChange }) {
  const get = (id) => document.getElementById(id);
  const root = get("partial");
  const form = get("partial-form");
  const runButton = get("partial-run");
  const fields = Object.fromEntries(["variables", "mechanism", "samples", "epsilon", "trials", "seed", "floor", "share"].map((name) => [name, get(`partial-${name}`)]));
  const palette = get("partial-palette");
  const options = get("partial-options");
  const reuseSeed = get("partial-reuse-seed");
  const control = get("partial-control");
  const status = get("partial-status");
  const results = get("partial-results");
  const matrices = get("partial-matrices");
  const method = root.querySelector(".partial-method");
  const pairTitle = get("partial-pair-title");
  const track = get("partial-track");
  const range = track.querySelector(".partial-interval");
  const referenceMark = track.querySelector(".partial-reference");
  const medianMark = track.querySelector(".partial-median");
  const bitmap = document.createElement("canvas");
  const views = [
    { table: get("partial-original"), title: "Before adding noise", key: "original", maximum: 1 },
    { table: get("partial-private"), title: "Typical with noise", key: "median", maximum: 1 },
    { table: get("partial-error"), title: "Change due to noise", key: "delta", maximum: 2 },
  ];
  const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  let simulation;
  let applied;
  let inputRevision = 0;
  let appliedInputRevision = 0;
  let lastSeed = Number.isInteger(saved?.lastSeed) && saved.lastSeed >= 0 && saved.lastSeed <= 4294967295 ? saved.lastSeed : null;
  let pairs;
  let names;
  let controlIndex = Number.isInteger(saved?.control) ? saved.control : 2;
  let selected = saved?.pair ?? "0:1";

  for (const [key, name] of Object.entries(partialMechanisms)) fields.mechanism.add(new Option(name, key));
  for (const [key, field] of Object.entries(fields)) restoreValue(field, saved?.fields?.[key]);
  restoreValue(palette, saved?.palette);
  method.open = saved?.methodOpen === true;
  options.open = saved?.optionsOpen ?? fields.mechanism.value === "split";
  const input = createPartialInput({ variables: fields.variables, saved: saved?.input, onChange: () => {
    inputRevision++;
    get("partial-input-status").textContent = "";
    syncSweepVariables();
    settingsChanged();
  } });

  const values = () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value]));

  function saveState() {
    return {
      fields: values(), palette: palette.value, control: controlIndex, pair: selected, lastSeed,
      methodOpen: method.open, optionsOpen: options.open, compare: modes.comparing, input: input.saveState(), sweep: sweep.saveState(),
    };
  }

  function inspectPair(key) {
    selected = key;
    const pair = pairs.get(key);
    const { i, j, ordinary, original, median, delta, low, high, validRuns, matchingRuns, weak } = pair;
    pairTitle.textContent = `${names[i]} and ${names[j]} · accounting for ${names[controlIndex]}`;
    get("partial-pair-ordinary").textContent = numberLabel(ordinary);
    get("partial-pair-original").textContent = numberLabel(original);
    get("partial-pair-median").textContent = numberLabel(median);
    get("partial-pair-delta").textContent = numberLabel(delta);
    get("partial-pair-warning").hidden = !weak;

    range.hidden = low === null;
    referenceMark.hidden = original === null;
    medianMark.hidden = median === null;
    if (original !== null) referenceMark.style.left = position(original);
    if (median !== null) medianMark.style.left = position(median);
    if (low !== null) {
      range.style.left = position(low);
      range.style.width = `${(high - low) * 50}%`;
    }
    let direction;
    if (original === null) {
      direction = "There was too little variation to estimate the relationship before adding noise.";
    } else if (Math.abs(original) < 0.05) {
      direction = "Before adding noise, the relationship was close to zero, with no clear direction to preserve.";
    } else {
      const trend = original > 0 ? "higher" : "lower";
      direction = `Before adding noise, higher ${names[i]} values tended to go with ${trend} ${names[j]} values.`;
      if (matchingRuns !== null && validRuns === 1) {
        direction += matchingRuns ? " The run with privacy noise estimated the same pattern." : " The run with privacy noise changed that pattern.";
      } else if (matchingRuns !== null) {
        direction += ` With privacy noise, ${matchingRuns} of ${validRuns} runs (${percent(matchingRuns / validRuns, 0)}) estimated the same pattern.`;
      }
    }
    get("partial-pair-direction").textContent = direction;
    let spread = "These runs produced no usable estimates for this pair.";
    if (validRuns === 1) {
      spread = `The one run with privacy noise estimated ${numberLabel(median)}.`;
    } else if (low !== null) {
      spread = `The shaded band runs from ${numberLabel(low)} to ${numberLabel(high)} and contains about 8 in 10 estimates. Each run uses the same data with different privacy noise.`;
      if (low <= -0.005 && high >= 0.005) spread += " The noise made some estimates positive and others negative.";
    }
    get("partial-pair-spread").textContent = spread;

    for (const button of matrices.querySelectorAll(".partial-cell")) {
      const active = button.dataset.pair === key;
      button.setAttribute("aria-pressed", active);
      button.tabIndex = active ? 0 : -1;
    }
  }

  function renderMatrix({ table, title, key, maximum }, visible) {
    const width = visible.length;
    const heatmap = new Float64Array(width * width);
    const head = document.createElement("thead");
    const header = head.insertRow();
    addHeading(header, "", "col");
    for (const variable of visible) addHeading(header, names[variable], "col");
    const body = document.createElement("tbody");
    const cells = [];
    for (const [rowIndex, i] of visible.entries()) {
      const row = body.insertRow();
      addHeading(row, names[i], "row");
      for (const [column, j] of visible.entries()) {
        const cell = row.insertCell();
        if (column >= rowIndex) {
          cell.textContent = column === rowIndex ? "—" : "";
          continue;
        }
        const pairKey = `${j}:${i}`;
        const pair = pairs.get(pairKey);
        const value = pair[key];
        const label = numberLabel(value);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "partial-cell";
        button.dataset.pair = pairKey;
        button.dataset.row = rowIndex;
        button.dataset.column = column;
        button.textContent = label + (pair.weak ? "*" : "");
        button.setAttribute("aria-label", `${title}, ${names[j]} and ${names[i]}, ${label}${pair.weak ? ", low residual variance" : ""}`);
        cell.append(button);
        if (value !== null) {
          const pixel = rowIndex * width + column;
          heatmap[pixel] = value;
          cells.push({ button, pixel });
        }
      }
    }
    drawHeatmap(bitmap, heatmap, { width, height: width }, palette.value, maximum);
    const pixels = bitmap.getContext("2d").getImageData(0, 0, width, width).data;
    for (const { button, pixel } of cells) colorCell(button, pixels, pixel * 4);
    table.replaceChildren(head, body);
  }

  function render() {
    pairs = comparePartialPairs(simulation, controlIndex);
    if (!pairs.has(selected)) selected = pairs.keys().next().value;
    const visible = Array.from(names.keys()).filter((i) => i !== controlIndex);
    matrices.toggleAttribute("data-wide", visible.length > 6);
    matrices.style.setProperty("--matrix-min", `${(visible.length - 1) * 3.25 + 3}rem`);
    for (const view of views) renderMatrix(view, visible);
    for (const legend of root.querySelectorAll(".partial-scale")) {
      const [negative, positive] = legend.querySelectorAll(".legend-bar");
      negative.style.backgroundImage = gradient(palette.value === "signed" ? "negative" : palette.value, true);
      positive.style.backgroundImage = gradient(palette.value === "signed" ? "positive" : palette.value);
    }
    inspectPair(selected);
    get("partial-empty-results").hidden = true;
    results.hidden = false;
  }

  function readSettings(varied = [], requiredVariables, report = true, repeatSeed = false) {
    for (const [name, field] of Object.entries(fields)) {
      if (varied.includes(name) || field.validity.valid) continue;
      if (report) field.reportValidity();
      return null;
    }
    const settings = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.valueAsNumber]));
    settings.mechanism = fields.mechanism.value;
    settings.seed = fields.seed.value === "" ? (repeatSeed && lastSeed !== null ? lastSeed : crypto.getRandomValues(new Uint32Array(1))[0])
      : fields.seed.valueAsNumber;
    const data = input.read(requiredVariables ?? settings.variables);
    if (!data.factors) {
      if (report) {
        get("partial-input-status").textContent = `Check the weights for ${partialVariableName(data.invalid)}. Increase Variables to see its row if needed.`;
        if (data.field) data.field.reportValidity();
        else get("partial-input-title").focus();
      }
      return null;
    }
    settings.factors = data.factors;
    return settings;
  }

  const sweep = createPartialSweep({
    fields, readSettings, palette: () => palette.value, saved: saved?.sweep, onSettingsChange,
    initialControl: controlIndex, initialPair: selected,
  });
  const modes = createResultModes({
    workspace: root, single: get("partial-single"), comparison: get("partial-sweep-panel"),
    compareButton: get("partial-compare"), backButton: get("partial-back"),
    initial: saved?.compare ?? saved?.tab === "sweep",
    onChange: (comparing) => {
      if (comparing) sweep.followSelection(controlIndex, selected);
      onSettingsChange();
    },
  });

  function syncSweepVariables() {
    sweep.syncVariables(fields.variables.validity.valid ? fields.variables.valueAsNumber : Number(fields.variables.defaultValue));
  }

  function updateMechanismNote() {
    get("partial-mechanism-help").textContent = {
      moments: "Adds noise to the summaries used to calculate correlations. This is a useful baseline.",
      split: "Lets you spend more of the budget on how pairs move together. Adjust the share in More simulation settings.",
      covariance: "Centers each variable first, then adds noise to how much the variables vary together.",
    }[fields.mechanism.value];
    reuseSeed.disabled = lastSeed === null || fields.seed.valueAsNumber === lastSeed;
  }

  function run(settings) {
    const { variables, samples, epsilon, trials, seed, mechanism } = settings;
    simulation = simulatePartialMoments(settings);
    applied = values();
    appliedInputRevision = inputRevision;
    lastSeed = seed;
    runButton.lastElementChild.textContent = "Run again";
    names = Array.from({ length: variables }, (_, i) => partialVariableName(i));
    if (controlIndex < 0 || controlIndex >= variables) controlIndex = 2;
    control.replaceChildren(...names.map((name, i) => new Option(name, String(i))));
    control.value = String(controlIndex);
    get("partial-info").textContent = `${partialMechanisms[mechanism]} · ${variables} variables · N ${samples.toLocaleString()} · ε ${epsilon} · ${trials} ${trials === 1 ? "noise run" : "noise runs"} · Seed ${seed}`;
    status.textContent = "";
    status.dataset.state = "";
    render();
    updateMechanismNote();
  }

  function settingsChanged() {
    const stale = applied && (inputRevision !== appliedInputRevision || Object.entries(values()).some(([name, value]) => value !== applied[name]));
    status.textContent = stale ? "Settings changed. Run correlations to update the matrices." : "";
    status.dataset.state = stale ? "stale" : "";
    updateMechanismNote();
    sweep.invalidate();
    onSettingsChange();
  }

  bindLogSlider(fields.epsilon, get("partial-epsilon-slider"), 2);
  bindLogSlider(fields.samples, get("partial-samples-slider"), 0);
  form.addEventListener("input", settingsChanged);
  form.addEventListener("change", settingsChanged);
  fields.mechanism.addEventListener("change", () => { if (fields.mechanism.value === "split") options.open = true; });
  for (const field of [fields.floor, fields.share, fields.seed]) field.addEventListener("invalid", () => { options.open = true; });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const settings = readSettings();
    if (settings) {
      if (modes.comparing) modes.select(false, true);
      run(settings);
      onSettingsChange();
    }
  });
  palette.addEventListener("change", () => {
    if (simulation) render();
    sweep.render();
    onSettingsChange();
  });
  reuseSeed.addEventListener("click", () => {
    fields.seed.value = String(lastSeed);
    fields.seed.focus();
    settingsChanged();
  });
  method.addEventListener("toggle", onSettingsChange);
  options.addEventListener("toggle", onSettingsChange);
  control.addEventListener("change", () => {
    controlIndex = Number(control.value);
    render();
    onSettingsChange();
  });
  matrices.addEventListener("click", (event) => {
    const cell = event.target.closest(".partial-cell");
    if (!cell) return;
    inspectPair(cell.dataset.pair);
    pairTitle.closest(".partial-detail").scrollIntoView({ block: "nearest", inline: "nearest" });
    onSettingsChange();
  });
  matrices.addEventListener("keydown", (event) => {
    const cell = event.target.closest(".partial-cell");
    const direction = arrows[event.key];
    if (!cell || !direction) return;
    const row = Number(cell.dataset.row) + direction[0];
    const column = Number(cell.dataset.column) + direction[1];
    const next = cell.closest("table").querySelector(`[data-row="${row}"][data-column="${column}"]`);
    event.preventDefault();
    if (!next) return;
    inspectPair(next.dataset.pair);
    next.focus();
    onSettingsChange();
  });

  syncSweepVariables();
  updateMechanismNote();
  const initial = readSettings([], undefined, false, true);
  if (initial) run(initial);
  else status.textContent = "Enter valid settings to run the comparison.";
  return { saveState };
}
