// Quark Cloud Drive web/desktop API client & file classification helpers.

import {
  TTL_FILE_INFO,
  TTL_FOLDER_LIST,
  TTL_INDEX,
  cacheKey,
  cachedRead,
} from "./cache.js";

export const QUARK_ORIGIN = "https://pan.quark.cn";
export const QUARK_REFERER = "https://pan.quark.cn/";
export const DRIVE_API_BASE = "https://drive-pc.quark.cn/1/clouddrive";
export const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
export const PC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";

export const VIDEO_EXT_RE = /\.(mp4|m4v|mov|mkv|ts|m2ts|avi|webm|flv|wmv|mpg|mpeg|rmvb)$/i;
export const AVPLAYER_DIRECT_EXT_RE = /\.(mp4|m4v|mov)$/i;
export const SUBTITLE_EXT_RE = /\.(vtt|srt|ass|ssa)$/i;
export const POSTER_NAME_RE = /^(poster|cover|folder|fanart|backdrop|thumb)\.(jpe?g|png|webp)$/i;

export function qs(params) {
  const parts = [];
  for (const key in params) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    const val = params[key];
    if (val === undefined || val === null) continue;
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(val)));
  }
  return parts.length ? "?" + parts.join("&") : "";
}

export function normalizeHTTPS(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("https://")) return s;
  if (s.startsWith("http://")) return "https://" + s.slice(7);
  if (s.startsWith("//")) return "https:" + s;
  return "";
}

export function decodeBasicEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<\/?em>/gi, "");
}

export function stripExtension(name) {
  return String(name || "").replace(/\.[^./\\]{1,6}$/, "");
}

export function cleanMediaTitle(rawName) {
  const decoded = decodeBasicEntities(rawName).trim();
  if (!decoded) return "";
  return stripExtension(decoded).trim() || decoded;
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let val = n;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return (val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)) + " " + units[idx];
}

export function naturalCompare(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  const re = /(\d+|\D+)/g;
  const pa = sa.match(re) || [];
  const pb = sb.match(re) || [];
  const len = Math.min(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if (pa[i] === pb[i]) continue;
    const na = /^\d+$/.test(pa[i]) ? Number(pa[i]) : NaN;
    const nb = /^\d+$/.test(pb[i]) ? Number(pb[i]) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    }
    const cmp = pa[i].localeCompare(pb[i]);
    if (cmp !== 0) return cmp;
  }
  return pa.length - pb.length;
}

export function isFolder(entry) {
  if (!entry) return false;
  if (entry.dir === true || entry.file === false) return true;
  return Number(entry.file_type) === 0 && entry.file !== true;
}

export function isVideoFile(entry) {
  if (!entry || isFolder(entry)) return false;
  if (Number(entry.category) === 1) return true;
  return VIDEO_EXT_RE.test(String(entry.file_name || ""));
}

export function isSubtitleFile(entry) {
  if (!entry || isFolder(entry)) return false;
  return SUBTITLE_EXT_RE.test(String(entry.file_name || ""));
}

export function isPosterImage(entry) {
  if (!entry || isFolder(entry)) return false;
  return POSTER_NAME_RE.test(String(entry.file_name || ""));
}

export function entryCoverURL(entry) {
  if (!entry) return "";
  return normalizeHTTPS(
    entry.big_thumbnail ||
      entry.big_extra_thumbnail ||
      entry.thumbnail ||
      entry.thumbnail_url ||
      (entry.extra &&
        (entry.extra.big_thumbnail ||
          entry.extra.big_extra_thumbnail ||
          entry.extra.thumbnail)) ||
      entry.preview_url ||
      ""
  );
}

export function entryBackdropURL(entry) {
  if (!entry) return "";
  return normalizeHTTPS(
    entry.big_thumbnail ||
      entry.big_extra_thumbnail ||
      entry.preview_url ||
      entry.thumbnail ||
      entry.thumbnail_url ||
      (entry.extra &&
        (entry.extra.big_thumbnail ||
          entry.extra.big_extra_thumbnail ||
          entry.extra.thumbnail)) ||
      ""
  );
}

export function entryDurationSeconds(entry) {
  if (!entry) return undefined;
  const raw = Number(entry.duration || (entry.video_info && entry.video_info.duration) || 0);
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  // Quark occasionally reports duration in milliseconds (> 100000) or seconds.
  return raw > 86400 ? Math.floor(raw / 1000) : Math.floor(raw);
}

