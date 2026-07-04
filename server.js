/**
 * server.js — 全功能 MCP Server（本地运行 / Koyeb 部署）
 *
 * 🎵 网易云音乐（weapi — VIP歌曲全通）
 * 🍔 美团外卖（搜索/地址/菜单/下单）
 * 🛒 淘宝（搜索商品/详情/发链接）
 *
 * 用法: node server.js
 * 端口: process.env.PORT || 3000
 */
import http from "node:http";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { weapi } from "./lib/netease.js";
import { tbSearch, tbDetail } from "./lib/taobao.js";

const require = createRequire(import.meta.url);
const { getMtgsig, init: initSigner } = require("./lib/mt-signer-v2.cjs");

const COOKIE = process.env.NETEASE_COOKIE || "";
const MT_COOKIE = process.env.MEITUAN_COOKIE || "";
const TB_COOKIE = process.env.TAOBAO_COOKIE || "";
const PORT = process.env.PORT || 3000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const OB_URL = "http://127.0.0.1:18001/mcp";  // Ombre-Brain 记忆库

// ─── Ombre-Brain 记忆库状态 ────────────────────────────────────
let obSessionId = null;
let obReady = false;
let obMemoryTools = [];

// ─── 预初始化美团签名器 ────────────────────────────────────────
if (MT_COOKIE) {
  console.log("pre-init meituan signer, cookieLen:", MT_COOKIE.length);
  initSigner(MT_COOKIE).then(() => console.log("meituan signer ready"))
    .catch(e => console.error("meituan signer init failed:", e.message));
}

// ─── SSE 解析（Ombre-Brain streamable-http 返回 SSE 格式）─────────
function parseSSE(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data: ")) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
  }
  return null;
}

