/**
 * server.js — 全功能 MCP Server（本地运行 / 腾讯云部署）
 *
 * 🎵 网易云音乐（weapi — VIP歌曲全通）
 * 🍔 美团外卖（搜索/地址/菜单/下单 — CDP 浏览器自动化）
 * 🛒 淘宝（搜索商品/详情/发链接）
 * 🎵 抖音（搜索/热搜/视频详情/用户主页 — CDP + SSR JSON，10G冲浪优化）
 * 🧠 长期记忆（Ombre-Brain 转发）
 * 🌿 Galatea 代理（工具转发）
 * 📱 屏幕时间（iPhone Shortcuts → 服务器 → Claude 查询）
 *
 * 用法: node server.js
 * 端口: process.env.PORT || 3000
 * 环境变量: NETEASE_COOKIE, MEITUAN_COOKIE, TAOBAO_COOKIE,
 *           GALATEA_TOKEN, TAOBAO_APP_KEY, TAOBAO_APP_SECRET, TAOBAO_ADZONE_ID
 */
import http from "node:http";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import {
  weapi, eapiEncrypt, eapiPost,
  getUserPlaylists, searchSongs, getSongDetail, getLyrics,
  getPlaylistDetail, addToPlaylist, getPlaylistTracks,
  acceptListenTogether, endListenTogether, listenTogetherHeartbeat,
  listenTogetherStatus, playCommandReport, addSongToList,
  sendPrivateMessage, getPrivateList, getPrivateMessages,
} from "./lib/netease.js";
import { tbSearch, tbDetail } from "./lib/taobao.js";
import { toggle as screentimeToggle, getReport as screentimeReport, getSummary as screentimeSummary } from "./lib/screentime.js";
// 淘宝开放平台（官方 API，不会被风控）
let openSearch = null;
try { const mod = await import("./lib/taobao-open.js"); openSearch = mod.openSearch; console.log("   🛒 Taobao Open API: available"); } catch { console.log("   🛒 Taobao Open API: not loaded"); }
// 浏览器模式（备选）
let tbBrowserSearch = null;
try { const mod = await import("./lib/taobao-browser.js"); tbBrowserSearch = mod.browserSearch; console.log("   🛒 Taobao browser mode: available"); } catch { console.log("   🛒 Taobao browser mode: puppeteer not installed"); }

const require = createRequire(import.meta.url);
const { getMtgsig, init: initSigner } = require("./lib/mt-signer-v2.cjs");
const cdp = require("./lib/cdp-meituan.cjs");
const { mtOrder } = require("./lib/mt-order.cjs");
const dy = require("./lib/cdp-douyin.cjs");  // 抖音 CDP

const COOKIE = process.env.NETEASE_COOKIE || "";
const MT_COOKIE = process.env.MEITUAN_COOKIE || "";
const TB_COOKIE = process.env.TAOBAO_COOKIE || "";
const PORT = process.env.PORT || 3000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const OB_URL = "http://127.0.0.1:18001/mcp";  // Ombre-Brain 记忆库
const OB_TOKEN = process.env.OB_TOKEN || "";
const GALATEA_URL = "https://galatea.abysslumina.com/mcp";
const GALATEA_TOKEN = process.env.GALATEA_TOKEN || "gg_nj2lRj6A84VrPvycdireDyGAaT7RduOUBHYEXuN-uGM";

// ─── Ombre-Brain 记忆库状态 ────────────────────────────────────
let obSessionId = null;
let obReady = false;

function obHeaders(extra = {}) {
  const h = { "Content-Type": "application/json", "Accept": "application/json", ...extra };
  if (OB_TOKEN) h["Authorization"] = `Bearer ${OB_TOKEN}`;
  if (obSessionId) h["Mcp-Session-Id"] = obSessionId;
  return h;
}
let obMemoryTools = [];

// ─── Galatea 代理状态 ──────────────────────────────────────────
let galateaSessionId = null;
let galateaReady = false;
let galateaTools = [];

// ─── 预初始化美团签名器 ────────────────────────────────────────
if (MT_COOKIE) {
  console.log("pre-init meituan signer, cookieLen:", MT_COOKIE.length);
  initSigner(MT_COOKIE).then(() => console.log("meituan signer ready"))
    .catch(e => console.error("meituan signer init failed:", e.message));
}

