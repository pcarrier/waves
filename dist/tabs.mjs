export function createTabs(list, initial, onSelect) {
  const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute("aria-controls")));
  let active;

  function select(id, focus = false) {
    active = panels.find((panel) => panel.id === id)?.id ?? panels[0].id;
    tabs.forEach((tab, index) => {
      const selected = panels[index].id === active;
      tab.setAttribute("aria-selected", selected);
      tab.tabIndex = selected ? 0 : -1;
      panels[index].hidden = !selected;
      if (selected && focus) tab.focus();
    });
  }

  function activate(index, focus) {
    select(panels[index].id, focus);
    onSelect?.(active);
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      activate(index, false);
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key === " " && tab.tagName === "A") {
        event.preventDefault();
        activate(index, true);
        return;
      }
      const last = tabs.length - 1;
      const next = { ArrowLeft: (index + last) % tabs.length, ArrowRight: (index + 1) % tabs.length, Home: 0, End: last }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      activate(next, true);
    });
  });

  select(initial);
  return { select, get active() { return active; } };
}
