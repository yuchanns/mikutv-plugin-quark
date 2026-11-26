// External subtitle fetcher and VTT / SRT / ASS(SSA) parser.

import { PC_UA, QUARK_ORIGIN, QUARK_REFERER, fetchDownloadInfo, normalizeHTTPS } from "./api.js";
import { TTL_SUBTITLE_CUES, cacheGetJSON, cacheKey, cacheSetJSON, useCacheScope } from "./cache.js";

function parseTimestamp(raw) {
  const clean = String(raw || "").trim().replace(",", ".");
  const parts = clean.split(":");
  if (parts.length === 3) {
    const h = parseFloat(parts[0]);
    const m = parseFloat(parts[1]);
    const s = parseFloat(parts[2]);
    if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s)) {
      return h * 3600 + m * 60 + s;
    }
  } else if (parts.length === 2) {
    const m = parseFloat(parts[0]);
    const s = parseFloat(parts[1]);
    if (Number.isFinite(m) && Number.isFinite(s)) {
      return m * 60 + s;
    }
  }
  return NaN;
}

export function parseVTTorSRT(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = text.split(/\n{2,}/);
  const cues = [];
  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    let timeIdx = -1;
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].indexOf("-->") >= 0) {
        timeIdx = j;
        break;
      }
    }
    if (timeIdx < 0 || timeIdx + 1 >= lines.length) continue;
    const arrowParts = lines[timeIdx].split("-->");
    const start = parseTimestamp(arrowParts[0]);
    const end = parseTimestamp((arrowParts[1] || "").trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    const body = lines
      .slice(timeIdx + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\{\\[^}]*\}/g, "")
      .trim();
    if (!body) continue;
    cues.push({ start, end, text: body });
  }
  return cues;
}

export function parseASS(raw) {
  const lines = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const cues = [];
  let inEvents = false;
  let startIdx = 1;
  let endIdx = 2;
  let textIdx = 9;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      inEvents = line.toLowerCase() === "[events]";
      continue;
    }
    if (!inEvents) continue;
    if (line.toLowerCase().startsWith("format:")) {
      const cols = line.slice(7).split(",").map((c) => c.trim().toLowerCase());
      const si = cols.indexOf("start");
      const ei = cols.indexOf("end");
      const ti = cols.indexOf("text");
      if (si >= 0) startIdx = si;
      if (ei >= 0) endIdx = ei;
      if (ti >= 0) textIdx = ti;
      continue;
    }
    if (!line.toLowerCase().startsWith("dialogue:")) continue;
    const payload = line.slice(9).trim();
    const fields = [];
    let pos = 0;
    for (let f = 0; f < textIdx; f++) {
      const comma = payload.indexOf(",", pos);
      if (comma < 0) break;
      fields.push(payload.slice(pos, comma).trim());
      pos = comma + 1;
    }
    if (fields.length < textIdx) continue;
    const start = parseTimestamp(fields[startIdx]);
    const end = parseTimestamp(fields[endIdx]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    const body = payload
      .slice(pos)
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/\\N|\\n/g, "\n")
      .replace(/\\h/g, " ")
      .trim();
    if (!body) continue;
    cues.push({ start, end, text: body });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

export function parseSubtitleText(raw) {
  const sample = String(raw || "").slice(0, 2048);
  if (/\[Events\]/i.test(sample) || /^Dialogue:/m.test(sample)) {
    return parseASS(raw);
  }
  return parseVTTorSRT(raw);
}

export async function readSubtitles(req) {
  useCacheScope(req);
  const track = (req && req.track) || {};
  const urls = track.resource && Array.isArray(track.resource.urls) ? track.resource.urls : [];
  let subURL = urls[0] || "";

  // Parsed cues of a drive subtitle file are immutable per fid; the signed download URL is never cached.
  let cuesKey = "";
  // Support resolving lazy fid-based subtitle track IDs ("sub:<fid>") on demand.
  if (String(track.id || "").startsWith("sub:")) {
    const fid = String(track.id).slice(4);
    if (fid && (!subURL || subURL.indexOf("drive-pc.quark.cn") >= 0)) {
      cuesKey = cacheKey("subs", fid);
      const cached = cacheGetJSON(cuesKey);
      if (cached && Array.isArray(cached.cues)) return cached;
      const infos = await fetchDownloadInfo([fid]);
      const resolved = infos[0] && normalizeHTTPS(infos[0].download_url);
      if (resolved) subURL = resolved;
    }
  }
  if (!subURL) return { cues: [] };

  let resp;
  try {
    resp = await fetch(subURL, {
      method: "GET",
      headers: {
        Origin: QUARK_ORIGIN,
        Referer: QUARK_REFERER,
        "User-Agent": PC_UA,
      },
    });
  } catch (err) {
    throw { code: "network", message: String((err && err.message) || err || "subtitle fetch failed") };
  }
  if (!resp.ok) {
    throw { code: "network", message: `Subtitle HTTP ${resp.status}` };
  }
  const text = await resp.text();
  const result = { cues: parseSubtitleText(text) };
  if (cuesKey && result.cues.length > 0) cacheSetJSON(cuesKey, result, TTL_SUBTITLE_CUES);
  return result;
}
