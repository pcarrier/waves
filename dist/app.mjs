import { compare, distribution } from "./simulation.mjs";
import { createCompute } from "./compute.mjs";
import { createEditor } from "./editor.mjs";
import { createPlot, createPlotInspector, formatR, percent, plotMaximum, setLegend } from "./plots.mjs";
import { createSweep } from "./sweep.mjs";
import { pearson } from "./moments.mjs";
import { loadWorkspace, restoreValue, storeWorkspace } from "./workspace.mjs";
import { createPartialView } from "./partial-view.mjs";
import { bindLogSlider, createResultModes } from "./controls.mjs";
import { createTabs } from "./tabs.mjs";

const get = (id) => document.getElementById(id);
const workspaceForHash = () => location.hash === "#sweep" ? "histograms" : location.hash.slice(1);
const workspace = createTabs(get("workspace-tabs"), workspaceForHash(), setWorkspaceHash);
function setWorkspaceHash(id) {
  if (location.hash !== `#${id}`) history.pushState(null, "", `#${id}`);
}
function syncWorkspace() {
  workspace.select(workspaceForHash());
  if (location.hash === "#sweep") histogramModes.select(true);
}
addEventListener("hashchange", syncWorkspace);
addEventListener("popstate", syncWorkspace);

const form = get("run-form");
const runButton = get("run");
const runStatus = get("run-status");
const mechanism = get("mechanism");
const epsilon = get("epsilon");
const samples = get("samples");
const cutoff = get("cutoff");
const trials = get("trials");
const seed = get("seed");
const reuseSeed = get("reuse-seed");
const resultPalette = get("result-palette");
const resultReadout = get("result-readout");
const seedSettings = seed.closest("details");
const settingsFields = [mechanism, epsilon, samples, cutoff, trials, seed, resultPalette];
const saved = loadWorkspace();
const histogramModes = createResultModes({
  workspace: get("histograms"), single: get("histogram-single"), comparison: get("sweep"),
  compareButton: get("histogram-compare"), backButton: get("histogram-back"),
  initial: location.hash === "#sweep" || saved.histogramCompare === true,
  onChange: (comparing) => {
    if (!comparing && location.hash === "#sweep") history.replaceState(null, "", "#histograms");
    scheduleSave();
  },
});
for (const field of settingsFields) restoreValue(field, saved.controls?.[field.id]);
seedSettings.open = saved.seedOpen ?? mechanism.value === "cosine";
const mechanismNames = Object.fromEntries(Array.from(mechanism.options, ({ value, text }) => [value, text]));
const fitNotes = {
  cells: "Adds noise to each cell count separately. This is a useful baseline.",
  projected: "Adds noise to each cell, then adjusts the counts to keep the sample total fixed.",
  moments: "Adds noise to summaries such as averages and pair products. Try it when the relationship between X and Y matters most.",
  quadtree: "Adds noise to region totals at several sizes. Try it for patterns that span neighboring cells.",
  marginals: "Adds noise to row totals, column totals, and large blocks. Try it when the shape along each axis matters.",
  cosine: "Adds noise to smooth patterns. Set Cosine cutoff in More simulation settings to control how much detail it keeps.",
};

let revision = 0;
let busy = null;
let batch = null;
let lossMode = "signed";
let runError = "";
let notedGrid;
let saveTimer;
const editor = createEditor({
  saved: saved.editor,
  onChange: () => {
    if (notedGrid !== editor.grid) updateNoiseNote();
    invalidate();
  },
  onSettingsChange: scheduleSave,
});

const compute = createCompute(new URLSearchParams(location.search).get("compute"));

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWorkspace, 150);
}

function saveWorkspace() {
  if (saveTimer === undefined) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  storeWorkspace({
    controls: Object.fromEntries(settingsFields.map(({ id, value }) => [id, value])),
    editor: editor.saveState(),
    sweep: sweep.saveState(),
    partial: partial.saveState(),
    histogramCompare: histogramModes.comparing,
    seedOpen: seedSettings.open,
    lossMode,
  });
}

