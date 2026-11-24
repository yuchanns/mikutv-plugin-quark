// Quark Drive playback resolver (transcoded multi-quality HLS/MP4 + original direct stream,
// sprite seek thumbnails, matched external subtitles, and resume progress reporting).

import {
  AVPLAYER_DIRECT_EXT_RE,
  PC_UA,
  QUARK_ORIGIN,
  QUARK_REFERER,
  cleanMediaTitle,
  decodeBasicEntities,
  entryCoverURL,
  entryDurationSeconds,
  fetchDownloadInfo,
  fetchPlayProject,
  getFileInfo,
  isSubtitleFile,
  listFolder,
  normalizeHTTPS,
  stripExtension,
} from "./api.js";
import { collectSeriesVideos } from "./catalog.js";
import { findHistoryProgress, recordHistoryEntry } from "./history.js";
import { t } from "./i18n.js";

const RESOLUTION_ORDER = ["4k", "2k", "super", "high", "normal", "low"];

const STREAM_HEADERS = {
  Origin: QUARK_ORIGIN,
  Referer: QUARK_REFERER,
  "User-Agent": PC_UA,
};

function labelForResolution(resKey, hasDolbyVision) {
  const copy = t();
  const map = {
    "4k": copy.q4k,
    "2k": copy.q2k,
    super: copy.qSuper,
    high: copy.qHigh,
    normal: copy.qNormal,
    low: copy.qLow,
  };
  const base = map[resKey] || String(resKey || "").toUpperCase();
  return hasDolbyVision ? `${base} · ${copy.dolbyVision}` : base;
}

function badgeForResolution(resKey, hasDolbyVision) {
  if (hasDolbyVision) return resKey === "4k" ? "4K DV" : "DV";
  switch (resKey) {
    case "4k":
      return "4K";
    case "2k":
      return "2K";
    case "super":
      return "1080P";
    case "high":
      return "720P";
    default:
      return "";
  }
}

function guessStreamFormat(url, formatHint) {
  const f = String(formatHint || "").toLowerCase();
  const u = String(url || "").toLowerCase();
  if (f.includes("m3u8") || f.includes("hls") || /\.m3u8(\?|$)/.test(u)) {
    return { format: "hls", contentType: "application/vnd.apple.mpegurl" };
  }
  return { format: "direct", contentType: "video/mp4" };
}

function parseSeekThumbnails(project) {
  const spd = project && project.seek_preview_data;
  if (!spd || !Array.isArray(spd.preview_sprite_infos) || spd.preview_sprite_infos.length === 0) {
    return null;
  }
  const cols = Number(spd.sprite_column || 0);
  const rows = Number(spd.sprite_row || 0);
  const width = Number(spd.frame_width || 0);
  const height = Number(spd.frame_height || 0);
  if (cols < 1 || rows < 1 || width < 1 || height < 1) return null;

  const images = [];
  const times = [];
  for (let i = 0; i < spd.preview_sprite_infos.length; i++) {
    const sprite = spd.preview_sprite_infos[i];
    const url = normalizeHTTPS(sprite && sprite.url);
    if (!url) continue;
    images.push(url);
    if (Array.isArray(sprite.times)) {
      for (let j = 0; j < sprite.times.length; j++) {
        const sec = Number(sprite.times[j]);
        if (Number.isFinite(sec) && sec >= 0) {
          times.push(sec);
        }
      }
    }
  }
  if (images.length === 0) return null;
  // Ensure monotonic non-decreasing timestamps as enforced by MikuTV host.
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) {
      times.length = 0;
      break;
    }
  }
  return { images, times, columns: cols, rows, width, height };
}

function detectSubtitleLanguage(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (/(^|[._\-\s])(chs|zh-hans|sc|gb|简|简体)([._\-\s]|$)/.test(lower)) return "zh-Hans";
  if (/(^|[._\-\s])(cht|zh-hant|tc|big5|繁|繁体)([._\-\s]|$)/.test(lower)) return "zh-Hant";
  if (/(^|[._\-\s])(zh|chi|cn|中文)([._\-\s]|$)/.test(lower)) return "zh";
  if (/(^|[._\-\s])(ja|jp|jpn|日|日语)([._\-\s]|$)/.test(lower)) return "ja";
  if (/(^|[._\-\s])(en|eng|英|英文)([._\-\s]|$)/.test(lower)) return "en";
  return "";
}

