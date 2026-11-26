// Official Quark Web CAS QR-code sign-in, session restoration, and cookie normalization.

import {
  DRIVE_API_BASE,
  PC_UA,
  QUARK_ORIGIN,
  QUARK_REFERER,
  WEB_UA,
  fetchMemberInfo,
  formatBytes,
  normalizeHTTPS,
  qs,
} from "./api.js";
import { cacheClearAll } from "./cache.js";
import { t } from "./i18n.js";

const CAS_BASE = "https://uop.quark.cn/cas/ajax";
const QR_PAGE_BASE = "https://su.quark.cn/4_eMHBJ";
const ACCOUNT_INFO_URL = "https://pan.quark.cn/account/info";
const ACCOUNT_LOGOUT_URL = "https://pan.quark.cn/account/logout";
const FLUSH_URL = `${DRIVE_API_BASE}/auth/pc/flush?pr=ucpro&fr=pc&uc_param_str=`;
const CLIENT_ID = "532";

function generateRequestID() {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  const now = Date.now().toString(16).padStart(12, "0").slice(-12);
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${((8 + Math.floor(Math.random() * 4)).toString(16))}${hex().slice(1)}-${now}`;
}

function collectSetCookies(cookieMap, response) {
  if (!response || !response.headers || typeof response.headers.getSetCookie !== "function") {
    return;
  }
  const headers = response.headers.getSetCookie();
  for (let i = 0; i < headers.length; i++) {
    const raw = String(headers[i] || "").trim();
    if (!raw) continue;
    const parts = raw.split(";");
    const pair = parts[0] || "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || !value) continue;
    // Normalize Domain=.quark.cn so Go's cookiejar forwards auth cookies
    // seamlessly across pan.quark.cn, drive-pc.quark.cn, and download CDNs.
    const attrs = [];
    let hasDomain = false;
    let hasPath = false;
    let hasSecure = false;
    for (let j = 1; j < parts.length; j++) {
      const seg = parts[j].trim();
      if (!seg) continue;
      const lower = seg.toLowerCase();
      if (lower.startsWith("domain=")) {
        const d = seg.slice(7).trim().toLowerCase();
        if (d === "quark.cn" || d.endsWith(".quark.cn")) {
          attrs.push("Domain=.quark.cn");
          hasDomain = true;
        }
        continue;
      }
      if (lower.startsWith("path=")) {
        attrs.push("Path=/");
        hasPath = true;
        continue;
      }
      if (lower === "secure") {
        attrs.push("Secure");
        hasSecure = true;
        continue;
      }
      if (lower === "httponly" || lower.startsWith("max-age=") || lower.startsWith("expires=")) {
        attrs.push(seg);
      }
    }
    if (!hasDomain) attrs.push("Domain=.quark.cn");
    if (!hasPath) attrs.push("Path=/");
    if (!hasSecure) attrs.push("Secure");
    cookieMap[name] = `${name}=${value}; ${attrs.join("; ")}`;
  }
}

function cookieHeadersFromMap(cookieMap) {
  return Object.keys(cookieMap).map((k) => cookieMap[k]);
}

async function casGet(url) {
  let resp;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: QUARK_REFERER,
        "User-Agent": WEB_UA,
      },
    });
  } catch (err) {
    throw { code: "network", message: String((err && err.message) || err || "network error") };
  }
  if (resp.status === 429) throw { code: "rateLimited" };
  if (!resp.ok) throw { code: "network", message: `Quark CAS HTTP ${resp.status}` };
  let body;
  try {
    body = await resp.json();
  } catch (_) {
    throw { code: "plugin", message: "Invalid JSON from Quark CAS" };
  }
  return { body, response: resp };
}

function buildAccountObject(accountData, memberData, fallback) {
  const copy = t();
  const info = accountData || {};
  const fb = fallback || {};
  const rawId = info.uid || info.kps || info.mobilekps || info.nickname || fb.uid || "";
  const id = String(rawId || "quark-user");
  const name = String(info.nickname || info.username || fb.name || copy.driveName).trim() || copy.driveName;
  const avatarURL = normalizeHTTPS(info.avatarUri || info.avatar_uri || info.avatar || fb.avatarURL || "");

  const memberType = String((memberData && memberData.member_type) || "").toUpperCase();
  const isSVIP = memberType.includes("SVIP") || memberType.includes("EXP_SVIP");
  const isVIP = isSVIP || memberType.includes("VIP");
  const used = Number((memberData && memberData.use_capacity) || 0);
  const total = Number((memberData && memberData.total_capacity) || 0);
  const quotaText = total > 0 ? copy.storageQuota(formatBytes(used), formatBytes(total)) : copy.connected;

  const badgeText = isSVIP ? copy.svipBadge : isVIP ? copy.vipBadge : copy.normalBadge;
  const account = {
    id,
    name,
    badge: { text: badgeText, icon: isVIP ? "sparkles" : "user" },
    card: {
      title: copy.driveName,
      description: copy.driveDesc,
      icon: isVIP ? "sparkles" : "play",
      status: quotaText,
      highlight: isVIP,
      benefits: [copy.benefitQR, copy.benefitStream, copy.benefitSubtitles, copy.benefitResume],
    },
  };
  if (avatarURL) account.avatarURL = avatarURL;
  return account;
}

async function fetchAccountSnapshot(cookieMap, serviceTicket) {
  const infoURL = serviceTicket
    ? ACCOUNT_INFO_URL + qs({ st: serviceTicket, lw: "scan" })
    : ACCOUNT_INFO_URL + qs({ fr: "pc", platform: "pc" });

  let infoResp;
  try {
    infoResp = await fetch(infoURL, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: QUARK_REFERER,
        "User-Agent": WEB_UA,
      },
    });
  } catch (err) {
    throw { code: "network", message: String((err && err.message) || err || "account info failed") };
  }
  collectSetCookies(cookieMap, infoResp);
  if (infoResp.status === 401 || infoResp.status === 403) {
    throw { code: "signIn", message: "Quark Drive session expired." };
  }
  if (!infoResp.ok) {
    throw { code: "network", message: `Quark account info HTTP ${infoResp.status}` };
  }
  let infoBody;
  try {
    infoBody = await infoResp.json();
  } catch (_) {
    throw { code: "plugin", message: "Invalid JSON from Quark account info" };
  }
  const accountData = infoBody && infoBody.data;
  if (!accountData || (!accountData.nickname && !accountData.uid && !accountData.kps)) {
    throw { code: "signIn", message: "Quark Drive sign-in required." };
  }

  // Flush PC drive cookies (__puus) required by drive-pc.quark.cn & CDN downloads.
  try {
    const flushResp = await fetch(FLUSH_URL, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Origin: QUARK_ORIGIN,
        Referer: QUARK_REFERER,
        "User-Agent": PC_UA,
      },
    });
    collectSetCookies(cookieMap, flushResp);
  } catch (_) {}

  let memberData = null;
  try {
    const { data, response } = await fetchMemberInfo();
    memberData = data;
    collectSetCookies(cookieMap, response);
  } catch (err) {
    if (err && err.code === "signIn") throw err;
  }

  return { accountData, memberData };
}

export async function beginSignIn() {
  const requestId = generateRequestID();
  const { body } = await casGet(
    `${CAS_BASE}/getTokenForQrcodeLogin` + qs({ client_id: CLIENT_ID, v: "1.2", request_id: requestId })
  );
  const token = body && body.data && body.data.members && body.data.members.token;
  if (Number(body && body.status) !== 2000000 || !token) {
    throw { code: "plugin", message: String((body && body.message) || "Failed to initialize Quark QR login.") };
  }
  const qrURL =
    QR_PAGE_BASE +
    qs({
      token,
      client_id: CLIENT_ID,
      ssb: "weblogin",
      uc_param_str: "",
      uc_biz_str: "S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0",
    });
  return {
    url: qrURL,
    key: JSON.stringify({ token, requestId }),
    expiresAt: Date.now() + 180_000,
  };
}

export async function pollSignIn(req) {
  let token = "";
  let requestId = "";
  try {
    const parsed = JSON.parse(String((req && req.key) || ""));
    token = String(parsed.token || "");
    requestId = String(parsed.requestId || "");
  } catch (_) {
    token = String((req && req.key) || "");
    requestId = generateRequestID();
  }
  if (!token) throw { code: "plugin", message: "Missing QR login token." };

  const cookieMap = {};
  const { body, response } = await casGet(
    `${CAS_BASE}/getServiceTicketByQrcodeToken` +
      qs({ client_id: CLIENT_ID, v: "1.2", request_id: generateRequestID(), token })
  );
  collectSetCookies(cookieMap, response);

  const status = Number((body && body.status) || 0);
  const msg = String((body && body.message) || "").toLowerCase();
  const ticket = body && body.data && body.data.members && body.data.members.service_ticket;

  if (status === 2000000 && ticket) {
    const { accountData, memberData } = await fetchAccountSnapshot(cookieMap, ticket);
    const headers = cookieHeadersFromMap(cookieMap);
    if (headers.length === 0) {
      throw { code: "signIn", message: "No session cookies returned by Quark Drive." };
    }
    const account = buildAccountObject(accountData, memberData, null);
    return {
      status: "approved",
      account,
      secret: {
        uid: account.id,
        name: account.name,
        avatarURL: account.avatarURL || "",
      },
      cookies: [{ url: QUARK_ORIGIN, headers }],
    };
  }

  if (status === 50004001) {
    return { status: "waiting" };
  }
  if (status === 50004005 || msg.includes("scan")) {
    return { status: "scanned" };
  }
  if (
    status === 50004002 ||
    status === 50004003 ||
    status === 50004004 ||
    msg.includes("expired") ||
    msg.includes("timeout") ||
    msg.includes("invalid")
  ) {
    return { status: "expired" };
  }
  return { status: "waiting" };
}

export async function restoreAccount(secret) {
  const cookieMap = {};
  const { accountData, memberData } = await fetchAccountSnapshot(cookieMap, "");
  const account = buildAccountObject(accountData, memberData, secret);
  const nextSecret = {
    uid: account.id,
    name: account.name,
    avatarURL: account.avatarURL || "",
  };
  const out = { account, secret: nextSecret };
  // MikuTV replaces the entire stored cookie jar when out.cookies is returned.
  // Only replace stored cookies if the server issued a fresh primary __pus cookie;
  // otherwise omit out.cookies so Keychain retains __pus alongside refreshed __puus.
  if (cookieMap.__pus) {
    const headers = cookieHeadersFromMap(cookieMap);
    if (headers.length > 0) {
      out.cookies = [{ url: QUARK_ORIGIN, headers }];
    }
  }
  return out;
}

export async function signOut() {
  cacheClearAll();
  try {
    await fetch(ACCOUNT_LOGOUT_URL, {
      method: "GET",
      headers: {
        Referer: QUARK_REFERER,
        "User-Agent": WEB_UA,
      },
    });
  } catch (_) {}
  return {};
}
