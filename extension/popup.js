(async () => {
  const status = document.querySelector('[role=status]');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const frames = await chrome.scripting
      .executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => globalThis.intertitlesPlayer?.score() ?? -1
      })
      .catch(() => []);
    const frame = frames
      .filter((entry) => entry.result >= 0)
      .sort((a, b) => b.result - a.result || a.frameId - b.frameId)[0];
    await chrome.tabs.sendMessage(tab.id, { type: 'open-picker' }, { frameId: frame?.frameId ?? 0 });
    window.close();
    return;
  } catch {
    /* Internal browser pages and tabs awaiting a reload cannot receive messages. */
  }
  status.textContent =
    'Play a title on Netflix, Prime Video, HBO Max, or Disney+. If the tab was open during installation, reload it first.';
})();