// ─── 启动 CDP 浏览器（美团 + 抖音共享 9222 端口）──────
cdp.startBrowser().then(() => console.log("   🖥️ CDP browser: OK")).catch(e => console.error("   🖥️ CDP browser:", e.message));
dy.startBrowser().then(() => console.log("   🎵 Douyin CDP: OK")).catch(e => console.error("   🎵 Douyin CDP:", e.message));

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
      headers: obHeaders(),
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
      headers: obHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    });

    // Step 3: 获取记忆工具列表
    const toolsRes = await fetch(OB_URL, {
      method: "POST",
      headers: obHeaders(),
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
    const res = await fetch(OB_URL, {
      method: "POST",
      headers: obHeaders(),
      body: JSON.stringify(msg)
    });
    const text = await res.text();
    const result = parseSSE(text) || JSON.parse(text);
    // 会话过期 → 重新握手后重试一次
    if (result && result.error && /session/i.test(result.error.message || "")) {
      console.log("OB session expired, re-initializing...");
      await initOmbreBrain();
      if (obReady && obSessionId) {
        const res2 = await fetch(OB_URL, { method: "POST", headers: obHeaders(), body: JSON.stringify(msg) });
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

// ─── 初始化 Galatea 代理连接 ──────────────────────────────────
async function initGalatea() {
  if (!GALATEA_TOKEN) {
    console.log("Galatea: GALATEA_TOKEN not set — skipping");
    galateaReady = false;
    galateaTools = [];
    return;
  }
  try {
    // Step 1: MCP initialize 握手
    const initRes = await fetch(GALATEA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": "Bearer " + GALATEA_TOKEN,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 0, method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "netease-music-mcp", version: "3.4.0" }
        }
      })
    });
    if (!initRes.ok) throw new Error(`initialize failed: ${initRes.status}`);
    galateaSessionId = initRes.headers.get("Mcp-Session-Id") || initRes.headers.get("mcp-session-id") || "";
    const initText = await initRes.text();
    const initData = parseSSE(initText) || JSON.parse(initText);
    console.log("Galatea initialize:", initData.result?.serverInfo?.name || "ok", galateaSessionId ? "(session)" : "");

    // Step 2: initialized 通知
    await fetch(GALATEA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(galateaSessionId ? { "Mcp-Session-Id": galateaSessionId } : {}),
        "Authorization": "Bearer " + GALATEA_TOKEN,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    });

    // Step 3: 获取工具列表
    const toolsRes = await fetch(GALATEA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(galateaSessionId ? { "Mcp-Session-Id": galateaSessionId } : {}),
        "Authorization": "Bearer " + GALATEA_TOKEN,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    const toolsText = await toolsRes.text();
    const toolsData = parseSSE(toolsText) || JSON.parse(toolsText);
    galateaTools = toolsData.result?.tools || [];
    galateaReady = true;
    console.log(`Galatea: ${galateaTools.length} tools loaded`);
  } catch (e) {
    console.error("Galatea init failed:", e.message);
    console.error("Galatea tools will NOT be available.");
    galateaReady = false;
    galateaTools = [];
  }
}

// ─── 判断是否为 Galatea 工具 ──────────────────────────────────
function isGalateaTool(name) {
  return galateaTools.some(t => t.name === name);
}

// ─── 转发工具调用到 Galatea ────────────────────────────────────
async function forwardToGalatea(msg) {
  if (!galateaReady) return null;
  try {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": "Bearer " + GALATEA_TOKEN,
    };
    if (galateaSessionId) headers["Mcp-Session-Id"] = galateaSessionId;
    const res = await fetch(GALATEA_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(msg)
    });
    const text = await res.text();
    const result = parseSSE(text) || JSON.parse(text);
    // 会话过期 → 重新握手后重试一次
    if (result && result.error && /session/i.test(result.error.message || "")) {
      console.log("Galatea session expired, re-initializing...");
      await initGalatea();
      if (galateaReady && galateaSessionId) {
        const headers2 = {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": "Bearer " + GALATEA_TOKEN,
          "Mcp-Session-Id": galateaSessionId,
        };
        const res2 = await fetch(GALATEA_URL, { method: "POST", headers: headers2, body: JSON.stringify(msg) });
        const text2 = await res2.text();
        return parseSSE(text2) || JSON.parse(text2);
      }
    }
    return result;
  } catch (e) {
    console.error("Galatea forward error:", e.message);
    return null;
  }
}

// ─── 一起听心跳管理器 ──────────────────────────────────────
const heartbeatRooms = new Map(); // roomId → { interval, songId, progress }

function startHeartbeat(roomId, songId = "0", progress = "0") {
  if (heartbeatRooms.has(roomId)) {
    clearInterval(heartbeatRooms.get(roomId).interval);
  }
  const interval = setInterval(async () => {
    try {
      const r = heartbeatRooms.get(roomId);
      if (!r) return;
      await listenTogetherHeartbeat(roomId, r.songId, "playing", r.progress, COOKIE);
    } catch { /* 静默重试 */ }
  }, 30000);
  heartbeatRooms.set(roomId, { interval, songId, progress });
  return true;
}

function stopHeartbeat(roomId) {
  const r = heartbeatRooms.get(roomId);
  if (!r) return false;
  clearInterval(r.interval);
  heartbeatRooms.delete(roomId);
  return true;
}

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

// (mtGetAddresses 和 mtShopMenu 已移除 — mt_order 内置)

