// Quark Drive catalog browsing, smart folder-to-series mapping, folder drill-down, search & history.

import {
  cleanMediaTitle,
  decodeBasicEntities,
  entryBackdropURL,
  entryCoverURL,
  entryDurationSeconds,
  entryUpdatedUnix,
  formatBytes,
  getFileInfo,
  isFolder,
  isPosterImage,
  isVideoFile,
  listAllVideosGlobal,
  listFolder,
  naturalCompare,
  qualityHintFromEntry,
  searchDrive,
} from "./api.js";
import { findHistoryProgress, getHistoryItems } from "./history.js";
import { t } from "./i18n.js";

function requireSignedIn(req) {
  if (!req || (!req.signedIn && !req.owner && !req.secret)) {
    throw { code: "signIn", message: "Sign in to Quark Drive first." };
  }
}

function pickFolderPoster(entries, preferBackdrop) {
  const getter = preferBackdrop ? entryBackdropURL : entryCoverURL;
  for (let i = 0; i < entries.length; i++) {
    if (isPosterImage(entries[i])) {
      const url = getter(entries[i]);
      if (url) return url;
    }
  }
  for (let i = 0; i < entries.length; i++) {
    if (isVideoFile(entries[i])) {
      const url = getter(entries[i]);
      if (url) return url;
    }
  }
  return "";
}

export function mapVideoEntry(entry, folderCtx) {
  const title = cleanMediaTitle(entry.file_name) || String(entry.fid);
  const coverURL = entryCoverURL(entry);
  const backdropURL = entryBackdropURL(entry) || coverURL;
  const duration = entryDurationSeconds(entry);
  const quality = qualityHintFromEntry(entry);
  const sizeLabel = entry.size > 0 ? formatBytes(entry.size) : "";
  const folderName = folderCtx && folderCtx.name ? String(folderCtx.name) : "";
  const parts = [];
  if (folderName) parts.push(folderName);
  if (sizeLabel) parts.push(sizeLabel);
  const subtitle = parts.join(" · ");

  const item = {
    ref: { kind: "video", id: String(entry.fid) },
    title,
    subtitle,
    coverURL,
    backdropURL,
    quality,
  };
  if (folderName) {
    item.category = folderName;
  }
  if (duration !== undefined) item.durationSeconds = duration;
  const hist = findHistoryProgress(entry.fid);
  if (hist && hist.seconds > 0 && !hist.finished) {
    item.progressSeconds = hist.seconds;
  }
  return item;
}

export function mapFolderAsSeries(folderEntry, childEntries) {
  const copy = t();
  const title = decodeBasicEntities(folderEntry.file_name).trim() || String(folderEntry.fid);
  const children = Array.isArray(childEntries) ? childEntries : [];
  const videos = children.filter(isVideoFile);
  const subfolders = children.filter(isFolder);
  const coverURL = pickFolderPoster(children, false) || entryCoverURL(folderEntry);
  const backdropURL = pickFolderPoster(children, true) || entryBackdropURL(folderEntry) || coverURL;

  let subtitle = copy.folderLabel;
  if (videos.length > 0) {
    subtitle = `${copy.episodeCount(videos.length)} · ${copy.collectionLabel}`;
  } else if (subfolders.length > 0) {
    subtitle = `${copy.itemCount(subfolders.length)} · ${copy.folderLabel}`;
  }

  let quality = "";
  for (let i = 0; i < videos.length && !quality; i++) {
    quality = qualityHintFromEntry(videos[i]);
  }

  return {
    ref: { kind: "series", id: String(folderEntry.fid) },
    title,
    subtitle,
    coverURL,
    backdropURL,
    category: copy.collectionLabel,
    quality,
  };
}