addEventListener("pagehide", saveWorkspace);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveWorkspace();
});

function setBackend(mode, fitted = false) {
  get("backend").dataset.backend = mode;
  get("backend-label").textContent = mode === "cpu" ? "CPU compute" : fitted ? "WebGPU + CPU fit" : "WebGPU";
}

function invalidate() {
  revision++;
  runError = "";
  updateRunState();
  scheduleSave();
}

function updateRunState() {
  const hasMass = editor.hasMass();
  runButton.disabled = busy || !hasMass;
  reuseSeed.disabled = busy || !batch || seed.valueAsNumber === batch.parameters.seed;
  runButton.lastElementChild.textContent = busy === "run" ? "Simulating…" : batch ? "Run again" : "Run simulation";
  sweep.updateState({ busy, hasMass, revision });

  let message = "";
  if (busy === "sweep") message = "Running a parameter sweep…";
  else if (busy) message = "Drawing a new batch…";
  else if (runError) message = runError;
  else if (!hasMass) message = "Paint at least one cell before running a simulation.";
  else if (batch?.revision !== revision && batch) message = "Results show the previous settings. Run again to apply your changes.";
  runStatus.dataset.state = !busy && batch && batch.revision !== revision ? "stale" : "";
  if (runStatus.textContent !== message) runStatus.textContent = message;
  if (!batch) {
    get("empty-results").textContent = runError || (busy === "run" ? "Preparing the first simulation…" : "Run a simulation to see results.");
  }
}

function updateNoiseNote() {
  if (notedGrid !== editor.grid) {
    notedGrid = editor.grid;
    const maxCutoff = notedGrid.width + notedGrid.height - 2;
    cutoff.max = maxCutoff;
    if (cutoff.valueAsNumber > maxCutoff) cutoff.value = maxCutoff;
    get("cutoff-range").textContent = `Low-frequency cosine only. Higher values keep finer detail and spread the budget over more patterns. This grid supports 0–${maxCutoff}.`;
  }
  get("mechanism-note").textContent = fitNotes[mechanism.value];
}

function updateSliderSetting() {
  updateNoiseNote();
  invalidate();
}

bindLogSlider(epsilon, get("epsilon-slider"), 2, updateSliderSetting);
bindLogSlider(samples, get("samples-slider"), 0, updateSliderSetting);
epsilon.addEventListener("input", updateSliderSetting);
samples.addEventListener("input", updateSliderSetting);
mechanism.addEventListener("change", () => {
  if (mechanism.value === "cosine") seedSettings.open = true;
  updateNoiseNote();
  invalidate();
});
cutoff.addEventListener("input", () => {
  updateNoiseNote();
  invalidate();
});
trials.addEventListener("change", invalidate);
seed.addEventListener("input", invalidate);
seedSettings.addEventListener("toggle", scheduleSave);
for (const field of [cutoff, seed]) field.addEventListener("invalid", () => { seedSettings.open = true; });
reuseSeed.addEventListener("click", () => {
  seed.value = String(batch.parameters.seed);
  seed.focus();
  updateRunState();
  scheduleSave();
});

