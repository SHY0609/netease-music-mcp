import crypto from "node:crypto";

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
    },
    body,
  });
  const raw = await res.text();
  try { return JSON.parse(raw); } catch { throw new Error(`API ${path}: ${raw.slice(0, 200)}`); }
}

/** eapi POST (for some newer endpoints) */
async function eapiPost(path, data, cookie) {
  const json = JSON.stringify(data);
  const secKey = "e82ckenh8dichen8";
  const enc = aesEncrypt(
    Buffer.from(`nobody${path}use${json}md5forencrypt`, "utf8"),
    Buffer.from(secKey, "utf8"),
    Buffer.from(secKey.slice(0, 16), "utf8")
  );
  const body = new URLSearchParams({ params: enc }).toString();
  const res = await fetch(`https://music.163.com/eapi${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookie || "",
      referer: "https://music.163.com/",
    },
    body,
  });
  return res.json();
}

// ── public helpers ──

/** Get your playlists */
export async function getUserPlaylists(cookie) {
  const data = await weapiPost("/user/playlist", { uid: "", limit: 100, offset: 0, includeVideo: true }, cookie);
  if (data.code !== 200) throw new Error(`getUserPlaylists: code=${data.code} msg=${data.msg}`);
  return (data.playlist || []).map(p => ({
    id: String(p.id), name: p.name, trackCount: p.trackCount, coverUrl: p.coverImgUrl || "",
  }));
}

/** Search songs */
export async function searchSongs(keyword, cookie, limit = 8) {
  const data = await weapiPost("/cloudsearch/get/web", { s: keyword, type: 1, limit, offset: 0 }, cookie);
  if (data.code !== 200) throw new Error(`searchSongs: code=${data.code} msg=${data.msg}`);
  const songs = data.result?.songs || [];
  return songs.map(s => ({
    id: String(s.id),
    name: s.name,
    artist: (s.ar || []).map(a => a.name).join(" / "),
    album: (s.al || {}).name || "",
    coverUrl: (s.al || {}).picUrl || "",
    durationMs: s.dt || 0,
  }));
}

/** Get playable URL (highest quality available) */
export async function getSongUrl(id, cookie, level = "exhigh") {
  const map = { standard: "standard", higher: "higher", exhigh: "exhigh", lossless: "lossless", hires: "hires" };
  const data = await weapiPost("/song/enhance/player/url/v1", {
    ids: `[${id}]`, level: map[level] || "exhigh", encodeType: "mp3",
  }, cookie);
  if (data.code !== 200) throw new Error(`getSongUrl: code=${data.code}`);
  const item = (data.data || []).find(d => String(d.id) === String(id));
  return item?.url || data.data?.[0]?.url || "";
}

/** Get song detail (cover, album, duration) */
export async function getSongDetail(id, cookie) {
  const data = await weapiPost("/v3/song/detail", { c: `[{"id":${id}}]` }, cookie);
  if (data.code !== 200) throw new Error(`getSongDetail: code=${data.code}`);
  const s = data.songs?.[0];
  if (!s) throw new Error("song not found");
  return {
    id: String(s.id), name: s.name,
    artist: (s.ar || []).map(a => a.name).join(" / "),
    album: (s.al || {}).name || "", coverUrl: (s.al || {}).picUrl || "",
    durationMs: s.dt || 0,
  };
}

/** Get lyrics */
export async function getLyrics(id, cookie) {
  const data = await weapiPost("/song/lyric", { id: String(id), lv: 1, tv: 1 }, cookie);
  if (data.code !== 200) return "";
  return data.lrc?.lyric || "";
}

/** Get playlist detail (tracks) */
export async function getPlaylistDetail(id, cookie, limit = 100) {
  const data = await weapiPost("/v6/playlist/detail", { id: String(id), n: limit, s: 0 }, cookie);
  if (data.code !== 200) throw new Error(`getPlaylistDetail: code=${data.code}`);
  const tracks = (data.playlist?.tracks || []).map(s => ({
    id: String(s.id), name: s.name,
    artist: (s.ar || []).map(a => a.name).join(" / "),
    album: (s.al || {}).name || "", coverUrl: (s.al || {}).picUrl || "",
    durationMs: s.dt || 0,
  }));
  return { name: data.playlist?.name || "", tracks };
}

/** Add tracks to playlist (id is playlist id, trackIds is array of song ids) */
export async function addToPlaylist(playlistId, trackIds, cookie) {
  const data = await weapiPost("/playlist/manipulate/tracks", {
    op: "add", pid: String(playlistId),
    trackIds: `[${trackIds.map(String).join(",")}]`,
  }, cookie);
  if (data.code !== 200) throw new Error(`addToPlaylist: code=${data.code} msg=${data.msg || data.message}`);
  return true;
}

/** Get playlist tracks — for reading what's in a playlist */
export async function getPlaylistTracks(id, cookie, offset = 0, limit = 50) {
  const data = await weapiPost("/v6/playlist/detail", { id: String(id), n: limit, s: offset * limit }, cookie);
  if (data.code !== 200) throw new Error(`getPlaylistTracks: code=${data.code}`);
  return (data.playlist?.trackIds || []).map(t => String(t.id));
}