export async function collectSeriesVideos(folderFid) {
  const { list } = await listFolder(folderFid, {
    page: 1,
    size: 200,
    sort: "file_name:asc",
  });
  const directVideos = list.filter(isVideoFile).sort((a, b) => naturalCompare(a.file_name, b.file_name));
  const subfolders = list.filter(isFolder).sort((a, b) => naturalCompare(a.file_name, b.file_name));

  if (directVideos.length > 0) {
    return {
      videos: directVideos.map((v) => ({ file: v, prefix: "" })),
      posterURL: pickFolderPoster(list),
      subfolders,
      rawEntries: list,
    };
  }

  // Auto-flatten 1 level of season folders (e.g. Show/Season 1/E01.mkv).
  if (subfolders.length === 0) {
    return { videos: [], posterURL: pickFolderPoster(list), subfolders: [], rawEntries: list };
  }
  const seasonSlices = await Promise.all(
    subfolders.slice(0, 8).map(async (sf) => {
      try {
        const sub = await listFolder(sf.fid, { page: 1, size: 100, sort: "file_name:asc" });
        const vids = sub.list.filter(isVideoFile).sort((a, b) => naturalCompare(a.file_name, b.file_name));
        return { folder: sf, videos: vids, entries: sub.list };
      } catch (_) {
        return { folder: sf, videos: [], entries: [] };
      }
    })
  );

  const flattened = [];
  let posterURL = pickFolderPoster(list);
  for (let i = 0; i < seasonSlices.length; i++) {
    const slice = seasonSlices[i];
    if (!posterURL) posterURL = pickFolderPoster(slice.entries);
    const prefix = decodeBasicEntities(slice.folder.file_name).trim();
    for (let j = 0; j < slice.videos.length; j++) {
      flattened.push({ file: slice.videos[j], prefix });
    }
  }
  return { videos: flattened, posterURL, subfolders, rawEntries: list };
}

function buildSegmentsFromVideos(videoEntries) {
  return videoEntries.map((entry) => {
    const baseTitle = cleanMediaTitle(entry.file.file_name) || String(entry.file.fid);
    const title = entry.prefix ? `${entry.prefix} · ${baseTitle}` : baseTitle;
    const seg = {
      title,
      partID: String(entry.file.fid),
    };
    const dur = entryDurationSeconds(entry.file);
    if (dur !== undefined) seg.durationSeconds = dur;
    return seg;
  });
}

function pushUniqueItems(target, seen, items) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || !it.ref || !it.ref.id) continue;
    const key = it.ref.kind + ":" + it.ref.id;
    if (seen[key]) continue;
    seen[key] = true;
    target.push(it);
  }
}