async function mtPlaceOrder(shopId, itemId, skuId, addressId, quantity, attrIds, remark) {
  if (!MT_COOKIE) return { source: "error", reason: "no_cookie" };
  const uuid = "7AEEA19018B2ABFC1C9F22CD67DB9A5389DB8A00850295DFC687E1F16155F59C";
  const spuId = Number(itemId); const skuIdNum = Number(skuId || itemId);

  const orderData = {
    wm_poi_id: "-100", poi_id_str: shopId, wm_order_pay_type: 2, cart_id: "",
    foodlist: [{ skuId: skuIdNum, id: spuId, count: quantity || 1, attr_ids: attrIds || [], activityTag: "", remark: remark || "" }],
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

  const bodyParams = (data) => new URLSearchParams({
    data: JSON.stringify(data),
    wm_latitude: "28673167", wm_longitude: "115887078",
    wm_actual_latitude: "28673167", wm_actual_longitude: "115887078",
    wmUuidDeregistration: "0", wmUserIdDeregistration: "0",
    openh5_uuid: uuid, uuid,
  }).toString();

  console.error("[mt_order] sending preview, shopId:", shopId, "itemId:", itemId, "skuId:", skuIdNum, "foodlist:", JSON.stringify(orderData.foodlist));

  const result = await mtApi("/openh5/order/v2/preview", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: bodyParams(orderData),
  });

  console.error("[mt_order] preview raw:", JSON.stringify({ ok: result?.ok, status: result?.status, code: result?.data?.code, msg: result?.data?.msg, dataKeys: result?.data?.data ? Object.keys(result.data.data) : "no-data" }).slice(0, 300));

  if (result?.data?.code !== 0) {
    console.error("[mt_order] preview failed:", JSON.stringify(result?.data || result).slice(0, 500));
    return { source: "error", reason: "preview_failed", code: result?.data?.code, msg: result?.data?.msg || "" };
  }

  const preview = result.data.data || {};
  const total = preview.totalPrice || preview.total || "";
  const fee = preview.deliveryFee || preview.shipping_fee || "";

  // 提交订单
  console.error("[mt_order] creating...");
  orderData.orderToken = preview.orderToken || preview.order_token || "";
  const createRes = await mtApi("/openh5/order/v2/create", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: bodyParams(orderData),
  });

  if (createRes?.data?.code === 0) {
    const d = createRes.data.data || {};
    return { source: "real", step: "created", orderId: d.orderId || d.order_id || "", totalPrice: d.totalPrice || d.total || total, deliveryFee: d.deliveryFee || d.shipping_fee || fee, payUrl: d.payUrl || d.pay_url || "" };
  }

  return { source: "real", step: "preview", totalPrice: total, deliveryFee: fee, hint: "create failed: " + (createRes?.data?.code || "") + " " + (createRes?.data?.msg || "") };
}

// ═══════════════════════════════════════════════════════════════
// 🔌 MCP Protocol
// ═══════════════════════════════════════════════════════════════

const ok = (id, r) => ({ jsonrpc: "2.0", id, result: r });
const txt = (id, text) => ok(id, { content: [{ type: "text", text }] });
const mcpInfo = { protocolVersion: "2024-11-05", serverInfo: { name: "Yuuke", version: "3.9.0" }, capabilities: { tools: {} } };

