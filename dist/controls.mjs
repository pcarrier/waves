export function bindLogSlider(field, slider, digits, onInput) {
  const min = Number(field.min);
  const scale = Math.log(Number(field.max) / min);
  const sync = () => {
    if (field.validity.valid) slider.value = (Math.log(field.valueAsNumber / min) / scale) * 100;
  };
  field.addEventListener("input", sync);
  slider.addEventListener("input", (event) => {
    field.value = (min * Math.exp((Number(slider.value) / 100) * scale)).toFixed(digits);
    onInput?.(event);
  });
  sync();
}

export function createResultModes({ workspace, single, comparison, compareButton, backButton, initial, onChange }) {
  const singleHeading = workspace.querySelector(".results h2");
  const comparisonHeading = comparison.querySelector("h3");
  let comparing = Boolean(initial);

  function select(next, focus = false) {
    const changed = comparing !== next;
    comparing = next;
    workspace.toggleAttribute("data-comparing", comparing);
    compareButton.setAttribute("aria-expanded", comparing);
    single.hidden = comparing;
    comparison.hidden = !comparing;
    if (changed) onChange?.(comparing);
    if (focus) (comparing ? comparisonHeading : singleHeading).focus();
  }

  compareButton.addEventListener("click", () => select(true, true));
  backButton.addEventListener("click", () => select(false, true));
  select(comparing);
  return { select, get comparing() { return comparing; } };
}
