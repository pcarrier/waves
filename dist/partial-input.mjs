import { defaultPartialFactors, partialVariableName } from "./partial-moments.mjs";
import { restoreValue } from "./workspace.mjs";

export function createPartialInput({ variables, saved, onChange }) {
  const preset = document.getElementById("partial-preset");
  const body = document.getElementById("partial-factors");
  const labels = ["Shared A", "Shared B", "Own variation"];
  restoreValue(preset, saved?.preset ?? "reversal");
  let rows = Array.from({ length: Number(variables.max) }, (_, i) => {
    const stored = saved?.rows?.[i];
    return Array.isArray(stored) && stored.length === labels.length && stored.every((value) => typeof value === "string")
      ? stored.slice() : defaultPartialFactors(i, preset.value).map(String);
  });

  function render() {
    const count = variables.validity.valid ? variables.valueAsNumber : Number(variables.defaultValue);
    body.replaceChildren();
    for (let i = 0; i < count; i++) {
      const row = body.insertRow();
      const heading = document.createElement("th");
      heading.scope = "row";
      heading.textContent = partialVariableName(i);
      row.append(heading);
      labels.forEach((label, j) => {
        const field = document.createElement("input");
        field.className = "number";
        field.type = "number";
        field.min = j === 2 ? "0" : "-1";
        field.max = "1";
        field.step = "any";
        field.required = true;
        field.setAttribute("aria-label", `${partialVariableName(i)} ${label}`);
        field.value = rows[i][j];
        field.addEventListener("input", () => {
          rows[i][j] = field.value;
          preset.value = "custom";
          onChange();
        });
        row.insertCell().append(field);
      });
    }
  }

  function read(count) {
    const factors = [];
    for (let i = 0; i < count; i++) {
      const row = rows[i];
      for (const [j, value] of row.entries()) {
        const number = Number(value);
        if (value === "" || !Number.isFinite(number) || number < (j === 2 ? 0 : -1) || number > 1) {
          return { invalid: i, field: body.rows[i]?.querySelectorAll("input")[j] };
        }
      }
      factors.push(row.map(Number));
    }
    return { factors };
  }

  preset.addEventListener("change", () => {
    rows = rows.map((_, i) => defaultPartialFactors(i, preset.value).map(String));
    render();
    onChange();
  });
  variables.addEventListener("input", () => {
    if (variables.validity.valid && body.rows.length !== variables.valueAsNumber) render();
    onChange();
  });
  render();
  return { read, saveState: () => ({ preset: preset.value, rows }) };
}