function renderResults() {
  if (!batch) return;
  const { runs, probabilities, parameters, grid } = batch;
  const truth = pearson(probabilities, grid);
  const valid = runs.filter((run) => run.correlation !== null);
  const tv = runs.reduce((sum, run) => sum + run.totalVariation, 0) / runs.length;
  const correlationError = truth === null || !valid.length ? null
    : valid.reduce((sum, run) => sum + Math.abs(truth - run.correlation), 0) / valid.length;
  const axisTV = runs.reduce((sum, run) => sum + run.axisVariation, 0) / runs.length;
  get("mean-tv").textContent = percent(tv, 1);
  get("mean-axis-tv").textContent = percent(axisTV, 1);
  get("mean-correlation").textContent = correlationError === null ? "—" : correlationError.toFixed(3);

  const synthetic = get("synthetic-plots");
  const loss = get("loss-plots");
  const palette = resultPalette.value;
  const inspector = createPlotInspector(resultReadout);
  for (const [target, legend, view] of [[synthetic, get("sample-legend"), "histogram"], [loss, get("loss-legend"), lossMode]]) {
    const maximum = plotMaximum(runs, view, probabilities);
    target.replaceChildren();
    target.style.setProperty("--columns", Math.min(runs.length === 1 ? 2 : runs.length, 3));
    runs.forEach((run, index) => {
      const name = `Run ${String(index + 1).padStart(2, "0")}`;
      target.append(createPlot(name, run, { grid, probabilities, view, palette, maximum, inspector }));
    });
    setLegend(legend, view, palette, maximum);
  }
  const { epsilon, samples, seed, mechanism, cutoff } = parameters;
  const detail = mechanism === "cosine" ? ` · Cutoff ${cutoff}` : "";
  get("batch-info").textContent = `${mechanismNames[mechanism]}${detail} · N ${samples.toLocaleString()} · ε ${epsilon} · ${grid.width} × ${grid.height} · Painted r ${formatR(truth)} · Seed ${seed}`;
  get("empty-results").hidden = true;
  get("result-content").hidden = false;
}

function setLossMode(next) {
  lossMode = next;
  for (const mode of ["signed", "absolute"]) {
    const button = get("loss-" + mode);
    button.classList.toggle("active", next === mode);
    button.setAttribute("aria-pressed", next === mode);
  }
  renderResults();
}

for (const mode of ["signed", "absolute"]) {
  get("loss-" + mode).addEventListener("click", () => {
    setLossMode(mode);
    scheduleSave();
  });
}
if (saved.lossMode === "absolute") setLossMode("absolute");
resultPalette.addEventListener("change", () => {
  renderResults();
  sweep.render();
  scheduleSave();
});
get("method-open").addEventListener("click", () => get("method-dialog").showModal());

function captureParameters() {
  const { weights, grid } = editor.snapshot();
  const probabilities = distribution(weights);
  if (!probabilities) return null;
  return {
    probabilities, grid, mechanism: mechanism.value, epsilon: epsilon.valueAsNumber, samples: samples.valueAsNumber,
    cutoff: cutoff.valueAsNumber,
    trials: Number(trials.value), seed: seed.value === "" ? crypto.getRandomValues(new Uint32Array(1))[0] : seed.valueAsNumber,
  };
}

updateNoiseNote();
const sweep = createSweep({
  captureParameters,
  simulate: (parameters) => compute(parameters, setBackend),
  palette: () => resultPalette.value,
  mechanismNames,
  numericFields: { epsilon, samples, cutoff },
  seed,
  saved: saved.sweep,
  onSettingsChange: scheduleSave,
  setBusy: (running) => {
    busy = running ? "sweep" : null;
    updateRunState();
  },
});
const partial = createPartialView({ saved: saved.partial, onSettingsChange: scheduleSave });

async function runSimulation(event) {
  event?.preventDefault();
  if (busy || !form.reportValidity()) return;
  const parameters = captureParameters();
  if (!parameters) return;
  if (event && histogramModes.comparing) histogramModes.select(false, true);
  const { grid, probabilities } = parameters;
  const startingRevision = revision;
  busy = "run";
  runError = "";
  updateRunState();

  try {
    const output = await compute(parameters, setBackend);
    batch = { grid, probabilities, runs: compare(output, probabilities, parameters.samples, grid), parameters, revision: startingRevision };
    renderResults();
  } catch (error) {
    console.error(error);
    runError = "Simulation failed. Try resampling.";
  } finally {
    busy = null;
    updateRunState();
  }
}

form.addEventListener("submit", runSimulation);
updateRunState();
if (form.checkValidity()) runSimulation();
