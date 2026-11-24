// Compact local playback history & resume persistence inside host.storage (8 KiB budget).

const HISTORY_KEY = "quark_history_v1";
const MAX_HISTORY = 16;

function loadHistoryList() {
  try {
    if (typeof host === "undefined" || !host.storage || typeof host.storage.get !== "function") {
      return [];
    }
    const raw = host.storage.get(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function saveHistoryList(items) {
  try {
    if (typeof host === "undefined" || !host.storage || typeof host.storage.set !== "function") {
      return;
    }
    const trimmed = items.slice(0, MAX_HISTORY);
    // Guard against 8 KiB storage quota by dropping oldest entries if needed.
    while (trimmed.length > 0 && JSON.stringify(trimmed).length > 5600) {
      trimmed.pop();
    }
    host.storage.set(HISTORY_KEY, JSON.stringify(trimmed));
  } catch (_) {}
}

export function getHistoryItems() {
  return loadHistoryList();
}

export function findHistoryProgress(itemId) {
  const id = String(itemId || "");
  if (!id) return null;
  const list = loadHistoryList();
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) return list[i];
  }
  return null;
}

export function recordHistoryEntry(entry) {
  if (!entry || !entry.id) return;
  const list = loadHistoryList().filter((it) => it && it.id !== entry.id);
  const rawCover = String(entry.coverURL || "");
  const compact = {
    id: String(entry.id),
    kind: String(entry.kind || "video"),
    title: String(entry.title || "").slice(0, 120),
    subtitle: String(entry.subtitle || "").slice(0, 120),
    coverURL: rawCover.length <= 1024 ? rawCover : "",
    coverVer: Number(entry.coverVer || 0),
    partID: String(entry.partID || ""),
    duration: Math.max(0, Math.floor(Number(entry.duration || 0))),
    seconds: Math.max(0, Math.floor(Number(entry.seconds || 0))),
    finished: Boolean(entry.finished),
    time: Math.floor(Date.now() / 1000),
  };
  list.unshift(compact);
  saveHistoryList(list);
}
