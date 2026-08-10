const navItems = document.querySelectorAll(".nav-item");
const screens = document.querySelectorAll(".screen");
const panelTriggers = document.querySelectorAll("[data-open-panel]");
const panelClosers = document.querySelectorAll("[data-close-panel]");
const panels = document.querySelectorAll(".overlay-panel");

function switchScreen(target) {
  screens.forEach((screen) => {
    screen.classList.toggle("is-active", screen.dataset.screen === target);
  });

  navItems.forEach((item) => {
    item.classList.toggle("is-active", item.dataset.target === target);
  });
}

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    switchScreen(item.dataset.target);
  });
});

function openPanel(name) {
  panels.forEach((panel) => {
    const isMatch = panel.dataset.panel === name;
    panel.classList.toggle("is-open", isMatch);
    panel.setAttribute("aria-hidden", String(!isMatch));
  });
}

function closePanel(name) {
  panels.forEach((panel) => {
    if (panel.dataset.panel === name) {
      panel.classList.remove("is-open");
      panel.setAttribute("aria-hidden", "true");
    }
  });
}

panelTriggers.forEach((trigger) => {
  trigger.addEventListener("click", () => {
    openPanel(trigger.dataset.openPanel);
  });
});

panelClosers.forEach((closer) => {
  closer.addEventListener("click", () => {
    closePanel(closer.dataset.closePanel);
  });
});

panels.forEach((panel) => {
  panel.addEventListener("click", (event) => {
    if (event.target === panel) {
      closePanel(panel.dataset.panel);
    }
  });
});