export function entryUpdatedUnix(entry) {
  if (!entry) return 0;
  const raw = Number(entry.updated_at || entry.l_updated_at || entry.created_at || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
}

export function qualityHintFromEntry(entry) {
  const name = String((entry && entry.file_name) || "");
  const w = Number((entry && entry.video_width) || 0);
  const h = Number((entry && entry.video_height) || 0);
  const hdr = /\b(dv|dovi|dolby\.?vision|hdr10\+?|hdr)\b/i.test(name);
  if (w >= 3800 || h >= 2100 || /\b(2160p|4k|uhd)\b/i.test(name)) {
    return hdr ? "4K HDR" : "4K";
  }
  if (w >= 1900 || h >= 1000 || /\b1080p\b/i.test(name)) {
    return hdr ? "1080p HDR" : "1080p";
  }
  if (w >= 1200 || h >= 700 || /\b720p\b/i.test(name)) {
    return "720p";
  }
  return "";
}

async function flushDriveCookies() {
  try {
    await fetch(`${DRIVE_API_BASE}/auth/pc/flush?pr=ucpro&fr=pc&uc_param_str=`, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Origin: QUARK_ORIGIN,
        Referer: QUARK_REFERER,
        "User-Agent": PC_UA,
      },
    });
  } catch (_) {}
}

export async function driveRequest(path, opts) {
  const options = opts || {};
  const method = options.method || "GET";
  const params = Object.assign({ pr: "ucpro", fr: "pc", uc_param_str: "" }, options.params || {});
  const url = DRIVE_API_BASE + path + qs(params);
  const headers = Object.assign(
    {
      Accept: "application/json, text/plain, */*",
      Origin: QUARK_ORIGIN,
      Referer: QUARK_REFERER,
      "User-Agent": options.userAgent || PC_UA,
    },
    options.headers || {}
  );
  const fetchOpts = { method, headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(options.body);
  }
  let resp;
  try {
    resp = await fetch(url, fetchOpts);
  } catch (err) {
    throw { code: "network", message: String((err && err.message) || err || "network error") };
  }
  if (resp.status === 401 || resp.status === 403) {
    if (!options._flushed) {
      await flushDriveCookies();
      return driveRequest(path, Object.assign({}, options, { _flushed: true }));
    }
    throw { code: "signIn", message: "Quark Drive session expired." };
  }
  if (resp.status === 429) {
    throw { code: "rateLimited", message: "Quark Drive rate limited request." };
  }
  let body;
  try {
    body = await resp.json();
  } catch (_) {
    if (!resp.ok) throw { code: "network", message: "Quark Drive HTTP " + resp.status };
    throw { code: "plugin", message: "Invalid JSON response from Quark Drive." };
  }
  const code = Number(body && body.code != null ? body.code : 0);
  const status = Number(body && body.status != null ? body.status : resp.status);
  if (code === 31001 || code === 31002 || status === 401 || status === 403) {
    if (!options._flushed) {
      await flushDriveCookies();
      return driveRequest(path, Object.assign({}, options, { _flushed: true }));
    }
    throw { code: "signIn", message: String((body && body.message) || "Quark Drive sign-in required.") };
  }
  if (code === 31006 || status === 429) {
    throw { code: "rateLimited", message: String((body && body.message) || "Rate limited.") };
  }
  if (!resp.ok || status >= 400 || code !== 0) {
    throw {
      code: "plugin",
      message: String((body && body.message) || `Quark API error (status=${status}, code=${code})`),
    };
  }
  return { body, response: resp };
}

// Fields the catalog/playback mappers read from a file entry. Listings are cached in
// this slimmed shape so large folders stay under host.cache's per-entry limit.
const ENTRY_FIELDS = [
  "fid", "pdir_fid", "file_name", "dir", "file", "file_type", "category", "size",
  "big_thumbnail", "big_extra_thumbnail", "thumbnail", "thumbnail_url", "preview_url",
  "duration", "video_width", "video_height", "updated_at", "l_updated_at", "created_at",
];

function slimEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const out = {};
  for (let i = 0; i < ENTRY_FIELDS.length; i++) {
    const k = ENTRY_FIELDS[i];
    if (entry[k] !== undefined) out[k] = entry[k];
  }
  if (entry.extra && typeof entry.extra === "object") {
    const extra = {};
    if (entry.extra.big_thumbnail !== undefined) extra.big_thumbnail = entry.extra.big_thumbnail;
    if (entry.extra.big_extra_thumbnail !== undefined) extra.big_extra_thumbnail = entry.extra.big_extra_thumbnail;
    if (entry.extra.thumbnail !== undefined) extra.thumbnail = entry.extra.thumbnail;
    out.extra = extra;
  }
  if (entry.video_info && typeof entry.video_info === "object" && entry.video_info.duration !== undefined) {
    out.video_info = { duration: entry.video_info.duration };
  }
  return out;
}

function slimPage(page) {
  return { list: page.list.map(slimEntry), total: page.total };
}

export async function listFolder(pdirFid, opts) {
  const options = opts || {};
  const fid = String(pdirFid || "0");
  const key = cacheKey(
    "ls", fid, options.page || 1, options.size || 100,
    options.sort || "file_type:asc,updated_at:desc", options.category == null ? "" : options.category
  );
  return cachedRead(key, TTL_FOLDER_LIST, () => fetchFolderPage(fid, options), slimPage);
}

