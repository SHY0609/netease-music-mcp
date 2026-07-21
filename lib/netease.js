import crypto from "node:crypto";

// 读操作走 Docker（绕过 CDN），写操作走 eapi/weapi 直连
const DOCKER_API = "http://127.0.0.1:3939";

const IV = Buffer.from("0102030405060708", "utf8");
const PRESET_KEY = Buffer.from("0CoJUm6Qyw8W8jud", "utf8");
const RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

/** AES-128-CBC encrypt, output base64 */
function aesEncrypt(buffer, key, iv) {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(true);
  const buf = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return buf.toString("base64");
}

/** RSA encrypt (hex) – key reversed before encrypt */
function rsaEncrypt(secKey) {
  const reversed = Buffer.from(secKey.split("").reverse().join(""));
  const buf = crypto.publicEncrypt({ key: RSA_KEY, padding: crypto.constants.RSA_PKCS1_PADDING }, reversed);
  return buf.toString("hex");
}

/** Build weapi params for POST body */
export function weapi(data) {
  const json = JSON.stringify(data);
  const secKey = crypto.randomBytes(16).toString("hex").slice(0, 16);
  const first = aesEncrypt(Buffer.from(json, "utf8"), PRESET_KEY, IV);
  const second = aesEncrypt(Buffer.from(first, "utf8"), Buffer.from(secKey, "utf8"), IV);
  return new URLSearchParams({ params: second, encSecKey: rsaEncrypt(secKey) }).toString();
}

/** Common weapi POST */
async function weapiPost(path, data, cookie) {
  const body = weapi(data);
  const res = await fetch(`https://music.163.com/weapi${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookie || "",
      referer: "https://music.163.com/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    body,
  });
  const raw = await res.text();
  try { return JSON.parse(raw); } catch { throw new Error(`API ${path}: ${raw.slice(0, 200)}`); }
}

// ── eapi 加密（一起听/切歌等写操作） ──
const EAPI_KEY = Buffer.from("e82ckenh8dichen8", "utf8");

/** eapi 加密原语：MD5 → 格式化 → AES-128-ECB → uppercase hex */
export function eapiEncrypt(path, jsonStr) {
  const msg = `nobody${path}use${jsonStr}md5forencrypt`;
  const digest = crypto.createHash("md5").update(msg, "utf8").digest("hex");
  const data = `${path}-36cd479b6b5-${jsonStr}-36cd479b6b5-${digest}`;
  const cipher = crypto.createCipheriv("aes-128-ecb", EAPI_KEY, null);
  cipher.setAutoPadding(true);
  const buf = Buffer.concat([cipher.update(Buffer.from(data, "utf8")), cipher.final()]);
  return buf.toString("hex").toUpperCase();
}

/** 构建 eapi 请求所需的设备信息 Cookie（模拟 iPhone 客户端） */
function deviceCookie() {
  return "osver=16.2; deviceId=ACDE3DF64CFE5DD5FA8E392FB1C28888923F82011B4775A226BB; os=iPhone%20OS; appver=9.0.90; versioncode=140; buildver=1784467000; resolution=1920x1080; channel=distribution";
}

/** eapi POST（interface.music.163.com） */
export async function eapiPost(path, data, cookie, extraCookie) {
  const json = JSON.stringify(data);
  const params = eapiEncrypt(path, json);
  const parts = [];
  if (extraCookie !== false) parts.push(deviceCookie());
  if (cookie) parts.push(cookie);
  const fullCookie = parts.join("; ");
  const res = await fetch(`https://interface.music.163.com/eapi${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: fullCookie,
      referer: "https://music.163.com/",
    },
    body: new URLSearchParams({ params }).toString(),
  });
  const raw = await res.text();
  try { return JSON.parse(raw); } catch { throw new Error(`eapi ${path}: ${raw.slice(0, 200)}`); }
}

