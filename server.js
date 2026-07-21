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
const dy = require("./lib/cdp-douyin.cjs");  // 抖音 CDP

const COOKIE = process.env.NETEASE_COOKIE || "";
const HOST_COOKIE = process.env.NCM_HOST_COOKIE || COOKIE; // VIP 房主 cookie，用于加歌/切歌（客人无权限）
const MT_COOKIE = process.env.MEITUAN_COOKIE || "";
const TB_COOKIE = process.env.TAOBAO_COOKIE || "";
const PORT = process.env.PORT || 3000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const OB_URL = "http://127.0.0.1:18001/mcp";  // Ombre-Brain 记忆库
const GALATEA_URL = "https://galatea.abysslumina.com/mcp";
const GALATEA_TOKEN = process.env.GALATEA_TOKEN || "gg_nj2lRj6A84VrPvycdireDyGAaT7RduOUBHYEXuN-uGM";

// ─── Ombre-Brain 记忆库状态 ────────────────────────────────────
let obSessionId = null;
let obReady = false;
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
  { name: "ncm_switch_song", description: "Switch to a song (must already be in playlist). roomId auto-detects if omitted.", inputSchema: { type: "object", properties: { roomId: { type: "string" }, songId: { type: "string" } }, required: ["songId"] } },
  { name: "ncm_add_song", description: "Add songs to listen-together queue (comma-separated). roomId auto-detects.", inputSchema: { type: "object", properties: { roomId: { type: "string" }, songId: { type: "string" } }, required: ["songId"] } },
  { name: "ncm_heartbeat", description: "Manually start/stop heartbeat for a listen-together room.", inputSchema: { type: "object", properties: { roomId: { type: "string" }, action: { type: "string", description: "'start' or 'stop'" } }, required: ["roomId", "action"] } },
  // ── 网易云私信 ──
  { name: "ncm_send_message", description: "Send a private message to a Netease user.", inputSchema: { type: "object", properties: { userId: { type: "string", description: "User ID to message" }, msg: { type: "string", description: "Message content" } }, required: ["userId", "msg"] } },
  { name: "ncm_read_messages", description: "Read private message history with a user (to find listen-together invites).", inputSchema: { type: "object", properties: { userId: { type: "string" }, limit: { type: "number", default: 20 } }, required: ["userId"] } },
  { name: "ncm_message_list", description: "Get recent private message contact list.", inputSchema: { type: "object", properties: {}, required: [] } },
  // ── 美团 ──
  { name: "mt_search", description: "Search nearby shops on Meituan (food, grocery).", inputSchema: { type: "object", properties: { keyword: { type: "string" }, lat: { type: "string" }, lng: { type: "string" } }, required: ["keyword"] } },
  { name: "mt_addresses", description: "Get saved delivery addresses from Meituan.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "mt_menu", description: "Get full menu for a Meituan shop.", inputSchema: { type: "object", properties: { shopId: { type: "string" } }, required: ["shopId"] } },
  { name: "mt_order", description: "Order food via browser automation. Pass shopId + itemName (product name from menu). For example: itemName='桃桃茉莉冰茶'. After preview, reply '确认下单' to confirm.", inputSchema: { type: "object", properties: { shopId: { type: "string" }, itemId: { type: "string", description: "Product ID (legacy)" }, itemName: { type: "string", description: "Product name to find and click on the page (e.g. '桃桃茉莉冰茶')" }, skuId: { type: "string" }, addressId: { type: "string" }, quantity: { type: "number", default: 1 }, attrIds: { type: "array", items: { type: "number" } }, remark: { type: "string" } }, required: ["shopId"] } },
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
        if (!args.songId) return "❌ 缺少 songId — 先用 ncm_search 搜歌获取 ID";
        const roomId = args.roomId || [...heartbeatRooms.keys()][0];
        if (!roomId) return "❌ 不在任何一起听房间 — 先接受邀请加入房间";
        await playCommandReport(roomId, args.songId, "0", "playing", HOST_COOKIE);
        const r = heartbeatRooms.get(roomId);
        if (r) r.songId = args.songId;
        return `🔀 已切歌 → ${args.songId}（实时生效）`;
      }
      case "ncm_add_song": {
        if (!args.songId) return "❌ 缺少 songId — 先用 ncm_search 搜歌获取 ID";
        const songIds = args.songId.split(",").map(s => s.trim()).filter(Boolean);
        if (!songIds.length) return "❌ songId 格式错误";
        const roomId = args.roomId || [...heartbeatRooms.keys()][0];
        if (!roomId) return "❌ 不在任何一起听房间 — 先接受邀请加入房间";
        await addSongToList(roomId, songIds, HOST_COOKIE);
        return `➕ 已加歌到房间队列: ${songIds.join(", ")}（⚠️ 需清 APP 后台重进才能同步列表，之后用 ncm_switch_song 切歌）`;
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
      case "mt_menu": {
        // CDP: 搜店名点进去拿菜单
        const shopName = args.shopName || args.shopId || "";
        try {
          const cdpResult = await cdp.mtMenu(shopName);
          if (cdpResult.source === "real") return JSON.stringify(cdpResult);
        } catch (e) { console.error("[mt_menu] CDP failed:", e.message); }
        // fallback: API
        if (args.shopId) return JSON.stringify(await mtShopMenu(args.shopId));
        return JSON.stringify({ source: "error", reason: "need shopName or shopId" });
      }
      case "mt_order": {
        // 🔥 直接走 API 下单（CDP 浏览器常被美团风控）
        const shopId = args.shopId || "";
        const itemId = args.itemId || "";
        const skuId = args.skuId || itemId;
        const addrId = args.addressId || "1950000001"; // 默认"宋-黎先菜店"
        if (!shopId || !itemId) return JSON.stringify({ source: "error", reason: "需要 shopId 和 itemId/skuId（从 mt_search 结果中获取）" });

        const order = await mtPlaceOrder(shopId, itemId, skuId, addrId, args.quantity || 1, args.attrIds || [], args.remark || "");

        if (order.source === "real" && order.step === "created") {
          const payUrl = order.payUrl || "";
          return JSON.stringify({
            ...order,
            hint: payUrl ? `💳 订单已创建！[点此付款](${payUrl})` : "订单已创建，请打开美团App付款",
          });
        }
        if (order.source === "real") {
          return JSON.stringify({ ...order, hint: `预览成功。实付 ¥${order.totalPrice}。再调一次 mt_order 确认下单。` });
        }
        return JSON.stringify(order);
      }
      case "mt_addresses": {
        const addrs = await mtGetAddresses();
        return JSON.stringify(addrs);
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
    // Root: health check / redirect
    if (req.method === "GET" && path === "/") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, server: "Yuuke MCP v4.3", mcp: "/api/mcp" })); return; }
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
  console.log("   🎵 NCM Tools: playlists | ncm_search | ncm_accept_invite | ncm_send_message + 7 more");
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