export async function browse(req) {
  requireSignedIn(req);
  const copy = t();
  const collection = String((req && req.collection) || "");
  const filter = String((req && req.filter) || "");
  const page = Math.max(1, parseInt(String((req && req.cursor) || "1"), 10) || 1);
  const pageSize = 30;

  if (collection === "") {
    if (page > 1) {
      const more = await listAllVideosGlobal(page, pageSize, "updated_at:desc");
      const items = more.list.map((v) => mapVideoEntry(v, null));
      const nextCursor = page * pageSize < more.total ? String(page + 1) : "";
      return {
        collections: items.length ? [{ id: "recent-videos", title: copy.recentlyUpdated, items }] : [],
        nextCursor,
      };
    }

    const [rootRes, globalRes] = await Promise.all([
      listFolder("0", { page: 1, size: 100, sort: "file_type:asc,updated_at:desc" }),
      listAllVideosGlobal(1, pageSize, "file_type:asc,updated_at:desc").catch(() => ({ list: [], total: 0 })),
    ]);

    const rootFolders = rootRes.list.filter(isFolder);
    const rootVideos = rootRes.list.filter(isVideoFile);

    // Inspect top 6 recently-updated root folders in parallel to build folder shelves & collection sections.
    const inspected = await Promise.all(
      rootFolders.slice(0, 6).map(async (folder) => {
        try {
          const child = await listFolder(folder.fid, { page: 1, size: 60, sort: "file_type:asc,updated_at:desc" });
          return { folder, entries: child.list };
        } catch (_) {
          return { folder, entries: [] };
        }
      })
    );

    const recentVideos = [];
    const seenRecent = {};
    const folderShelfItems = [];
    const seenFolders = {};
    const folderCollections = [];

    // 1. Prioritize global recent videos (/file/category?cat=video) so Hero, Picks shelf, and Grid are immediately rich.
    pushUniqueItems(
      recentVideos,
      seenRecent,
      globalRes.list.map((v) => mapVideoEntry(v, null))
    );
    pushUniqueItems(
      recentVideos,
      seenRecent,
      rootVideos.map((v) => mapVideoEntry(v, { id: "0", name: copy.driveName }))
    );

    // 2. Surface root folders as both a Folders shelf and per-folder collections (plus fallback videos if category index is empty).
    for (let i = 0; i < inspected.length; i++) {
      const { folder, entries } = inspected[i];
      const folderName = decodeBasicEntities(folder.file_name).trim() || String(folder.fid);
      const childVideos = entries.filter(isVideoFile);
      const childFolders = entries.filter(isFolder);

      if (childVideos.length === 0 && childFolders.length === 0) continue;

      const mappedChildVideos = childVideos.map((v) => mapVideoEntry(v, { id: folder.fid, name: folderName }));
      // Ensure videos inside root folders always appear in recentVideos even if /file/category lags.
      pushUniqueItems(recentVideos, seenRecent, mappedChildVideos.slice(0, 12));

      if (childFolders.length > 0 && childVideos.length <= 2) {
        // Category folder (e.g. Movies / Series / Anime): inspect subfolders and only surface
        // subfolders that actually contain playable videos (skip non-media folders like ROMs/backups).
        const subInspected = await Promise.all(
          childFolders.slice(0, 8).map(async (sf) => {
            try {
              const sub = await listFolder(sf.fid, { page: 1, size: 20, sort: "file_name:asc" });
              return { folder: sf, entries: sub.list };
            } catch (_) {
              return { folder: sf, entries: [] };
            }
          })
        );
        const sectionItems = [];
        for (let j = 0; j < childVideos.length; j++) {
          sectionItems.push(mappedChildVideos[j]);
        }
        for (let j = 0; j < subInspected.length && sectionItems.length < 24; j++) {
          const { folder: sf, entries: subEntries } = subInspected[j];
          if (!subEntries.some(isVideoFile)) continue;
          const card = mapFolderAsSeries(sf, subEntries);
          sectionItems.push(card);
          pushUniqueItems(folderShelfItems, seenFolders, [card]);
        }
        if (sectionItems.length > 0) {
          folderCollections.push({ id: "folder-" + folder.fid, title: folderName, items: sectionItems });
        }
      } else if (childVideos.length > 0) {
        // Folder containing multiple playable videos (e.g. "来自：分享"): expose as a collection card on Folders shelf
        // AND as a dedicated browsable section in Home collections so every episode is directly visible.
        const seriesCard = mapFolderAsSeries(folder, entries);
        pushUniqueItems(folderShelfItems, seenFolders, [seriesCard]);
        const sectionItems = mappedChildVideos.slice(0, 24);
        if (childFolders.length > 0 && sectionItems.length < 24) {
          const subInspected = await Promise.all(
            childFolders.slice(0, 6).map(async (sf) => {
              try {
                const sub = await listFolder(sf.fid, { page: 1, size: 12, sort: "file_name:asc" });
                return { folder: sf, entries: sub.list };
              } catch (_) {
                return { folder: sf, entries: [] };
              }
            })
          );
          for (let j = 0; j < subInspected.length && sectionItems.length < 24; j++) {
            const { folder: sf, entries: subEntries } = subInspected[j];
            if (!subEntries.some(isVideoFile)) continue;
            sectionItems.push(mapFolderAsSeries(sf, subEntries));
          }
        }
        folderCollections.push({ id: "folder-" + folder.fid, title: folderName, items: sectionItems });
      }
    }

    const collections = [];
    if (recentVideos.length > 0) {
      collections.push({
        id: "recent-videos",
        title: copy.recentlyUpdated,
        items: recentVideos.slice(0, 24),
      });
    }
    for (let i = 0; i < folderCollections.length; i++) {
      collections.push(folderCollections[i]);
    }
    const shelves = [];
    if (folderShelfItems.length > 0) {
      shelves.push({
        id: "folders",
        title: copy.folderLabel,
        items: folderShelfItems.slice(0, 20),
      });
    }
    const nextCursor = pageSize < globalRes.total ? "2" : "";
    return { collections, shelves, nextCursor };
  }

  if (collection === "regions") {
    const rootRes = await listFolder("0", { page: 1, size: 100, sort: "file_type:asc,updated_at:desc" });
    const rootFolders = rootRes.list.filter(isFolder);
    const filters = [{ id: "all", title: copy.allVideos }];
    let activeTitle = copy.allVideos;
    for (let i = 0; i < rootFolders.length; i++) {
      const f = rootFolders[i];
      const name = decodeBasicEntities(f.file_name).trim() || String(f.fid);
      filters.push({ id: String(f.fid), title: name });
      if (filter && String(f.fid) === filter) activeTitle = name;
    }

    if (!filter || filter === "all") {
      const globalRes = await listAllVideosGlobal(page, pageSize, "updated_at:desc");
      const items = globalRes.list.map((v) => mapVideoEntry(v, null));
      const nextCursor = page * pageSize < globalRes.total ? String(page + 1) : "";
      return {
        filters,
        collections: items.length ? [{ id: "all", title: copy.allVideos, items }] : [],
        nextCursor,
      };
    }

    const folderRes = await listFolder(filter, {
      page,
      size: pageSize,
      sort: "file_type:asc,file_name:asc",
    });
    const subFolders = folderRes.list.filter(isFolder);
    const videos = folderRes.list.filter(isVideoFile);
    const items = [];
    for (let i = 0; i < subFolders.length; i++) {
      items.push(mapFolderAsSeries(subFolders[i], []));
    }
    for (let i = 0; i < videos.length; i++) {
      items.push(mapVideoEntry(videos[i], { id: filter, name: activeTitle }));
    }
    const nextCursor = page * pageSize < folderRes.total ? String(page + 1) : "";
    return {
      filters,
      collections: items.length ? [{ id: "folder-" + filter, title: activeTitle, items }] : [],
      nextCursor,
    };
  }

  // Popular / Ranking tabs -> largest (highest bitrate / 4K) videos across the drive.
  const sort = collection === "ranking" ? "file_size:desc" : "updated_at:desc";
  const title = collection === "ranking" ? copy.largestVideos : copy.recentlyUpdated;
  const globalRes = await listAllVideosGlobal(page, pageSize, sort);
  const items = globalRes.list.map((v) => mapVideoEntry(v, null));
  const nextCursor = page * pageSize < globalRes.total ? String(page + 1) : "";
  return {
    collections: items.length ? [{ id: collection, title, items }] : [],
    nextCursor,
  };
}