// ── Docker proxy (读操作，绕过 CDN) ──
const DOCKER = "http://127.0.0.1:3939";
async function dockerGet(path, cookie) {
  const headers = { "user-agent": "Mozilla/5.0" };
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${DOCKER}${path}`, { headers });
  const raw = await res.text();
  try { return JSON.parse(raw); } catch { throw new Error(`Docker ${path}: ${raw.slice(0, 200)}`); }
}

// ── public helpers ──

/** Get your playlists */
export async function getUserPlaylists(cookie) {
  // Get user ID from login status
  const login = await dockerGet(`/login/status`, cookie);
  const uid = login?.data?.profile?.userId || "";
  const data = await dockerGet(`/user/playlist?uid=${uid}&limit=100`, cookie);
  if (data.code !== 200) throw new Error(`getUserPlaylists: code=${data.code}`);
  return (data.playlist || []).map(p => ({ id: String(p.id), name: p.name, trackCount: p.trackCount, coverUrl: p.coverImgUrl || "" }));
}

/** Search songs */
export async function searchSongs(keyword, cookie, limit = 8) {
  const data = await dockerGet(`/search?keywords=${encodeURIComponent(keyword)}&type=1&limit=${limit}&offset=0`);
  if (data.code !== 200) throw new Error(`searchSongs: code=${data.code}`);
  return (data.result?.songs || []).map(s => ({ id: String(s.id), name: s.name, artist: (s.artists || s.ar || []).map(a => a.name).join(" / "), album: (s.album || s.al || {}).name || "", coverUrl: (s.album || s.al || {}).picUrl || "", durationMs: s.duration || s.dt || 0 }));
}

/** Get song detail */
export async function getSongDetail(id, cookie) {
  const data = await dockerGet(`/song/detail?ids=${id}`);
  if (data.code !== 200) throw new Error(`getSongDetail: code=${data.code}`);
  const s = data.songs?.[0];
  if (!s) throw new Error("song not found");
  return { id: String(s.id), name: s.name, artist: (s.ar || []).map(a => a.name).join(" / "), album: (s.al || {}).name || "", coverUrl: (s.al || {}).picUrl || "", durationMs: s.dt || 0 };
}

/** Get lyrics */
export async function getLyrics(id, cookie) {
  const data = await dockerGet(`/lyric?id=${id}`);
  if (data.code !== 200) return "";
  return (data.lrc?.lyric || "") + "\n" + (data.tlyric?.lyric || "");
}

/** Get playlist detail (tracks) */
export async function getPlaylistDetail(id, cookie, limit = 100) {
  const data = await dockerGet(`/playlist/detail?id=${id}`, cookie);
  if (data.code !== 200) throw new Error(`getPlaylistDetail: code=${data.code}`);
  const tracks = (data.playlist?.tracks || []).map(s => ({ id: String(s.id), name: s.name, artist: (s.ar || []).map(a => a.name).join(" / "), album: (s.al || {}).name || "", coverUrl: (s.al || {}).picUrl || "", durationMs: s.dt || 0 }));
  return { name: data.playlist?.name || "", tracks };
}

/** Add tracks to playlist */
export async function addToPlaylist(playlistId, trackIds, cookie) {
  const data = await dockerGet(`/playlist/tracks?op=add&pid=${playlistId}&tracks=${trackIds.map(String).join(",")}`, cookie);
  if (data.code !== 200) throw new Error(`addToPlaylist: code=${data.code}`);
  return true;
}

/** Get playlist tracks */
export async function getPlaylistTracks(id, cookie, offset = 0, limit = 50) {
  const data = await dockerGet(`/playlist/track/all?id=${id}&limit=${limit}&offset=${offset * limit}`, cookie);
  if (data.code !== 200) throw new Error(`getPlaylistTracks: code=${data.code}`);
  return (data.songs || []).map(t => String(t.id));
}

// ── weapi with os=pc (for private messages) ──
async function weapiPc(path, data, cookie) {
  const body = weapi(data);
  const res = await fetch(`https://music.163.com/weapi${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: "os=pc; " + (cookie || ""),
      referer: "https://music.163.com/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    body,
  });
  const raw = await res.text();
  try { return JSON.parse(raw); } catch { throw new Error(`weapi ${path}: ${raw.slice(0, 200)}`); }
}

