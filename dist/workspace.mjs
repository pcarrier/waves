const key = "privacy-waves.workspace.v1";

export function loadWorkspace() {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? {};
  } catch {
    return {};
  }
}

export function storeWorkspace(workspace) {
  try {
    localStorage.setItem(key, JSON.stringify(workspace));
  } catch {
    // Storage can be unavailable or full. Keep the live workspace usable.
  }
}

export function restoreValue(field, value) {
  if (typeof value !== "string") return;
  if (field.options && !Array.from(field.options).some((option) => option.value === value)) return;
  field.value = value;
}