export async function getItem(req) {
  requireSignedIn(req);
  const copy = t();
  const kind = String((req && req.kind) || "video");
  const id = String((req && req.id) || "").trim();
  if (!id) throw { code: "plugin", message: "Missing item id." };

  if (kind === "series") {
    const [info, collected] = await Promise.all([
      getFileInfo(id).catch(() => null),
      collectSeriesVideos(id),
    ]);
    const folderName =
      decodeBasicEntities((info && info.file_name) || "").trim() ||
      (collected.videos[0] && cleanMediaTitle(collected.videos[0].file.file_name)) ||
      id;
    const segments = buildSegmentsFromVideos(collected.videos);
    const related = collected.subfolders
      .filter((sf) => collected.videos.length > 0)
      .slice(0, 12)
      .map((sf) => mapFolderAsSeries(sf, []));

    let quality = "";
    for (let i = 0; i < collected.videos.length && !quality; i++) {
      quality = qualityHintFromEntry(collected.videos[i].file);
    }
    const publishedAt = entryUpdatedUnix(info || (collected.videos[0] && collected.videos[0].file));

    return {
      ref: { kind: "series", id },
      title: folderName,
      subtitle: segments.length > 0 ? copy.episodeCount(segments.length) : copy.folderLabel,
      coverURL: collected.posterURL || entryCoverURL(info),
      backdropURL: collected.posterURL || entryCoverURL(info),
      category: copy.collectionLabel,
      quality,
      videoDetails: {
        publishedAt,
        access: "granted",
        segments,
        segmentKind: segments.length > 0 ? "parts" : "",
        related,
      },
    };
  }

  // Single video item.
  const info = await getFileInfo(id);
  if (!info || !info.fid) {
    throw { code: "plugin", message: "Video not found in Quark Drive." };
  }
  const parentFid = String(info.pdir_fid || "0");
  let folderName = copy.driveName;
  let siblingVideos = [];
  if (parentFid && parentFid !== "0") {
    const [parentInfo, siblingsRes] = await Promise.all([
      getFileInfo(parentFid).catch(() => null),
      listFolder(parentFid, { page: 1, size: 100, sort: "file_name:asc" }).catch(() => ({ list: [] })),
    ]);
    if (parentInfo && parentInfo.file_name) {
      folderName = decodeBasicEntities(parentInfo.file_name).trim() || copy.driveName;
    }
    siblingVideos = siblingsRes.list.filter(isVideoFile).sort((a, b) => naturalCompare(a.file_name, b.file_name));
  }

  const mapped = mapVideoEntry(info, { id: parentFid, name: folderName });
  const related = siblingVideos
    .filter((v) => String(v.fid) !== id)
    .slice(0, 12)
    .map((v) => mapVideoEntry(v, { id: parentFid, name: folderName }));

  mapped.videoDetails = {
    publishedAt: entryUpdatedUnix(info),
    access: "granted",
    related,
  };
  return mapped;
}