async function fetchFolderPage(pdirFid, options) {
  const params = {
    pdir_fid: pdirFid,
    _page: options.page || 1,
    _size: options.size || 100,
    _fetch_total: 1,
    _fetch_sub_dirs: 0,
    fetch_all_file: 1,
    fetch_risk_file_name: 1,
    _sort: options.sort || "file_type:asc,updated_at:desc",
  };
  if (options.category !== undefined && options.category !== "") {
    params.category = options.category;
  }
  const { body } = await driveRequest("/file/sort", { params });
  const list = (body && body.data && Array.isArray(body.data.list)) ? body.data.list : [];
  const total = Number((body && body.metadata && body.metadata._total) || list.length);
  return { list, total };
}

export async function listAllVideosGlobal(page, size, sort) {
  const key = cacheKey("cat", page || 1, size || 30, sort || "");
  return cachedRead(key, TTL_INDEX, () => fetchGlobalVideos(page, size, sort), slimPage);
}

async function fetchGlobalVideos(page, size, sort) {
  const effectiveSort = sort || "file_type:asc,updated_at:desc";
  const params = {
    cat: "video",
    _page: page || 1,
    _size: size || 30,
    _fetch_total: 1,
    _sort: effectiveSort,
  };
  let body;
  try {
    ({ body } = await driveRequest("/file/category", { params }));
  } catch (err) {
    // Some Quark backend nodes reject non-standard _sort keys (e.g. file_size:desc) on /file/category.
    if (err && (err.code === "signIn" || err.code === "rateLimited")) throw err;
    if (effectiveSort === "file_type:asc,updated_at:desc") throw err;
    ({ body } = await driveRequest("/file/category", {
      params: Object.assign({}, params, { _sort: "file_type:asc,updated_at:desc" }),
    }));
  }
  const rawList = (body && body.data && Array.isArray(body.data.list)) ? body.data.list : [];
  let videos = rawList.filter(isVideoFile);
  if (sort === "file_size:desc") {
    videos = videos.slice().sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
  }
  const total = Number((body && body.metadata && body.metadata._total) || videos.length);
  return { list: videos, total };
}

export async function getFileInfo(fid) {
  return cachedRead(cacheKey("info", String(fid)), TTL_FILE_INFO, () => fetchFileInfo(fid), slimEntry);
}

async function fetchFileInfo(fid) {
  const { body } = await driveRequest("/file/info", {
    params: { fid: String(fid) },
  });
  return (body && body.data) || null;
}

export async function searchDrive(query, page, size, sort) {
  const q = String(query || "").trim();
  const key = cacheKey("q", encodeURIComponent(q), page || 1, size || 50, sort || "");
  return cachedRead(key, TTL_INDEX, () => fetchSearchPage(q, page, size, sort), slimPage);
}

async function fetchSearchPage(query, page, size, sort) {
  const { body } = await driveRequest("/file/search", {
    params: {
      q: query,
      _page: page || 1,
      _size: size || 50,
      _fetch_total: 1,
      _sort: sort || "file_type:desc,updated_at:desc",
      _is_hl: 0,
    },
  });
  const list = (body && body.data && Array.isArray(body.data.list)) ? body.data.list : [];
  const total = Number((body && body.metadata && body.metadata._total) || list.length);
  return { list, total };
}

export async function fetchMemberInfo() {
  const { body, response } = await driveRequest("/member", {
    params: { fetch_subscribe: "false", _ch: "home", fetch_identity: "false" },
  });
  return { data: (body && body.data) || null, response };
}

export async function fetchPlayProject(fid) {
  try {
    const { body } = await driveRequest("/file/v2/play/project", {
      method: "POST",
      body: {
        fid: String(fid),
        resolutions: "low,normal,high,super,2k,4k",
        supports: "fmp4_av,m3u8,dolby_vision",
      },
    });
    const data = (body && body.data) || null;
    if (data && Array.isArray(data.video_list) && data.video_list.length > 0) {
      return data;
    }
  } catch (err) {
    if (err && (err.code === "signIn" || err.code === "rateLimited")) throw err;
  }
  const { body } = await driveRequest("/file/v2/play", {
    method: "POST",
    body: {
      fid: String(fid),
      resolutions: "low,normal,high,super,2k,4k",
      supports: "fmp4,m3u8",
    },
  });
  return (body && body.data) || null;
}

export async function fetchDownloadInfo(fids) {
  const { body } = await driveRequest("/file/download", {
    method: "POST",
    body: { fids: Array.isArray(fids) ? fids.map(String) : [String(fids)] },
  });
  return Array.isArray(body && body.data) ? body.data : [];
}