// ─── 初始化 Ombre-Brain 记忆库连接 ──────────────────────────────
async function initOmbreBrain() {
  try {
    // Step 1: MCP initialize 握手
    const initRes = await fetch(OB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 0, method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "netease-music-mcp", version: "3.0.0" }
        }
      })
    });
    if (!initRes.ok) throw new Error(`initialize failed: ${initRes.status}`);
    obSessionId = initRes.headers.get("Mcp-Session-Id") || initRes.headers.get("mcp-session-id") || "";
    const initText = await initRes.text();
    const initData = parseSSE(initText) || JSON.parse(initText);
    console.log("OB initialize:", initData.result?.serverInfo?.name || "ok", obSessionId ? "(session)" : "");

    // Step 2: initialized 通知
    await fetch(OB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(obSessionId ? { "Mcp-Session-Id": obSessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    });

    // Step 3: 获取记忆工具列表
    const toolsRes = await fetch(OB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(obSessionId ? { "Mcp-Session-Id": obSessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    const toolsText = await toolsRes.text();
    const toolsData = parseSSE(toolsText) || JSON.parse(toolsText);
    obMemoryTools = toolsData.result?.tools || [];
    obReady = true;
    console.log(`OB: ${obMemoryTools.length} memory tools loaded`);
  } catch (e) {
    console.error("OB init failed:", e.message);
    console.error("Memory tools will NOT be available. Start Ombre-Brain first.");
    obReady = false;
    obMemoryTools = [];
  }
}

// ─── 转发记忆工具调用到 Ombre-Brain ──────────────────────────────
function isMemoryTool(name) {
  return obMemoryTools.some(t => t.name === name);
}

async function forwardToOB(msg) {
  if (!obReady) return null;
  try {
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (obSessionId) headers["Mcp-Session-Id"] = obSessionId;
    const res = await fetch(OB_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(msg)
    });
    const text = await res.text();
    const result = parseSSE(text) || JSON.parse(text);
    // 会话过期 → 重新握手后重试一次
    if (result && result.error && /session/i.test(result.error.message || "")) {
      console.log("OB session expired, re-initializing...");
      await initOmbreBrain();
      if (obReady && obSessionId) {
        const headers2 = { "Content-Type": "application/json", "Accept": "application/json", "Mcp-Session-Id": obSessionId };
        const res2 = await fetch(OB_URL, { method: "POST", headers: headers2, body: JSON.stringify(msg) });
        const text2 = await res2.text();
        return parseSSE(text2) || JSON.parse(text2);
      }
    }
    return result;
  } catch (e) {
    console.error("OB forward error:", e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// 🎵 网易云音乐（weapi）
// ═══════════════════════════════════════════════════════════════

async function ncApi(path, data) {
  const body = weapi(data);
  const res = await fetch(`https://music.163.com/weapi${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: COOKIE, referer: "https://music.163.com/", "user-agent": UA },
    body,
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Netease: ${text.slice(0, 200)}`); }
}

async function searchSongs(kw, limit = 8) {
  const r = await ncApi("/cloudsearch/get/web", { s: kw, type: 1, limit, offset: 0 });
  if (r.code !== 200) throw new Error(r.message || "search failed");
  return (r.result?.songs || []).map(s => ({
    id: String(s.id), name: s.name,
    artist: (s.ar || []).map(a => a.name).join(" / "),
    album: (s.al || {}).name || "",
    coverUrl: (s.al || {}).picUrl || "",
    durationMs: s.dt || 0,
  }));
}

async function getSongUrl(id) {
  const r = await ncApi("/song/enhance/player/url/v1", { ids: `[${id}]`, level: "exhigh", encodeType: "mp3" });
  const url = r.data?.[0]?.url;
  if (url) return url.replace(/^http:\/\//, "https://");
  try {
    const r2 = await fetch(`https://music.163.com/song/media/outer/url?id=${id}`, { redirect: "manual", headers: { "user-agent": UA, referer: "https://music.163.com/" } });
    const loc = r2.headers.get("location") || "";
    if (!loc.includes("/404")) return loc.replace(/^http:\/\//, "https://");
  } catch {}
  return "";
}

async function getPlaylists() {
  const r = await ncApi("/user/playlist", { uid: "", limit: 50, offset: 0, includeVideo: true });
  return (r.playlist || []).map(p => ({ id: String(p.id), name: p.name, trackCount: p.trackCount }));
}

async function getPlaylistDetail(id) {
  const r = await ncApi("/v6/playlist/detail", { id: String(id), n: 30, s: 0 });
  const p = r.playlist || {};
  return { name: p.name || "", tracks: (p.tracks || []).map(s => ({ id: String(s.id), name: s.name, artist: (s.ar || []).map(a => a.name).join(" / ") })) };
}

async function addToPlaylist(pid, songId) {
  const r = await ncApi("/playlist/manipulate/tracks", { op: "add", pid: String(pid), trackIds: `[${songId}]` });
  if (r.code !== 200) throw new Error(r.message || r.msg || "add failed");
  return true;
}

async function getLyricsRaw(id) {
  try {
    const r = await ncApi("/song/lyric", { id: String(id), lv: 1, tv: 1 });
    return (r.lrc?.lyric || "") + "\n" + (r.tlyric?.lyric || "");
  } catch { return ""; }
}

function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const matches = [...raw.matchAll(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = raw.replace(/\[[^\]]+]/g, "").trim();
    for (const m of matches) lines.push({ time: Number(m[1]) * 60 + Number(m[2]) + (Number(m[3] || "0") || 0) / 1000, text });
  }
  return lines.filter(l => l.text).sort((a, b) => a.time - b.time);
}
function lyricsAround(lines, time, n = 4) {
  let idx = lines.findIndex(l => l.time >= time);
  if (idx < 0) idx = Math.max(0, lines.length - n);
  return { past: lines.slice(Math.max(0, idx - 1), idx).map(l => l.text), current: lines[idx]?.text || "", upcoming: lines.slice(idx + 1, idx + 1 + n).map(l => l.text) };
}
function fm(s) { const m = Math.floor((s || 0) / 60), sec = Math.floor((s || 0) % 60); return m + ":" + (sec < 10 ? "0" : "") + sec; }

// ═══════════════════════════════════════════════════════════════
// 🍔 美团外卖
// ═══════════════════════════════════════════════════════════════

function mtMakeToken(data) {
  const json = JSON.stringify(data);
  const deflated = deflateSync(Buffer.from(json, "utf8"));
  return deflated.toString("base64");
}

const MT_HEADERS = { "User-Agent": UA, "Referer": "https://h5.waimai.meituan.com/", "Accept": "application/json", "Origin": "https://h5.waimai.meituan.com" };

async function mtGetSign(url, bodyString) {
  const fullUrl = url + (url.includes("?") ? "&" : "?") +
    "yodaReady=h5&csecplatform=4&csecversion=4.2.4&_=" + Date.now();
  try {
    const sig = await getMtgsig(fullUrl, bodyString || "", MT_COOKIE);
    return { mtgsig: sig || "", signedUrl: fullUrl };
  } catch (e) {
    console.error("mtGetSign error:", e.message);
    return { mtgsig: "", signedUrl: url };
  }
}

async function mtApi(path, opts) {
  if (!MT_COOKIE) return null;
  try {
    const url = "https://i.waimai.meituan.com" + path;
    const bodyStr = opts?.body || "";
    const { mtgsig, signedUrl } = await mtGetSign(url, bodyStr);

    if (!mtgsig) {
      console.error("mtgsig EMPTY — aborting");
      return { ok: false, status: 403, _reason: "mtgsig_empty" };
    }

    const headers = {
      ...MT_HEADERS,
      cookie: MT_COOKIE,
      "Accept-Language": "zh-CN,zh;q=0.9",
      "sec-ch-ua": "\"Chromium\";v=\"9\", \"Not?A_Brand\";v=\"8\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"Windows\"",
      mtgsig: mtgsig,
      ...(opts.headers || {}),
    };
    const { headers: _, ...restOpts } = opts;
    const res = await fetch(signedUrl, { headers, ...restOpts });
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
    catch { return { ok: false, status: res.status, raw: text.slice(0, 500) }; }
  } catch (e) { return null; }
}

async function mtSearch(keyword, lat, lng) {
  const wmLat = lat ? Math.round(parseFloat(lat) * 1e6) : 28673167;
  const wmLng = lng ? Math.round(parseFloat(lng) * 1e6) : 115887078;
  const uuid = "7AEEA19018B2ABFC1C9F22CD67DB9A5389DB8A00850295DFC687E1F16155F59C";
  const now = Date.now();

  const bodyParams = {
    optimus_code: "10", optimus_risk_level: "71",
    keyword: keyword, page_index: "0",
    wm_order_channel: "default", req_time: String(now),
    search_global_id: "60500084",
    wm_latitude: String(wmLat), wm_longitude: String(wmLng),
    wm_ctype: "openapi", wm_dtype: "openapi",
    app_model: "0", page_size: "20", show_mode: "100",
    sort_type: "0", query_type: "0", wm_channel: "8",
    wm_dversion: "4.0.0", wm_appversion: "4.0.0",
    openh5_uuid: uuid, uuid: uuid,
    utm_campaign: "AwaimaiBwaimai", utm_term: "40000",
    utm_source: "8", utm_medium: "openapi",
  };
  const _token = mtMakeToken(bodyParams);
  bodyParams._token = _token;

  const result = await mtApi("/openh5/search/globalpage", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(bodyParams).toString(),
  });

  if (!result || result.status !== 200 || !result.data || result.data.code !== 0) {
    return { source: "error", reason: result?.status === 403 ? "upstream_403" : "api_failed", status: result?.status };
  }

  const modules = result.data?.data?.module_list || [];
  const shops = [];
  for (const m of modules) {
    try {
      const d = JSON.parse(m.string_data || "{}");
      shops.push({
        id: d.poi_id_str || "", name: d.name || "",
        addr: d.address || "", score: d.wm_poi_score || "",
        distance: d.distance || "", deliveryTime: d.delivery_time_tip || "",
        shippingFee: d.shipping_fee_tip || "", minPrice: d.min_price_tip || "",
        monthSales: d.month_sales_tip || "",
        products: (d.product_list || []).slice(0, 3).map(p => ({
          id: String(p.product_spu_id || ""), skuId: String(p.product_sku_id || ""),
          name: p.product_name || "", price: p.price || "",
        })),
      });
    } catch {}
  }
  return { source: "real", keyword, count: shops.length, shops: shops.slice(0, 15) };
}

async function mtGetAddresses() {
  if (!MT_COOKIE) return { source: "error", reason: "no_cookie" };
  const result = await mtApi("/openh5/address/list", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      wm_latitude: "28673167", wm_longitude: "115887078",
      openh5_uuid: "7AEEA19018B2ABFC1C9F22CD67DB9A5389DB8A00850295DFC687E1F16155F59C",
    }).toString(),
  });
  if (result?.data?.code === 0) {
    const list = result.data.data?.list || [];
    return {
      source: "real", count: list.length,
      addresses: list.map(a => ({ id: String(a.addressId), name: a.name, phone: a.phone, address: a.poi })),
    };
  }
  return { source: "error", reason: "api_failed" };
}