function matchSubtitleFiles(videoFileName, siblingEntries) {
  const copy = t();
  const subs = (siblingEntries || []).filter(isSubtitleFile);
  if (subs.length === 0) return [];

  const videoStem = stripExtension(decodeBasicEntities(videoFileName)).toLowerCase();
  const exact = [];
  const other = [];
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    const sName = decodeBasicEntities(s.file_name);
    const sStem = stripExtension(sName).toLowerCase();
    if (videoStem && (sStem === videoStem || sStem.startsWith(videoStem + ".") || sStem.startsWith(videoStem + "_"))) {
      exact.push(s);
    } else {
      other.push(s);
    }
  }
  // If exact-stem matches exist, only attach those; otherwise if folder has <= 4 subtitles
  // (typical single-movie directory), offer them cleanly.
  const picked = exact.length > 0 ? exact : other.length <= 4 ? other : [];
  return picked.map((s, idx) => {
    const rawName = decodeBasicEntities(s.file_name);
    const lang = detectSubtitleLanguage(rawName);
    const label = stripExtension(rawName).trim() || copy.subtitleTrack(idx + 1);
    return {
      id: "sub:" + String(s.fid),
      label,
      language: lang,
      default: idx === 0 && exact.length > 0,
      resource: {
        urls: ["https://drive-pc.quark.cn/1/clouddrive/file/download?fid=" + encodeURIComponent(String(s.fid))],
        headers: STREAM_HEADERS,
      },
    };
  });
}

function pickDefaultQuality(candidates, preferredQuality) {
  if (candidates.length === 0) return null;
  const byId = {};
  for (let i = 0; i < candidates.length; i++) byId[candidates[i].id] = candidates[i];

  const pref = String(preferredQuality || "");
  if (pref === "720p" && byId.high) return byId.high;
  if (pref === "1080p" && byId.super) return byId.super;
  if ((pref === "4k-hdr" || pref === "4k") && byId["4k"]) return byId["4k"];

  // Prefer highest transcoded HLS/fMP4 stream for guaranteed tvOS AVPlayer compatibility
  // (many cloud-drive MP4/MKV files use hev1, DTS, or non-Apple muxing that AVURLAsset rejects).
  // Keep "original" selectable in the quality menu and as fallback when no transcode exists.
  for (let i = 0; i < RESOLUTION_ORDER.length; i++) {
    const c = byId[RESOLUTION_ORDER[i]];
    if (c) return c;
  }
  if (byId.original) return byId.original;
  return candidates[0];
}

