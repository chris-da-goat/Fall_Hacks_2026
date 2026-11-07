const $ = (id) => document.getElementById(id);

async function load() {
  const {
    usage = {},
    exercises = 0,
    limitMin = 20,
  } = await chrome.storage.local.get(["usage", "exercises", "limitMin"]);
  const secs = usage[new Date().toDateString()] || 0;
  $("today").textContent = Math.floor(secs / 60) + " min";
  $("ex").textContent = exercises;
  $("limit").value = limitMin;
}

$("limit").addEventListener("change", () => {
  const v = Math.max(1, parseInt($("limit").value) || 20);
  chrome.storage.local.set({ limitMin: v });
});

$("test").addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) {
    chrome.tabs
      .sendMessage(tabs[0].id, { type: "TEST_HACKIE", minutes: 20 })
      .catch(() =>
        alert("Open YouTube or Instagram in this tab first (then refresh it)."),
      );
  }
});

load();

$("reset").addEventListener("click", () => {
  chrome.storage.local.set({
    nagging: false,
    snoozeUntil: 0,
    snoozeCount: 0,
    sinceNag: 0,
  });
});