async function mtShopMenu(shopId) {
  if (!MT_COOKIE || !shopId) return { source: "error", reason: "need shopId" };
  const uuid = "7AEEA19018B2ABFC1C9F22CD67DB9A5389DB8A00850295DFC687E1F16155F59C";

  const initResult = await mtApi("/openapi/v1/poi/food", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      geoType: "2", wm_poi_id: "-100", poi_id_str: shopId,
      product_spu_id: "", source: "", uuid,
      platform: "3", partner: "4", riskLevel: "71", optimusCode: "10",
      wm_ctype: "openapi", wm_appversion: "4.0.0",
      originUrl: "https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=" + shopId,
      link_identifier_info: "",
    }).toString(),
  });

  const tags = initResult?.data?.data?.food_spu_tags || [];
  if (!tags.length) return { source: "error", reason: "no_tags" };

  let result, usedTag;
  for (const tag of tags) {
    usedTag = tag.tag;
    result = await mtApi("/openh5/v2/poi/menuproducts", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        wm_poi_id: "-100", poi_id_str: shopId,
        spu_tag_id: String(usedTag),
        support_new_page_v3: "true", sort_type: "1", tag_type: "1",
        wm_latitude: "28673167", wm_longitude: "115887078",
        openh5_uuid: uuid, uuid, platform: "3", partner: "4",
        originUrl: "https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=" + shopId,
        riskLevel: "71", optimusCode: "10",
      }).toString(),
    });
    if (result?.data?.code === 0 && result.data.data?.product_count > 0) break;
  }

  if (result?.data?.code === 0) {
    const d = result.data.data || {};
    const list = d.product_spu_list || [];
    return {
      source: "real", count: list.length,
      products: list.slice(0, 10).map(spu => ({
        id: String(spu.spu_id || ""), name: spu.name || "",
        price: spu.price || spu.min_price || "",
        skus: (spu.sku_list || []).map(sku => ({ id: String(sku.sku_id || ""), price: sku.price || "" })),
      })),
      tagLog: "tag:" + usedTag + " count:" + d.product_count,
    };
  }
  return { source: "error", reason: "menu_failed" };
}