export async function search(req) {
  requireSignedIn(req);
  const query = String((req && req.query) || "").trim();
  const kind = String((req && req.kind) || "all");
  const page = Math.max(1, parseInt(String((req && req.cursor) || "1"), 10) || 1);
  const pageSize = 30;

  if (!query) {
    return { items: [], kinds: ["all", "video", "series"] };
  }

  let sort = "file_type:desc,updated_at:desc";
  if (req && req.sort === "newest") sort = "updated_at:desc";
  else if (req && req.sort === "views") sort = "file_size:desc";

  const res = await searchDrive(query, page, pageSize, sort);
  const items = [];
  for (let i = 0; i < res.list.length; i++) {
    const entry = res.list[i];
    if (isFolder(entry)) {
      if (kind === "video") continue;
      items.push(mapFolderAsSeries(entry, []));
    } else if (isVideoFile(entry)) {
      if (kind === "series") continue;
      items.push(mapVideoEntry(entry, null));
    }
  }
  const nextCursor = page * pageSize < res.total ? String(page + 1) : "";
  return {
    items,
    total: res.total,
    nextCursor,
    kinds: ["all", "video", "series"],
  };
}

export async function readAccount(req) {
  requireSignedIn(req);
  const section = String((req && req.section) || "");
  if (section !== "history") {
    return { rows: [] };
  }
  const entries = getHistoryItems();
  const rows = entries.map((h) => {
    const ref = { kind: h.kind === "series" ? "series" : "video", id: h.id };
    const media = {
      ref,
      title: h.title || h.id,
      subtitle: h.subtitle || "",
      coverURL: h.coverURL || "",
      backdropURL: h.coverURL || "",
    };
    if (h.duration > 0) media.durationSeconds = h.duration;
    if (h.seconds > 0) media.progressSeconds = h.seconds;
    const row = {
      id: h.id,
      title: media.title,
      subtitle: media.subtitle,
      coverURL: media.coverURL,
      ref,
      item: media,
      finished: Boolean(h.finished),
    };
    if (h.duration > 0) row.durationSeconds = h.duration;
    if (h.seconds > 0) row.progressSeconds = h.seconds;
    if (h.time > 0) row.time = h.time;
    return row;
  });
  return { rows, total: rows.length };
}