// ── 一起听（Listen Together）──

/** Accept a listen-together invitation. Returns room info. */
export async function acceptListenTogether(roomId, inviterId, listenTogetherRefer, cookie) {
  const data = await eapiPost("/api/listen/together/play/invitation/accept", {
    roomId: String(roomId),
    inviterId: String(inviterId),
    listenTogetherRefer: listenTogetherRefer || 1,
    header: "{}",
  }, cookie);
  if (data.code !== 200) throw new Error(`acceptListenTogether: code=${data.code} msg=${data.msg || ""}`);
  return data;
}

/** End/leave a listen-together session. */
export async function endListenTogether(roomId, cookie) {
  const data = await eapiPost("/api/listen/together/end/v2", {
    roomId: String(roomId),
    header: "{}",
  }, cookie);
  if (data.code !== 200) throw new Error(`endListenTogether: code=${data.code}`);
  return data;
}

/** Send heartbeat to keep listen-together room alive. code=404 is normal. */
export async function listenTogetherHeartbeat(roomId, songId, playStatus, progress, cookie) {
  const data = await eapiPost("/api/listen/together/heartbeat", {
    roomId: String(roomId),
    songId: String(songId || "0"),
    playStatus: playStatus || "playing",
    progress: String(progress || "0"),
    header: "{}",
  }, cookie);
  // Heartbeat returns code=404 even on success — this is expected
  return data;
}

/** Get listen-together room status and playlist. */
export async function listenTogetherStatus(roomId, cookie) {
  return eapiPost("/api/listen/together/sync/playlist/get", {
    roomId: String(roomId),
    header: "{}",
  }, cookie);
}

/** Play command report — switch song in listen-together room (real-time). */
export async function playCommandReport(roomId, songId, progress, playStatus, cookie) {
  const data = await eapiPost("/api/listen/together/play/command/report", {
    roomId: String(roomId),
    commandInfo: JSON.stringify({ type: "GOTO", targetSongId: String(songId), progress: String(progress || "0"), playStatus: playStatus || "playing" }),
    header: "{}",
  }, cookie);
  if (data.code !== 200) throw new Error(`playCommandReport: code=${data.code}`);
  return data;
}

/** Add songs to listen-together playlist. */
export async function addSongToList(roomId, songIds, cookie, position = 0) {
  const playlistParam = {
    songIds: songIds.map(String),
    position,
    type: "ADD",
  };
  const data = await eapiPost("/api/listen/together/sync/list/command/report", {
    roomId: String(roomId),
    playlistParam: JSON.stringify(playlistParam),
    header: "{}",
  }, cookie);
  if (data.code !== 200) throw new Error(`addSongToList: code=${data.code}`);
  return data;
}

// ── 私信（Docker 代理，绕过 CDN）──

/** Send a private message to a user. */
export async function sendPrivateMessage(userIds, msg, type, cookie) {
  const uid = Array.isArray(userIds) ? userIds[0] : userIds;
  const data = await dockerGet(`/send/text?user_ids=${uid}&msg=${encodeURIComponent(msg)}`, cookie);
  if (data.code !== 200) throw new Error(`sendPrivateMessage: code=${data.code} msg=${data.msg || ""}`);
  return data;
}

/** Get recent private message contact list. */
export async function getPrivateList(cookie) {
  return dockerGet(`/msg/recentcontact`, cookie);
}

/** Get private message history with a specific user. */
export async function getPrivateMessages(userId, cookie, limit) {
  return dockerGet(`/msg/private/history?uid=${userId}&limit=${limit || 20}&before=0`, cookie);
}