export async function resolvePlayback(req) {
  if (!req || (!req.signedIn && !req.secret)) {
    throw { code: "signIn", message: "Sign in to Quark Drive first." };
  }
  const copy = t();
  const ref = (req && req.ref) || {};
  let playFid = String((req && req.partID) || "").trim();
  let episodes = [];

  if (ref.kind === "series") {
    const collected = await collectSeriesVideos(ref.id);
    episodes = collected.videos.map((entry) => {
      const baseTitle = cleanMediaTitle(entry.file.file_name) || String(entry.file.fid);
      const title = entry.prefix ? `${entry.prefix} · ${baseTitle}` : baseTitle;
      const seg = { title, partID: String(entry.file.fid) };
      const dur = entryDurationSeconds(entry.file);
      if (dur !== undefined) seg.durationSeconds = dur;
      return seg;
    });
    if (!playFid) {
      if (episodes.length === 0) {
        throw { code: "plugin", message: "No playable video found in this folder." };
      }
      playFid = episodes[0].partID;
    }
  } else if (!playFid) {
    playFid = String(ref.id || "").trim();
  }
  if (!playFid) throw { code: "plugin", message: "Missing video id." };

  const [fileInfo, project, downloadList] = await Promise.all([
    getFileInfo(playFid).catch(() => null),
    fetchPlayProject(playFid).catch(() => null),
    fetchDownloadInfo([playFid]).catch(() => []),
  ]);

  const downInfo = (downloadList && downloadList[0]) || null;
  const fileName = decodeBasicEntities(
    (fileInfo && fileInfo.file_name) ||
      (project && project.file_name) ||
      (downInfo && downInfo.file_name) ||
      ""
  );
  const parentFid = String((fileInfo && fileInfo.pdir_fid) || (downInfo && downInfo.pdir_fid) || "");
  let subtitles = [];
  if (parentFid && parentFid !== "0") {
    try {
      const siblings = await listFolder(parentFid, { page: 1, size: 100, sort: "file_name:asc" });
      subtitles = matchSubtitleFiles(fileName, siblings.list);
    } catch (_) {}
  }

  // Build quality candidates from transcoded video_list + original download URL.
  const candidates = [];
  const qualities = [];
  const videoList = (project && Array.isArray(project.video_list)) ? project.video_list : [];

  // Sort transcoded streams highest resolution first.
  const sortedTranscoded = videoList.slice().sort((a, b) => {
    const ia = RESOLUTION_ORDER.indexOf(String((a && a.resolution) || "").toLowerCase());
    const ib = RESOLUTION_ORDER.indexOf(String((b && b.resolution) || "").toLowerCase());
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  for (let i = 0; i < sortedTranscoded.length; i++) {
    const entry = sortedTranscoded[i];
    const vi = entry && entry.video_info;
    const resKey = String((entry && entry.resolution) || (vi && vi.resolution) || "").toLowerCase();
    if (!resKey) continue;
    const url = normalizeHTTPS(vi && vi.url);
    const hasDV = Boolean(vi && vi.dolby_vision && vi.dolby_vision.profile);
    const label = labelForResolution(resKey, hasDV);
    const badge = badgeForResolution(resKey, hasDV);
    const bandwidth = Number((vi && vi.bitrate) || 0);

    if (url) {
      const fmt = guessStreamFormat(url, vi && vi.format);
      const cand = {
        id: resKey,
        label,
        badge,
        hdr: hasDV,
        bandwidth: Number.isFinite(bandwidth) && bandwidth > 0 ? Math.floor(bandwidth) : 0,
        stream: {
          format: fmt.format,
          video: {
            resource: { urls: [url], headers: STREAM_HEADERS },
            contentType: fmt.contentType,
            width: Number((vi && vi.width) || 0),
            height: Number((vi && vi.height) || 0),
          },
        },
      };
      candidates.push(cand);
      qualities.push({
        id: cand.id,
        label: cand.label,
        badge: cand.badge,
        hdr: cand.hdr,
        bandwidth: cand.bandwidth,
      });
    } else if (entry && entry.member_right && !entry.accessable) {
      qualities.push({
        id: resKey,
        label,
        badge,
        hdr: hasDV,
        limit: "membership",
      });
    }
  }

  const directURL = normalizeHTTPS(downInfo && downInfo.download_url);
  if (directURL) {
    const origCand = {
      id: "original",
      label: copy.originalQuality,
      badge: "RAW",
      hdr: false,
      bandwidth: 0,
      stream: {
        format: "direct",
        video: {
          resource: { urls: [directURL], headers: STREAM_HEADERS },
          contentType: AVPLAYER_DIRECT_EXT_RE.test(fileName) ? "video/mp4" : "application/octet-stream",
        },
      },
    };
    candidates.unshift(origCand);
    qualities.unshift({
      id: origCand.id,
      label: origCand.label,
      badge: origCand.badge,
    });
  }

  if (candidates.length === 0) {
    throw { code: "plugin", message: "No playable stream URL returned by Quark Drive." };
  }

  let chosen = null;
  if (req && req.quality) {
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].id === req.quality) {
        chosen = candidates[i];
        break;
      }
    }
  }
  if (!chosen) {
    chosen = pickDefaultQuality(candidates, req && req.preferredQuality);
  }

  const projectDur = Number(
    (project && project.meta && project.meta.duration) ||
      (sortedTranscoded[0] && sortedTranscoded[0].video_info && sortedTranscoded[0].video_info.duration) ||
      0
  );
  const infoDur = entryDurationSeconds(fileInfo || downInfo) || 0;
  const duration = projectDur > 0 ? Math.floor(projectDur) : infoDur;

  const localHist = findHistoryProgress(ref.kind === "series" ? ref.id : playFid);
  const cloudResume = Number((project && project.last_play_info && project.last_play_info.time) || 0);
  const rawResume = (localHist && localHist.seconds > 0) ? localHist.seconds : cloudResume;
  const resumeSeconds = duration > 0 && rawResume > 0 && rawResume < duration - 5 ? rawResume : 0;

  const plan = {
    itemID: playFid,
    duration,
    resumeSeconds,
    access: "granted",
    quality: chosen.id,
    qualities,
    streams: [chosen.stream],
    subtitles,
    episodes,
  };
  if (req && req.partID) {
    plan.partID = String(req.partID);
  } else if (ref.kind === "series" && playFid) {
    plan.partID = playFid;
  }
  const thumbnails = parseSeekThumbnails(project);
  if (thumbnails) {
    plan.thumbnails = thumbnails;
  }
  return plan;
}

export async function reportPlayback(req) {
  const data = (req && req.data) || {};
  const ref = data.ref || {};
  const isSeries = ref.kind === "series";
  const id = String((isSeries ? ref.id : data.itemID || ref.id) || "").trim();
  if (!id) return {};
  const existing = findHistoryProgress(id) || {};
  let title = existing.title || "";
  let coverURL = existing.coverURL || "";
  let duration = existing.duration || 0;
  const playFid = String(data.partID || data.itemID || existing.partID || id).trim();
  const needCoverRefresh = !coverURL || existing.coverVer !== 2;
  if (!title || needCoverRefresh || !duration) {
    try {
      const info = await getFileInfo(isSeries ? id : playFid);
      if (info) {
        if (!title) title = cleanMediaTitle(info.file_name) || id;
        if (needCoverRefresh) coverURL = entryCoverURL(info) || coverURL;
        if (!duration) duration = entryDurationSeconds(info) || 0;
      }
      if (isSeries && (needCoverRefresh || !duration) && playFid && playFid !== id) {
        const epInfo = await getFileInfo(playFid);
        if (epInfo) {
          if (needCoverRefresh) coverURL = entryCoverURL(epInfo) || coverURL;
          if (!duration) duration = entryDurationSeconds(epInfo) || 0;
        }
      }
    } catch (_) {}
  }
  recordHistoryEntry({
    id,
    kind: isSeries ? "series" : existing.kind || "video",
    title: title || id,
    subtitle: existing.subtitle || "",
    coverURL,
    coverVer: 2,
    partID: String(data.partID || existing.partID || ""),
    duration,
    seconds: Number(data.seconds || 0),
    finished: Boolean(data.finished),
  });
  return {};
}