async function mtPlaceOrder(shopId, itemId, addressId, quantity, attrIds, remark) {
  if (!MT_COOKIE) return { source: "error", reason: "no_cookie" };
  const uuid = "7AEEA19018B2ABFC1C9F22CD67DB9A5389DB8A00850295DFC687E1F16155F59C";

  const orderData = {
    wm_poi_id: "-100", poi_id_str: shopId, wm_order_pay_type: 2, cart_id: "",
    foodlist: [{ skuId: Number(itemId), id: Number(itemId), count: quantity || 1, attr_ids: attrIds || [], activityTag: "", remark: remark || "" }],
    expected_arrival_time: 0, lat: 0, lng: 0, orderToken: "", nb_app: "wap", pay_sdk_version: "1.1.8",
    callback_info: { activity_callback_info: "" }, accepted_select_coupon: [],
    addr_longitude: 0, addr_latitude: 0,
    recipient_name: "", recipient_phone: "", recipient_gender: "", recipient_address: "",
    house_number: {}, addr_id: addressId ? Number(addressId) : 0,
    wx_pay_params: { orderPayChannel: 1 },
    ext_param: { sqt_scene: "", sqtToken: "" },
    info: { time: Math.floor(Date.now() / 1000), channel: 1001, ctime: Math.floor(Date.now() / 1000), logType: "S", cType: "andriod" },
    wm_open_id: "",
  };

  const result = await mtApi("/openh5/order/v2/preview", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      data: JSON.stringify(orderData),
      wm_latitude: "28673167", wm_longitude: "115887078",
      wm_actual_latitude: "28673167", wm_actual_longitude: "115887078",
      wmUuidDeregistration: "0", wmUserIdDeregistration: "0",
      openh5_uuid: uuid, uuid,
    }).toString(),
  });

  if (result?.data?.code === 0) {
    const d = result.data.data || {};
    return { source: "real", step: "preview", totalPrice: d.totalPrice || d.total || "", deliveryFee: d.deliveryFee || d.shipping_fee || "" };
  }
  return { source: "error", reason: "preview_failed" };
}

// ═══════════════════════════════════════════════════════════════
// 🧠 Player State
// ═══════════════════════════════════════════════════════════════

const state = { queue: [], current: null, status: "idle", currentTime: 0, lyrics: null };

// ═══════════════════════════════════════════════════════════════
// 🔌 MCP Protocol
// ═══════════════════════════════════════════════════════════════

const ok = (id, r) => ({ jsonrpc: "2.0", id, result: r });
const txt = (id, text) => ok(id, { content: [{ type: "text", text }] });
const mcpInfo = { protocolVersion: "2024-11-05", serverInfo: { name: "Yuuke", version: "3.1.0" }, capabilities: { tools: {} } };