const tools = [
  // ── 网易云（歌单管理）──
  { name: "playlists", description: "Get your Netease playlists.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "add_to_playlist", description: "Add a song to a playlist by song ID.", inputSchema: { type: "object", properties: { songId: { type: "string" }, playlistId: { type: "string" } }, required: ["playlistId", "songId"] } },
  { name: "playlist_tracks", description: "Get tracks in a playlist.", inputSchema: { type: "object", properties: { playlistId: { type: "string" } }, required: ["playlistId"] } },
  // ── 网易云一起听 ──
  { name: "ncm_search", description: "Search Netease Cloud Music. Returns id, name, artist, album for each result.", inputSchema: { type: "object", properties: { keyword: { type: "string" }, limit: { type: "number", default: 8 } }, required: ["keyword"] } },
  { name: "ncm_song_detail", description: "Get song detail + full lyrics by song ID.", inputSchema: { type: "object", properties: { songId: { type: "string" } }, required: ["songId"] } },
  { name: "ncm_accept_invite", description: "Accept a listen-together invitation (from private message). Starts auto-heartbeat.", inputSchema: { type: "object", properties: { roomId: { type: "string" }, inviterId: { type: "string" } }, required: ["roomId", "inviterId"] } },
  { name: "ncm_leave_room", description: "End listen-together session. Stops heartbeat.", inputSchema: { type: "object", properties: { roomId: { type: "string" } }, required: [] } },
  { name: "ncm_room_status", description: "Get listen-together room status and playlist.", inputSchema: { type: "object", properties: { roomId: { type: "string" } }, required: ["roomId"] } },
  { name: "ncm_switch_song", description: "Switch song in listen-together room (real-time).", inputSchema: { type: "object", properties: { roomId: { type: "string" }, songId: { type: "string" } }, required: ["songId"] } },
  { name: "ncm_add_song", description: "Add song(s) to listen-together playlist.", inputSchema: { type: "object", properties: { roomId: { type: "string" }, songId: { type: "string" } }, required: ["roomId", "songId"] } },
  { name: "ncm_heartbeat", description: "Manually start/stop heartbeat for a listen-together room.", inputSchema: { type: "object", properties: { roomId: { type: "string" }, action: { type: "string", description: "'start' or 'stop'" } }, required: ["roomId", "action"] } },
  // ── 网易云私信 ──
  { name: "ncm_send_message", description: "Send a private message to a Netease user.", inputSchema: { type: "object", properties: { userId: { type: "string", description: "User ID to message" }, msg: { type: "string", description: "Message content" } }, required: ["userId", "msg"] } },
  { name: "ncm_read_messages", description: "Read private message history with a user (to find listen-together invites).", inputSchema: { type: "object", properties: { userId: { type: "string" }, limit: { type: "number", default: 20 } }, required: ["userId"] } },
  { name: "ncm_message_list", description: "Get recent private message contact list.", inputSchema: { type: "object", properties: {}, required: [] } },
  // ── 美团 ──
  { name: "mt_search", description: "Search nearby shops on Meituan (food, grocery).", inputSchema: { type: "object", properties: { keyword: { type: "string" }, lat: { type: "string" }, lng: { type: "string" } }, required: ["keyword"] } },
  { name: "mt_order", description: "全自动美团外卖下单：搜店→选品→加购→结算→填地址备注→选红包→提交。成功返回付款链接，403则返回结算页链接。", inputSchema: { type: "object", properties: { shopName: { type: "string", description: "店铺名，如 一点点、肯德基" }, productName: { type: "string", description: "商品名，如 藏青盐咸奶绿、热辣香骨鸡" }, specs: { type: "object", description: "规格选择，如 {\"份量\":\"大杯\",\"糖度\":\"三分糖\",\"冰度\":\"标准冰\"}，不传则用默认" }, addressName: { type: "string", description: "收货地址名（可选，默认用服务器配置）" }, remark: { type: "string", description: "备注，如 老婆辛苦了" }, useCoupons: { type: "boolean", default: true, description: "是否选红包" } }, required: ["shopName", "productName"] } },
  // ── 抖音（CDP 浏览器自动化 — 10G 冲浪优化）──
  { name: "dy_search", description: "在抖音首页推荐流中搜索视频。按关键词过滤标题和作者，返回匹配的视频列表（含作者、标题、点赞）。", inputSchema: { type: "object", properties: { keyword: { type: "string", description: "搜索关键词" } }, required: ["keyword"] } },
  { name: "dy_trending", description: "抖音热搜榜 — 当前最火的话题和视频。", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "dy_video", description: "获取抖音视频详情 — 标题、点赞、评论、分享数、发布时间。", inputSchema: { type: "object", properties: { videoId: { type: "string", description: "视频 ID 或完整 URL（自动提取 ID）" } }, required: ["videoId"] } },
  { name: "dy_user", description: "抖音用户主页 — 昵称、简介、粉丝数、获赞数、作品数。", inputSchema: { type: "object", properties: { userId: { type: "string", description: "用户 ID（sec_uid 或 uid）" } }, required: ["userId"] } },
  { name: "dy_comment", description: "在抖音视频下发评论或回复他人评论。replyTo 填要回复的评论内容关键词可以发子评论。", inputSchema: { type: "object", properties: { videoId: { type: "string", description: "视频 ID 或完整 URL" }, text: { type: "string", description: "评论内容" }, replyTo: { type: "string", description: "可选，要回复的评论内容关键词（匹配到就发子评论）" } }, required: ["videoId", "text"] } },
  // ── 淘宝 ──
  { name: "tb_search", description: "Search products on Taobao. Returns name, price, sales, shop, and purchase link.", inputSchema: { type: "object", properties: { keyword: { type: "string", description: "Search keyword" }, minPrice: { type: "string", description: "Minimum price filter (client-side)" }, maxPrice: { type: "string", description: "Maximum price filter (client-side)" }, sort: { type: "string", description: "Sort: _coefp (relevance, default), _sale (sales), _price (price low→high), _priceD (price high→low)" }, page: { type: "number", default: 1, description: "Page number" }, pageSize: { type: "number", default: 20, description: "Results per page" } }, required: ["keyword"] } },
  { name: "tb_detail", description: "Get product detail on Taobao — price, original price, sales, stock, shop info, coupons, images.", inputSchema: { type: "object", properties: { itemId: { type: "string", description: "Taobao item ID (from search results)" } }, required: ["itemId"] } },
  { name: "tb_link", description: "Generate shareable purchase links (H5 + PC) from a Taobao item ID.", inputSchema: { type: "object", properties: { itemId: { type: "string", description: "Taobao item ID" } }, required: ["itemId"] } },
  // ── 屏幕时间 ──
  { name: "screentime_report", description: "Get today's screen-time report — all tracked apps with usage time and session count. Like iPhone Screen Time but readable by Claude.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "screentime_app", description: "Query screen-time for a specific app today.", inputSchema: { type: "object", properties: { app: { type: "string", description: "App name, e.g. 小红书 / 微信 / Claude" } }, required: ["app"] } },
];

async function execTool(name, args) {
  try {
    switch (name) {
      // ── 网易云歌单 ──
      case "playlists": return JSON.stringify(await getUserPlaylists(COOKIE));
      case "add_to_playlist": {
        if (!args.songId) return "Missing songId";
        await addToPlaylist(args.playlistId, [args.songId], COOKIE);
        return `✅ Added to playlist ${args.playlistId}`;
      }
      case "playlist_tracks": return JSON.stringify(await getPlaylistDetail(args.playlistId, COOKIE));
      // ── 网易云一起听 ──
      case "ncm_search": {
        const songs = await searchSongs(args.keyword, COOKIE, args.limit || 8);
        return JSON.stringify(songs);
      }
      case "ncm_song_detail": {
        if (!args.songId) return "Missing songId";
        const detail = await getSongDetail(args.songId, COOKIE);
        let lyrics = "";
        try { lyrics = await getLyrics(args.songId, COOKIE); } catch {}
        return JSON.stringify({ ...detail, lyrics: lyrics || "" });
      }
      case "ncm_accept_invite": {
        if (!args.roomId || !args.inviterId) return "Missing roomId or inviterId";
        if (!COOKIE) return "NETEASE_COOKIE not set";
        const result = await acceptListenTogether(args.roomId, args.inviterId, 1, COOKIE);
        startHeartbeat(args.roomId);
        return JSON.stringify({ ok: true, roomId: args.roomId, msg: "Joined! Heartbeat started (30s interval)." });
      }
      case "ncm_leave_room": {
        const roomId = args.roomId || [...heartbeatRooms.keys()][0];
        if (!roomId) return "No active room — pass roomId or join one first";
        const result = await endListenTogether(roomId, COOKIE);
        stopHeartbeat(roomId);
        return JSON.stringify({ ok: true, msg: "Left room, heartbeat stopped." });
      }
      case "ncm_room_status": {
        if (!args.roomId) return "Missing roomId";
        const raw = await listenTogetherStatus(args.roomId, COOKIE);
        const pc = raw?.data?.playCommand || {};
        const pl = raw?.data?.playlist?.displayList?.result || [];
        return JSON.stringify({
          songId: pc.targetSongId || "",
          status: pc.playStatus || "",
          commandType: pc.commandType || "",
          playlistCount: pl.length,
          playlist: pl.slice(0, 5), // 只返回前5首，省 token
        });
      }
      case "ncm_switch_song": {
        const roomId = args.roomId || [...heartbeatRooms.keys()][0];
        if (!roomId) return "No roomId — pass roomId or join a room first";
        await playCommandReport(roomId, args.songId, "0", "playing", COOKIE);
        const r = heartbeatRooms.get(roomId);
        if (r) r.songId = args.songId;
        return `🔀 Switched to song ${args.songId}`;
      }
      case "ncm_add_song": {
        const roomId = args.roomId || [...heartbeatRooms.keys()][0];
        if (!roomId || !args.songId) return "Need roomId and songId";
        await addSongToList(roomId, [args.songId], COOKIE);
        return `➕ Added ${args.songId} to room queue`;
      }
      case "ncm_heartbeat": {
        if (!args.roomId) return "Missing roomId";
        if (args.action === "stop") return stopHeartbeat(args.roomId) ? "🛑 Heartbeat stopped" : "No active heartbeat";
        return startHeartbeat(args.roomId) ? "💓 Heartbeat started (30s)" : "Already running";
      }
      // ── 网易云私信 ──
      case "ncm_send_message": {
        if (!args.userId || !args.msg) return "Need userId and msg";
        await sendPrivateMessage([args.userId], args.msg, "text", COOKIE);
        return `✉️ Sent: "${args.msg.slice(0, 50)}"`;
      }
      case "ncm_read_messages": {
        if (!args.userId) return "Missing userId";
        const data = await getPrivateMessages(args.userId, COOKIE, args.limit || 20);
        // 瘦身：只保留 nickname + msg + type + time，砍掉完整 profile
        const msgs = (data.msgs || []).map(m => {
          let inner = {};
          try { inner = JSON.parse(m.msg); } catch {}
          return {
            from: m.fromUser?.nickname || "",
            msg: inner.msg || inner.title || "",
            type: inner.type || "",
            notice: inner.generalMsg?.noticeMsg || "",
            roomId: (inner.generalMsg?.nativeUrl || "").match(/roomId%3D([^%]+)/)?.[1] || "",
            inviterId: (inner.generalMsg?.nativeUrl || "").match(/inviterId%3D(\d+)/)?.[1] || "",
            time: m.time || 0,
            timeStr: m.time ? new Date(m.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "",
          };
        });
        return JSON.stringify({ more: data.more, msgs });
      }
      case "ncm_message_list": {
        return JSON.stringify(await getPrivateList(COOKIE));
      }
      // ── 美团（CDP 浏览器优先，API 签名兜底）──
      case "mt_search": {
        const keyword = args.keyword || (typeof args === "string" ? args : "汉堡");
        // 🔥 API 优先（CDP 浏览器常被美团风控）
        const result = await mtSearch(keyword, args.lat, args.lng);
        if (result.source === "real" && result.shops?.length > 0) {
          if (result.shops) result.shops = result.shops.map(s => ({ id: s.id, name: s.name, addr: (s.addr||"").slice(0,30), score: s.score, distance: s.distance, deliveryTime: s.deliveryTime, shippingFee: s.shippingFee, minPrice: s.minPrice, monthSales: s.monthSales, products: s.products }));
          return JSON.stringify(result);
        }
        // fallback: CDP 浏览器
        try { const cdpResult = await cdp.mtSearch(keyword); if (cdpResult.source === "real") return JSON.stringify(cdpResult); } catch {}
        return JSON.stringify(result);
      }
      case "mt_order": {
        const result = await mtOrder({
          shopName: args.shopName,
          productName: args.productName,
          specs: args.specs,
          addressName: args.addressName || "默认地址",
          remark: args.remark,
          useCoupons: args.useCoupons !== false,
        });
        if (result.ok) {
          return JSON.stringify({ ok: true, status: "success", url: result.url, hint: "订单已提交，请在手机上完成付款" });
        }
        if (result.status === "403") {
          return JSON.stringify({ ok: false, status: "403", previewUrl: result.previewUrl, hint: "提交被风控，点击链接手动提交即可" });
        }
        return JSON.stringify(result);
      }
      // ── 抖音（CDP 浏览器，SSR JSON 优先）──
      case "dy_search": {
        console.error("[dy_search] keyword:", args.keyword);
        try {
          const result = await dy.dySearch(args.keyword);
          console.error("[dy_search] source:", result.source, "count:", result.videos?.length||result.raw?.length||0);
          return JSON.stringify(result);
        } catch (e) { return JSON.stringify({ source: "error", reason: e.message }); }
      }
      case "dy_trending": {
        try {
          const result = await dy.dyTrending();
          console.error("[dy_trending] source:", result.source, "count:", result.items?.length||result.raw?.length||0);
          return JSON.stringify(result);
        } catch (e) { return JSON.stringify({ source: "error", reason: e.message }); }
      }
      case "dy_video": {
        let vid = String(args.videoId || "").trim();
        if (vid.startsWith("http")) { const m = vid.match(/video\/(\d+)/); vid = m ? m[1] : vid; }
        if (!vid) return JSON.stringify({ source: "error", reason: "missing videoId" });
        try {
          const result = await dy.dyVideo(vid);
          console.error("[dy_video] source:", result.source);
          return JSON.stringify(result);
        } catch (e) { return JSON.stringify({ source: "error", reason: e.message }); }
      }
      case "dy_user": {
        const uid = String(args.userId || "").trim();
        if (!uid) return JSON.stringify({ source: "error", reason: "missing userId" });
        try {
          const result = await dy.dyUser(uid);
          console.error("[dy_user] source:", result.source);
          return JSON.stringify(result);
        } catch (e) { return JSON.stringify({ source: "error", reason: e.message }); }
      }
      case "dy_comment": {
        let vid = String(args.videoId || "").trim();
        if (vid.startsWith("http")) { const m = vid.match(/video\/(\d+)/); vid = m ? m[1] : vid; }
        if (!vid) return JSON.stringify({ source: "error", reason: "missing videoId" });
        const commentText = String(args.text || "").trim();
        if (!commentText) return JSON.stringify({ source: "error", reason: "empty comment" });
        try {
          const result = await dy.dyComment(vid, commentText, args.replyTo);
          console.error("[dy_comment] ok:", result.ok, "status:", result.status);
          return JSON.stringify(result);
        } catch (e) { return JSON.stringify({ source: "error", reason: e.message }); }
      }
      // ── 淘宝 ──
      case "tb_search": {
        if (!TB_COOKIE && !openSearch) return JSON.stringify({ source: "error", reason: "no_cookie", hint: "请设置 TAOBAO_APP_KEY 和 TAOBAO_APP_SECRET" });
        console.error("[tb_search] keyword:", args.keyword);
        let result;

        // 第1优先: 淘宝开放平台（官方 API，不风控）
        if (openSearch) {
          result = await openSearch(args.keyword, {
            pageSize: args.pageSize || 10,
            sort: args.sort || "",
            page: args.page || 1,
            isTmall: args.isTmall,
            hasCoupon: args.hasCoupon,
          });
        }

        // 第2优先: 浏览器模式
        if ((!result || result.source !== "real") && tbBrowserSearch && TB_COOKIE) {
          if (result) console.error("[tb_search] open api failed:", result.reason, "→ fallback to browser");
          result = await tbBrowserSearch(args.keyword, {
            pageSize: args.pageSize || 10,
            sort: args.sort || "_coefp",
            minPrice: args.minPrice,
            maxPrice: args.maxPrice,
            page: args.page || 1,
          }, TB_COOKIE);
        }

        // 第3优先: 直接 mtop API
        if (!result || result.source !== "real") {
          if (result) console.error("[tb_search] browser failed:", result.reason, "→ fallback to direct API");
          if (!TB_COOKIE) return JSON.stringify(result || { source: "error", reason: "all_failed" });
          result = await tbSearch(args.keyword, {
            pageSize: args.pageSize || 20,
            sort: args.sort || "_coefp",
            minPrice: args.minPrice,
            maxPrice: args.maxPrice,
            page: args.page || 1,
          }, TB_COOKIE);
          if (result.source !== "real") {
            await new Promise(r => setTimeout(r, 3000));
            result = await tbSearch(args.keyword, {
              pageSize: args.pageSize || 20,
              sort: args.sort || "_coefp",
              minPrice: args.minPrice,
              maxPrice: args.maxPrice,
              page: args.page || 1,
            }, TB_COOKIE);
          }
        }

        if (result.products) {
          result.products = result.products.slice(0, 15).map(p => ({
            id: p.id, title: (p.title || "").slice(0, 60),
            price: p.price, sold: p.sold,
            shopName: (p.shopName || "").slice(0, 20),
            image: p.image, url: p.url,
            coupon: p.coupon || "",  // 开放平台有优惠券信息
          }));
        }
        console.error("[tb_search] result — source:", result.source, "count:", result.products?.length);
        return JSON.stringify(result);
      }
      case "tb_detail": {
        if (!TB_COOKIE) return JSON.stringify({ source: "error", reason: "no_cookie" });
        console.error("[tb_detail] itemId:", args.itemId);
        let detail = await tbDetail(args.itemId, TB_COOKIE);
        if (detail.source !== "real") {
          await new Promise(r => setTimeout(r, 3000));
          detail = await tbDetail(args.itemId, TB_COOKIE);
        }
        console.error("[tb_detail] result — source:", detail.source);
        return JSON.stringify(detail);
      }
      case "tb_link": {
        const id = String(args.itemId || "").trim();
        if (!id) return JSON.stringify({ source: "error", reason: "missing_itemId" });
        return JSON.stringify({
          source: "real",
          itemId: id,
          h5Link: "https://h5.m.taobao.com/awp/core/detail.htm?id=" + id,
          pcLink: "https://item.taobao.com/item.htm?id=" + id,
        });
      }
      // ── 屏幕时间 ──
      case "screentime_report": return screentimeSummary();
      case "screentime_app": {
        const app = screentimeReport().apps.find(a => a.app === args.app);
        return app ? `${app.app}: ${app.totalMinutes}分钟, ${app.sessionCount}次` : `今天还没用过 ${args.app}`;
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
    if (method === "tools/list") return ok(id, { tools: [...tools, ...obMemoryTools, ...galateaTools] });
    if (method === "tools/call") {
      const toolName = params.name;
      // 记忆类工具 → 转发到 Ombre-Brain
      if (isMemoryTool(toolName)) {
        const result = await forwardToOB(msg);
        if (result) return result;
        return txt(id, "⚠️ 记忆库未连接，请检查 Ombre-Brain 是否运行");
      }
      // Galatea 工具 → 转发到 Galatea
      if (isGalateaTool(toolName)) {
        const result = await forwardToGalatea(msg);
        if (result) return result;
        return txt(id, "⚠️ Galatea 未连接，请检查 GALATEA_TOKEN 是否正确");
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
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover"/><title>🎵 Claude Music</title><style>*{margin:0;padding:0;box-sizing:border-box}:root{color-scheme:dark;--bg:#0d0d0d;--card:#1a1a1a;--muted:#888;--accent:#e83e3e;--text:#eee}body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;min-height:100dvh;display:flex;flex-direction:column;align-items:center;padding:max(16px,4vw);-webkit-tap-highlight-color:transparent}h1{font-size:clamp(18px,4.5vw,24px);margin-bottom:4px}.sub{color:var(--muted);font-size:13px;margin-bottom:18px}.art{width:min(240px,58vw);aspect-ratio:1;border-radius:16px;object-fit:cover;background:var(--card);margin-bottom:14px}.info{text-align:center;margin-bottom:8px}.info .name{font-size:clamp(15px,3.6vw,19px);font-weight:700}.info .artist{color:var(--muted);font-size:13px;margin-top:3px}.progress-wrap{width:100%;max-width:min(340px,80vw);margin-bottom:6px}.progress-row{display:flex;align-items:center;gap:10px}.time{font-size:11px;color:var(--muted);min-width:36px}.bar-wrap{flex:1;height:20px;display:flex;align-items:center;cursor:pointer}.bar-bg{width:100%;height:4px;background:rgba(255,255,255,.12);border-radius:2px}.bar-fill{height:100%;background:var(--accent);border-radius:2px;transition:width .15s linear}.bar-fill::after{content:"";position:absolute;right:-5px;top:-3px;width:10px;height:10px;border-radius:50%;background:var(--accent);opacity:0}.bar-wrap:active .bar-fill::after{opacity:1}.controls{display:flex;gap:18px;align-items:center;justify-content:center;margin-bottom:22px}.btn{border:none;border-radius:50%;display:grid;place-items:center;cursor:pointer;transition:.15s;background:var(--card);color:var(--text)}.btn:active{opacity:.7}.btn.small{width:42px;height:42px}.btn.big{width:58px;height:58px;background:var(--accent);color:#fff}.btn svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.btn.big svg{width:24px;height:24px;fill:currentColor}.queue{width:100%;max-width:min(360px,85vw);margin-top:4px}.queue h3{font-size:13px;color:var(--muted);margin-bottom:8px}.queue-item{display:flex;gap:10px;align-items:center;padding:9px 10px;border-radius:10px;margin-bottom:5px;background:var(--card)}.queue-item.active{background:#2a1a1a;border:1px solid var(--accent)}.queue-item img{width:38px;height:38px;border-radius:8px;object-fit:cover;background:#222;flex-shrink:0}.queue-item .qi{min-width:0}.queue-item .qname{font-size:13px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.queue-item .qart{font-size:11px;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.empty{color:var(--muted);font-size:13px;text-align:center;padding:20px}.status{font-size:11px;color:var(--muted);margin-top:6px;text-align:center}</style></head><body><h1>🎵 Claude Music</h1><div class="sub">跟 Claude 说"放一首歌"试试<br>本地版 v3.3</div><img class="art" id="art" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><rect fill='%231a1a1a' width='200' height='200'/><text fill='%23888' x='100' y='110' text-anchor='middle' font-size='40'>🎵</text></svg>"><div class="info"><div class="name" id="name">等待播放</div><div class="artist" id="artist">告诉 Claude 你想听什么</div></div><div class="progress-wrap"><div class="progress-row"><span class="time" id="curTime">0:00</span><div class="bar-wrap" id="barWrap"><div class="bar-bg"><div class="bar-fill" id="barFill" style="width:0%"></div></div></div><span class="time end" id="durTime">0:00</span></div></div><div class="controls"><button class="btn small" onclick="prev()"><svg viewBox="0 0 24 24"><polyline points="19 20 9 12 19 4"/><line x1="5" y1="19" x2="5" y2="5"/></svg></button><button class="btn big" id="playBtn" onclick="togglePlay()"><svg id="playIcon" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20"/></svg></button><button class="btn small" onclick="next()"><svg viewBox="0 0 24 24"><polyline points="5 4 15 12 5 20"/><line x1="19" y1="5" x2="19" y2="19"/></svg></button></div><div class="queue"><h3>📋 播放队列</h3><div id="queue"></div></div><div class="status" id="status">已连接</div><audio id="audio" style="display:none" preload="auto"></audio><script>
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
      let playUrl = ""; // legacy: getSongUrl removed in v4.4
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
    if (req.method === "GET" && path === "/api/mcp") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, server: "local", deployId: "v3.3" })); return; }
    // Health
    if (path === "/api/health") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }

    // ── Screen Time API ──
    // GET /api/screentime/toggle/:appName — iPhone Shortcuts calls this
    if (req.method === "GET" && path.startsWith("/api/screentime/toggle/")) {
      const appName = decodeURIComponent(path.split("/api/screentime/toggle/")[1]);
      const result = await screentimeToggle(appName);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result)); return;
    }
    // GET /api/screentime/report — query full report
    if (req.method === "GET" && path === "/api/screentime/report") {
      const report = screentimeReport();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(report)); return;
    }

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
  console.log(`✅ netease-music-mcp v3.5 running on port ${PORT}`);
  console.log("   🎵 Netease:", COOKIE ? "OK (" + COOKIE.length + " chars)" : "NOT SET");
  console.log("   🍔 Meituan:", MT_COOKIE ? "OK (" + MT_COOKIE.length + " chars)" : "NOT SET");
  console.log("   🛒 Taobao:", TB_COOKIE ? "OK (" + TB_COOKIE.length + " chars)" : "NOT SET");
  console.log("   🧠 Memory:", "connecting to Ombre-Brain...");
  console.log("   🌿 Galatea:", GALATEA_TOKEN ? "connecting..." : "NOT SET");
  console.log("   MCP endpoint: http://localhost:" + PORT + "/api/mcp");
  console.log("   Player: http://localhost:" + PORT);
  // 异步连接外部服务，不阻塞启动
  initOmbreBrain().then(() => {
    if (obReady) console.log("   🧠 Memory: " + obMemoryTools.length + " tools ready");
    else console.log("   🧠 Memory: NOT CONNECTED — start Ombre-Brain on port 18001");
  });
  initGalatea().then(() => {
    if (galateaReady) console.log("   🌿 Galatea: " + galateaTools.length + " tools ready");
    else console.log("   🌿 Galatea: NOT CONNECTED — check GALATEA_TOKEN");
  });
});