const tools = [
  // ── 网易云 ──
  { name: "play", description: "Search and play a song.", inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] } },
  { name: "skip", description: "Skip to next song.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "pause", description: "Toggle pause/resume.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "queue", description: "View current queue.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "playlists", description: "Get your playlists.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "add_to_playlist", description: "Add current song to a playlist.", inputSchema: { type: "object", properties: { songId: { type: "string" }, playlistId: { type: "string" } }, required: ["playlistId"] } },
  { name: "playlist_tracks", description: "Get tracks in a playlist.", inputSchema: { type: "object", properties: { playlistId: { type: "string" } }, required: ["playlistId"] } },
  { name: "current_song", description: "Get current song info and lyrics context.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "lyrics", description: "Get full lyrics.", inputSchema: { type: "object", properties: { songId: { type: "string" } }, required: [] } },
  // ── 美团 ──
  { name: "mt_search", description: "Search nearby shops on Meituan (food, grocery).", inputSchema: { type: "object", properties: { keyword: { type: "string" }, lat: { type: "string" }, lng: { type: "string" } }, required: ["keyword"] } },
  { name: "mt_addresses", description: "Get saved delivery addresses from Meituan.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "mt_menu", description: "Get full menu for a Meituan shop.", inputSchema: { type: "object", properties: { shopId: { type: "string" } }, required: ["shopId"] } },
  { name: "mt_order", description: "Preview order on Meituan.", inputSchema: { type: "object", properties: { shopId: { type: "string" }, itemId: { type: "string" }, addressId: { type: "string" }, quantity: { type: "number", default: 1 }, attrIds: { type: "array", items: { type: "number" } }, remark: { type: "string" } }, required: ["shopId", "itemId"] } },
  // ── 淘宝 ──
  { name: "tb_search", description: "Search products on Taobao. Returns name, price, sales, shop, and purchase link.", inputSchema: { type: "object", properties: { keyword: { type: "string" }, minPrice: { type: "string" }, maxPrice: { type: "string" }, sort: { type: "string" } }, required: ["keyword"] } },
  { name: "tb_detail", description: "Get product detail on Taobao.", inputSchema: { type: "object", properties: { itemId: { type: "string" } }, required: ["itemId"] } },
];

async function execTool(name, args) {
  try {
    switch (name) {
      // ── 音乐 ──
      case "play": {
        const songs = await searchSongs(args.keyword, 8);
        if (!songs.length) return `No results for "${args.keyword}"`;
        const checks = await Promise.all(songs.map(async s => { try { return (await getSongUrl(s.id)) ? s : null; } catch { return null; } }));
        const pick = checks.find(Boolean);
        if (!pick) return `No playable songs for "${args.keyword}"`;
        state.current = { id: pick.id, name: pick.name, artist: pick.artist, album: pick.album, coverUrl: pick.coverUrl, durationMs: pick.durationMs, playUrl: "" };
        state.status = "playing";
        if (!state.queue.find(q => q.id === pick.id)) state.queue.unshift(pick);
        return `🎵 ${pick.name} - ${pick.artist}`;
      }
      case "skip":
        if (state.queue.length > 1) { state.queue.shift(); state.current = state.queue[0]; state.current.playUrl = ""; state.status = "playing"; return `⏭ ${state.current.name}`; }
        if (state.current?.id) { state.status = "playing"; state.current.playUrl = ""; return `🔄 Replaying ${state.current.name}`; }
        state.status = "idle"; return "Queue empty";
      case "pause": state.status = state.status === "paused" ? "playing" : "paused"; return state.status === "paused" ? "⏸ Paused" : "▶ Playing";
      case "queue": return JSON.stringify({ current: state.current?.name || null, count: state.queue.length, status: state.status });
      case "playlists": return JSON.stringify(await getPlaylists());
      case "add_to_playlist": {
        const sid = args.songId || state.current?.id;
        if (!sid) return "No song to add";
        await addToPlaylist(args.playlistId, sid);
        return `✅ Added to playlist ${args.playlistId}`;
      }
      case "playlist_tracks": return JSON.stringify(await getPlaylistDetail(args.playlistId));
      case "current_song": {
        if (!state.current) return "No song playing";
        if (!state.lyrics || state.lyrics._id !== state.current.id) {
          state.lyrics = { _id: state.current.id, lines: parseLrc(await getLyricsRaw(state.current.id)) };
        }
        return JSON.stringify({ name: state.current.name, artist: state.current.artist, position: fm(state.currentTime), positionSec: state.currentTime, lyricsContext: lyricsAround(state.lyrics.lines, state.currentTime, 4) });
      }
      case "lyrics": {
        const id = args.songId || state.current?.id;
        if (!id) return "No song specified";
        return (await getLyricsRaw(id)) || "(no lyrics)";
      }
      // ── 美团 ──
      case "mt_search": {
        const keyword = args.keyword || (typeof args === "string" ? args : "汉堡");
        let result = await mtSearch(keyword, args.lat, args.lng);
        if (result.source !== "real") { await new Promise(r => setTimeout(r, 3000)); result = await mtSearch(keyword, args.lat, args.lng); }
        if (result.shops) result.shops = result.shops.map(s => ({ id: s.id, name: s.name, addr: (s.addr||"").slice(0,30), score: s.score, distance: s.distance, deliveryTime: s.deliveryTime, shippingFee: s.shippingFee, minPrice: s.minPrice, monthSales: s.monthSales, products: s.products }));
        return JSON.stringify(result);
      }
      case "mt_addresses": return JSON.stringify(await mtGetAddresses());
      case "mt_menu": return JSON.stringify(await mtShopMenu(args.shopId));
      case "mt_order": {
        const order = await mtPlaceOrder(args.shopId, args.itemId, args.addressId, args.quantity || 1, args.attrIds || [], args.remark || "");
        if (order.source === "real") return `💰 预览订单\n商品: ${args.itemId}\n实付: ¥${order.totalPrice}\n配送费: ¥${order.deliveryFee}`;
        return JSON.stringify(order);
      }
      // ── 淘宝 ──
      case "tb_search": {
        if (!TB_COOKIE) return JSON.stringify({ source: "error", reason: "no_cookie", hint: "请设置 TAOBAO_COOKIE 环境变量" });
        const r = await tbSearch(args.keyword, { pageSize: 20, sort: args.sort, minPrice: args.minPrice, maxPrice: args.maxPrice }, TB_COOKIE);
        return JSON.stringify(r);
      }
      case "tb_detail": {
        if (!TB_COOKIE) return JSON.stringify({ source: "error", reason: "no_cookie" });
        return JSON.stringify(await tbDetail(args.itemId, TB_COOKIE));
      }
      default: return "Unknown tool";
    }
  } catch (e) { return `❌ ${e.message}`; }
}

async function handleMcpMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;
  if (!method) return null;
  try {
    if (method === "initialize") return ok(id, mcpInfo);
    if (method === "notifications/initialized") return null;
    if (method === "tools/list") return ok(id, { tools: [...tools, ...obMemoryTools] });
    if (method === "tools/call") {
      const toolName = params.name;
      // 记忆类工具 → 转发到 Ombre-Brain
      if (isMemoryTool(toolName)) {
        const result = await forwardToOB(msg);
        if (result) return result;
        return txt(id, "⚠️ 记忆库未连接，请检查 Ombre-Brain 是否运行");
      }
      return txt(id, await execTool(toolName, params.arguments || {}));
    }
    if (method === "ping") return ok(id, {});
    return txt(id, `Unknown: ${method}`);
  } catch (e) { return txt(id, `❌ ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════
// 🎨 Player HTML
// ═══════════════════════════════════════════════════════════════

function playerHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover"/><title>🎵 Claude Music</title><style>*{margin:0;padding:0;box-sizing:border-box}:root{color-scheme:dark;--bg:#0d0d0d;--card:#1a1a1a;--muted:#888;--accent:#e83e3e;--text:#eee}body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;min-height:100dvh;display:flex;flex-direction:column;align-items:center;padding:max(16px,4vw);-webkit-tap-highlight-color:transparent}h1{font-size:clamp(18px,4.5vw,24px);margin-bottom:4px}.sub{color:var(--muted);font-size:13px;margin-bottom:18px}.art{width:min(240px,58vw);aspect-ratio:1;border-radius:16px;object-fit:cover;background:var(--card);margin-bottom:14px}.info{text-align:center;margin-bottom:8px}.info .name{font-size:clamp(15px,3.6vw,19px);font-weight:700}.info .artist{color:var(--muted);font-size:13px;margin-top:3px}.progress-wrap{width:100%;max-width:min(340px,80vw);margin-bottom:6px}.progress-row{display:flex;align-items:center;gap:10px}.time{font-size:11px;color:var(--muted);min-width:36px}.bar-wrap{flex:1;height:20px;display:flex;align-items:center;cursor:pointer}.bar-bg{width:100%;height:4px;background:rgba(255,255,255,.12);border-radius:2px}.bar-fill{height:100%;background:var(--accent);border-radius:2px;transition:width .15s linear}.bar-fill::after{content:"";position:absolute;right:-5px;top:-3px;width:10px;height:10px;border-radius:50%;background:var(--accent);opacity:0}.bar-wrap:active .bar-fill::after{opacity:1}.controls{display:flex;gap:18px;align-items:center;justify-content:center;margin-bottom:22px}.btn{border:none;border-radius:50%;display:grid;place-items:center;cursor:pointer;transition:.15s;background:var(--card);color:var(--text)}.btn:active{opacity:.7}.btn.small{width:42px;height:42px}.btn.big{width:58px;height:58px;background:var(--accent);color:#fff}.btn svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.btn.big svg{width:24px;height:24px;fill:currentColor}.queue{width:100%;max-width:min(360px,85vw);margin-top:4px}.queue h3{font-size:13px;color:var(--muted);margin-bottom:8px}.queue-item{display:flex;gap:10px;align-items:center;padding:9px 10px;border-radius:10px;margin-bottom:5px;background:var(--card)}.queue-item.active{background:#2a1a1a;border:1px solid var(--accent)}.queue-item img{width:38px;height:38px;border-radius:8px;object-fit:cover;background:#222;flex-shrink:0}.queue-item .qi{min-width:0}.queue-item .qname{font-size:13px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.queue-item .qart{font-size:11px;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.empty{color:var(--muted);font-size:13px;text-align:center;padding:20px}.status{font-size:11px;color:var(--muted);margin-top:6px;text-align:center}</style></head><body><h1>🎵 Claude Music</h1><div class="sub">跟 Claude 说"放一首歌"试试<br>本地版 v3.0</div><img class="art" id="art" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><rect fill='%231a1a1a' width='200' height='200'/><text fill='%23888' x='100' y='110' text-anchor='middle' font-size='40'>🎵</text></svg>"><div class="info"><div class="name" id="name">等待播放</div><div class="artist" id="artist">告诉 Claude 你想听什么</div></div><div class="progress-wrap"><div class="progress-row"><span class="time" id="curTime">0:00</span><div class="bar-wrap" id="barWrap"><div class="bar-bg"><div class="bar-fill" id="barFill" style="width:0%"></div></div></div><span class="time end" id="durTime">0:00</span></div></div><div class="controls"><button class="btn small" onclick="prev()"><svg viewBox="0 0 24 24"><polyline points="19 20 9 12 19 4"/><line x1="5" y1="19" x2="5" y2="5"/></svg></button><button class="btn big" id="playBtn" onclick="togglePlay()"><svg id="playIcon" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20"/></svg></button><button class="btn small" onclick="next()"><svg viewBox="0 0 24 24"><polyline points="5 4 15 12 5 20"/><line x1="19" y1="5" x2="19" y2="19"/></svg></button></div><div class="queue"><h3>📋 播放队列</h3><div id="queue"></div></div><div class="status" id="status">已连接</div><audio id="audio" style="display:none" preload="auto"></audio><script>
const a=document.getElementById("audio");let currentId=null,resolvingUrl=null,lastQueueStr="",localQueue=[];
function fm(s){const m=Math.floor(s/60),sec=Math.floor(s%60);return m+":"+(sec<10?"0":"")+sec}
if("mediaSession" in navigator){navigator.mediaSession.setActionHandler("play",()=>togglePlay());navigator.mediaSession.setActionHandler("pause",()=>togglePlay());navigator.mediaSession.setActionHandler("previoustrack",()=>prev());navigator.mediaSession.setActionHandler("nexttrack",()=>next())}
async function poll(){try{const r=await fetch("/api/state");if(!r.ok)return;render(await r.json())}catch(e){}}
function resolveUrlFor(songId){if(!songId||resolvingUrl===songId)return;resolvingUrl=songId;document.getElementById("status").textContent="🔊 加载音频...";fetch("/api/url?id="+encodeURIComponent(songId)).then(r=>r.json()).then(j=>{if(j.playUrl&&currentId===songId){a.src=j.playUrl;a.play().catch(()=>{});document.getElementById("status").textContent="▶ 播放中"}else if(currentId===songId)document.getElementById("status").textContent="⚠ 无播放链接";resolvingUrl=null}).catch(()=>{resolvingUrl=null})}
function render(d){
  if(d.current&&d.current.id){var ex=localQueue.some(t=>t.id===d.current.id);if(!ex)localQueue.push({id:d.current.id,name:d.current.name,artist:d.current.artist,coverUrl:d.current.coverUrl,durationMs:d.current.durationMs})}
  if(d.queue&&d.queue.length>0){d.queue.forEach(s=>{if(!localQueue.some(t=>t.id===s.id))localQueue.push(s)})}
  if(!currentId&&d.current&&d.current.id){currentId=d.current.id;document.getElementById("art").src=d.current.coverUrl||"";document.getElementById("name").textContent=d.current.name||"";document.getElementById("artist").textContent=d.current.artist||"";if("mediaSession" in navigator)navigator.mediaSession.metadata=new MediaMetadata({title:d.current.name,artist:d.current.artist,album:d.current.album||"",artwork:[{src:d.current.coverUrl||"",sizes:"300x300"}]});if(d.playUrl){a.src=d.playUrl;a.play().catch(()=>{})}else resolveUrlFor(d.current.id)}
  if(a.duration&&!isNaN(a.duration)){document.getElementById("barFill").style.width=(a.currentTime/a.duration*100).toFixed(1)+"%";document.getElementById("curTime").textContent=fm(a.currentTime);document.getElementById("durTime").textContent=fm(a.duration)}
  document.getElementById("playIcon").innerHTML=a.paused?'<polygon points="6 4 20 12 6 20"/>':'<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
  var qStr=localQueue.map(t=>t.id).join(",")+"|"+currentId;
  if(qStr!==lastQueueStr){lastQueueStr=qStr;var el=document.getElementById("queue");if(!localQueue.length)el.innerHTML='<div class="empty">队列空的</div>';else{var h='';localQueue.forEach(t=>{h+='<div class="queue-item'+(t.id===currentId?' active':'')+'"><img src="'+(t.coverUrl||'')+'" onerror="this.style.display=\\'none\\'"><div class="qi"><div class="qname">'+esc(t.name)+'</div><div class="qart">'+esc(t.artist)+'</div></div></div>'});el.innerHTML=h}}
}
function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function playSong(t){currentId=t.id;document.getElementById("art").src=t.coverUrl||"";document.getElementById("name").textContent=t.name||"";document.getElementById("artist").textContent=t.artist||"";if("mediaSession" in navigator)navigator.mediaSession.metadata=new MediaMetadata({title:t.name,artist:t.artist,artwork:[{src:t.coverUrl||"",sizes:"300x300"}]});resolveUrlFor(t.id)}
function togglePlay(){a.paused?a.play().catch(()=>{}):a.pause()}
function next(){a.pause();var i=localQueue.findIndex(t=>t.id===currentId);if(i>=0&&i+1<localQueue.length)playSong(localQueue[i+1]);else document.getElementById("status").textContent="✅ 队列播完"}
function prev(){a.pause();var i=localQueue.findIndex(t=>t.id===currentId);if(i>0)playSong(localQueue[i-1]);else if(localQueue.length>0){playSong(localQueue[0]);document.getElementById("status").textContent="🔁 第一首"}}
document.getElementById("barWrap").addEventListener("click",function(e){if(!a.duration||isNaN(a.duration))return;var r=this.getBoundingClientRect();a.currentTime=Math.max(0,Math.min(a.duration,(e.clientX-r.left)/r.width*a.duration))});
a.addEventListener("play",()=>document.getElementById("status").textContent="▶ 播放中");
a.addEventListener("pause",()=>{if(!a.ended)document.getElementById("status").textContent="⏸ 暂停"});
a.addEventListener("ended",()=>{document.getElementById("status").textContent="✅ 播放完毕";setTimeout(next,500)});
a.addEventListener("error",()=>{setTimeout(()=>{if(currentId)resolveUrlFor(currentId)},2000)});
a.addEventListener("timeupdate",()=>{if(a.duration&&!isNaN(a.duration)){document.getElementById("barFill").style.width=(a.currentTime/a.duration*100).toFixed(1)+"%";document.getElementById("curTime").textContent=fm(a.currentTime);document.getElementById("durTime").textContent=fm(a.duration)}});
setInterval(poll,2000);poll();
setInterval(()=>{if(currentId)fetch("/api/time",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({time:a.currentTime||0,songId:currentId,queue:localQueue.slice(0,20)})}).catch(()=>{})},3000);
</script></body></html>`;
}

// ═══════════════════════════════════════════════════════════════
// 🌐 HTTP Server
// ═══════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = u.pathname.replace(/\/+$/, "") || "/";

  try {
    // Player
    if (req.method === "GET" && path === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(playerHtml()); return; }
    // State
    if (req.method === "GET" && path === "/api/state") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ current: state.current || null, queue: state.queue.slice(0, 20), status: state.status, playUrl: state.current?.playUrl || "" })); return; }
    // URL resolve
    if (req.method === "GET" && path === "/api/url") {
      const id = u.searchParams.get("id");
      if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: "missing id" })); return; }
      let playUrl = ""; try { playUrl = await getSongUrl(id) || ""; } catch {}
      if (state.current?.id === id) state.current.playUrl = playUrl;
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ playUrl })); return;
    }
    // Next/prev
    if (req.method === "GET" && (path === "/api/next" || path === "/api/prev")) {
      if (path === "/api/next" && state.queue.length > 1) { state.queue.shift(); state.current = state.queue[0]; }
      if (state.current) state.current.playUrl = "";
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: state.current?.id || "" })); return;
    }
    // Time sync
    if (req.method === "POST" && path === "/api/time") {
      try { const b = await readBody(req); state.currentTime = Number(b.time) || 0; } catch {}
      res.writeHead(200); res.end("ok"); return;
    }
    // MCP POST
    if (req.method === "POST" && (path === "/api/mcp" || path.startsWith("/api/"))) {
      let body = await readBody(req);
      if (typeof body === "string" && body.trim()) body = JSON.parse(body);
      if (Array.isArray(body)) {
        const results = []; for (const msg of body) { const r = await handleMcpMessage(msg); if (r) results.push(r); }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(results));
      } else {
        const r = await handleMcpMessage(body);
        if (r) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(r));
        } else {
          res.writeHead(202);
          res.end("");
        }
      }
      return;
    }
    // MCP GET
    if (req.method === "GET" && path === "/api/mcp") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, server: "local", deployId: "v3.0" })); return; }
    // Health
    if (path === "/api/health") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }

    res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not found" }));
  } catch (e) {
    console.error("handler error:", e.message);
    res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message }));
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8").trim(); try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
  });
}

server.listen(PORT, async () => {
  console.log(`✅ netease-music-mcp v3.0 running on port ${PORT}`);
  console.log("   🎵 Netease:", COOKIE ? "OK (" + COOKIE.length + " chars)" : "NOT SET");
  console.log("   🍔 Meituan:", MT_COOKIE ? "OK (" + MT_COOKIE.length + " chars)" : "NOT SET");
  console.log("   🛒 Taobao:", TB_COOKIE ? "OK (" + TB_COOKIE.length + " chars)" : "NOT SET");
  console.log("   🧠 Memory:", "connecting to Ombre-Brain...");
  console.log("   MCP endpoint: http://localhost:" + PORT + "/api/mcp");
  console.log("   Player: http://localhost:" + PORT);
  // 异步连接 Ombre-Brain，不阻塞服务启动
  await initOmbreBrain();
  if (obReady) {
    console.log("   🧠 Memory: " + obMemoryTools.length + " tools ready (breath/hold/grow/...)");
  } else {
    console.log("   🧠 Memory: NOT CONNECTED — start Ombre-Brain on port 18001");
  }
});
