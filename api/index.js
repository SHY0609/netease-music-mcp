import { randomUUID } from "node:crypto";
import { BG_IMAGE } from "../lib/bg.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { getMtgsig } = require("../lib/mt-signer-v2.cjs");
const BUILD_ID = randomUUID().slice(0, 8);
const COOKIE = process.env.NETEASE_COOKIE || "";
const MT_COOKIE = process.env.MEITUAN_COOKIE || "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const REF = "https://music.163.com/";
const H = { "User-Agent": UA, "Referer": REF, cookie: COOKIE };

function fm(s) { const m = Math.floor((s||0)/60), sec = Math.floor((s||0)%60); return m+":"+(sec<10?"0":"")+sec; }

// Vercel is US-based; weapi endpoints are blocked for non-CN IPs.

async function apiGet(path) {
  const res = await fetch(`https://music.163.com${path}`, { headers: H });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Netease`);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Netease non-JSON: ${text.slice(0, 200)}`); }
}

// ─── player state (file-backed + in-memory hybrid) ──
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
const STATE_FILE = join(tmpdir(), "netease-player-state.json");
const EMPTY_STATE = () => ({ queue: [], current: null, status: "idle", currentTime: 0, lyrics: null, _mcpSetAt: 0 });

let _state = null;
async function getPlayer() {
  if (_state) return _state;
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    _state = JSON.parse(raw);
    if (!_state._mcpSetAt) _state._mcpSetAt = 0;
    return _state;
  } catch {
    _state = EMPTY_STATE();
    return _state;
  }
}
async function saveState() {
  if (!_state) return;
  try { await writeFile(STATE_FILE, JSON.stringify(_state), "utf8"); } catch {}
}
// Mark state as recently set by MCP — player sync won't overwrite for 6s
function mcpTouch() {
  _state._mcpSetAt = Date.now();
}
// Player syncs its full state → server updates from player (authoritative)
function mergeFromPlayer(data) {
  if (!data) return;
  if (data.songId) {
    // Don't let player sync overwrite a recent MCP-set song (avoid feedback loop)
    const mcpRecent = (Date.now() - _state._mcpSetAt) < 6000;
    const songChanged = !_state.current || _state.current.id !== data.songId;
    if (mcpRecent && songChanged && _state.current?.id) {
      // MCP just set a different song — keep MCP's choice, but update time
      if (data.time !== undefined) _state.currentTime = Number(data.time) || 0;
      // Still merge queue but don't overwrite current song
    } else if (songChanged) {
      _state.current = {
        id: data.songId,
        name: data.name || "Unknown",
        artist: data.artist || "",
        album: data.album || "",
        coverUrl: data.coverUrl || "",
        durationMs: data.durationMs || 0,
        playUrl: data.playUrl || "",
      };
      _state.currentTime = 0;
      _state.lyrics = null;
    } else if (data.time !== undefined) {
      _state.currentTime = Number(data.time) || 0;
    }
    if (!_state.status || _state.status === "idle") _state.status = "playing";
  } else if (data.time !== undefined) {
    _state.currentTime = Number(data.time) || 0;
  }
  // Merge queue from player
  if (data.queue && Array.isArray(data.queue) && data.queue.length > 0) {
    const merged = [];
    const seen = new Set();
    for (const s of data.queue) {
      if (!s.id) continue;
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      // Prefer existing server entry if available (has more metadata)
      const existing = _state.queue.find(q => q.id === s.id);
      merged.push(existing || { id: s.id, name: s.name || "", artist: s.artist || "", coverUrl: s.coverUrl || "", durationMs: s.durationMs || 0, album: s.album || "", playUrl: s.playUrl || "" });
    }
    // Keep current song at front
    if (data.songId && merged.length > 0) {
      const curIdx = merged.findIndex(s => s.id === data.songId);
      if (curIdx > 0) {
        const [cur] = merged.splice(curIdx, 1);
        merged.unshift(cur);
      }
    }
    _state.queue = merged;
  }
}

// ─── lyrics parser ─────────────────────────────────────────
function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const matches = [...raw.matchAll(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = raw.replace(/\[[^\]]+]/g, "").trim();
    for (const m of matches) {
      const min = Number(m[1]), sec = Number(m[2]), frac = (Number(m[3] || "0".padEnd(3, "0")) / 1000) || 0;
      lines.push({ time: min * 60 + sec + frac, text });
    }
  }
  return lines.filter(l => l.text).sort((a, b) => a.time - b.time);
}
function lyricsAround(lines, time, n = 4) {
  let idx = lines.findIndex(l => l.time >= time);
  if (idx < 0) idx = Math.max(0, lines.length - n);
  return { past: lines.slice(Math.max(0, idx - 1), idx).map(l => l.text), current: lines[idx]?.text || "", upcoming: lines.slice(idx + 1, idx + 1 + n).map(l => l.text) };
}

// ─── netease helpers (old API, GET) ────────────────────────
async function getLyricsRaw(id) {
  try {
    const r = await apiGet(`/api/song/lyric?id=${id}&lv=1&tv=1`);
    return (r.lrc?.lyric || "") + "\n" + (r.tlyric?.lyric || "");
  } catch { return ""; }
}

function extractCover(s) {
  // Try direct picUrl from album or song
  const direct = (s.album || s.al || {}).picUrl || s.picUrl;
  if (direct) return direct;
  // Construct from pic_id + pic_str: https://p2.music.126.net/<str>/<id>.jpg
  const al = s.album || s.al || {};
  const picId = al.pic || al.picId || s.picId || al.pic_id;
  const picStr = al.pic_str || al.picUrl_str || s.pic_str;
  if (picId && picStr) return `https://p2.music.126.net/${picStr}/${picId}.jpg`;
  if (picId) return `https://p2.music.126.net/${picId}.jpg`;
  return "";
}
async function searchSongs(kw, limit = 5) {
  const r = await apiGet(`/api/search/get?s=${encodeURIComponent(kw)}&type=1&limit=${limit}`);
  return (r.result?.songs || []).map(s => ({
    id: String(s.id), name: s.name || s.songName || ("Song " + s.id),
    artist: (s.artists || s.ar || (s.artist ? [s.artist] : [])).map(a => typeof a === "string" ? a : (a.name || "")).join(" / ") || "未知歌手",
    album: (s.album || s.al || {}).name || "",
    coverUrl: extractCover(s),
    durationMs: s.duration || s.dt || 0,
  }));
}

async function getSongUrl(id) {
  // Try multiple sources in parallel, return first valid URL
  const candidates = [];

  // 1. Old API — standard quality (most compatible)
  try {
    const r = await apiGet(`/api/song/enhance/player/url?ids=[${id}]&br=320000`);
    const url = r.data?.[0]?.url;
    if (url) candidates.push(url.replace(/^http:\/\//, "https://"));
  } catch {}

  // 2. Old API — lower quality fallback (128kbps, may work when 320k fails)
  if (!candidates.length) {
    try {
      const r = await apiGet(`/api/song/enhance/player/url?ids=[${id}]&br=128000`);
      const url = r.data?.[0]?.url;
      if (url) candidates.push(url.replace(/^http:\/\//, "https://"));
    } catch {}
  }

  // 3. Old API v1 endpoint (newer, may have different availability)
  if (!candidates.length) {
    try {
      const r = await apiGet(`/api/song/enhance/player/url/v1?ids=[${id}]&level=standard&encodeType=mp3`);
      const url = r.data?.[0]?.url;
      if (url) candidates.push(url.replace(/^http:\/\//, "https://"));
    } catch {}
  }

  // 4. Outer URL fallback (no auth needed, works for free songs)
  if (!candidates.length) {
    try {
      const r = await fetch(`https://music.163.com/song/media/outer/url?id=${id}`, {
        headers: { ...H, Referer: "https://music.163.com/" }, redirect: "manual",
      });
      const loc = r.headers.get("location") || "";
      if (loc && !loc.includes("/404")) candidates.push(loc.replace(/^http:\/\//, "https://"));
    } catch {}
  }

  return candidates[0] || "";
}

async function getPlaylists() {
  const r = await apiGet("/api/user/playlist?uid=0&limit=50&offset=0");
  return (r.playlist || []).map(p => ({ id: String(p.id), name: p.name, trackCount: p.trackCount }));
}

async function getPlaylistDetail(id, offset = 0) {
  const r = await apiGet(`/api/v6/playlist/detail?id=${id}&n=200&s=${offset}`);
  const p = r.playlist || {};
  // Prefer full track objects if available and non-empty
  let tracks = [];
  if (p.tracks && p.tracks.length > 0) {
    tracks = p.tracks.map(s => ({
      id: String(s.id), name: s.name,
      artist: (s.artists || s.ar || []).map(a => a.name).join(" / "),
      album: (s.album || s.al || {}).name || "",
      coverUrl: (s.album || s.al || {}).picUrl || "",
      durationMs: s.duration || s.dt || 0,
    }));
  } else if (p.trackIds && p.trackIds.length > 0) {
    // trackIds format: [{id, v, ...}, ...] or plain numbers
    const ids = p.trackIds.map(t => typeof t === "object" ? String(t.id) : String(t)).slice(0, 50);
    // Batch fetch song details
    try {
      const detailR = await apiGet(`/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify(ids.map(id => ({id: Number(id)}))))}`);
      if (detailR.code === 200 && detailR.songs) {
        tracks = ids.map(id => {
          const s = detailR.songs.find(song => String(song.id) === id);
          if (s) return {
            id: String(s.id), name: s.name,
            artist: (s.ar || []).map(a => a.name).join(" / "),
            album: (s.al || {}).name || "",
            coverUrl: (s.al || {}).picUrl || "",
            durationMs: s.dt || 0,
          };
          return { id, name: `Song ${id}`, artist: "", album: "", coverUrl: "", durationMs: 0 };
        });
      }
    } catch {
      tracks = ids.map(id => ({ id, name: `Song ${id}`, artist: "", album: "", coverUrl: "", durationMs: 0 }));
    }
  }
  return { name: p.name || "(unnamed)", trackCount: p.trackCount || tracks.length, tracks };
}


// ─── meituan helpers — real API via /openh5/search/globalpage ──
// _token = base64(zlib.deflate(json_string))
function mtMakeToken(data) {
  const json = JSON.stringify(data);
  const deflated = deflateSync(Buffer.from(json, "utf8"));
  return deflated.toString("base64");
}

const MT_HEADERS = { "User-Agent": UA, "Referer": "https://h5.waimai.meituan.com/", "Accept": "application/json", "Origin": "https://h5.waimai.meituan.com" };

function mtDiagnose(result, cookiePresent) {
  if (!cookiePresent) return "no_cookie";
  if (!result) return "no_response";
  if (result.status === 403) return "upstream_403";
  if (result.status !== 200) return "http_" + result.status;
  if (!result.data || result.data.code !== 0) return "empty_payload";
  return null;
}

async function mtGetSign(url, bodyString) {
  try {
    const fullUrl = url + (url.includes("?") ? "&" : "?") +
      "yodaReady=h5&csecplatform=4&csecversion=4.2.4&_=" + Date.now();
    const sig = await getMtgsig(fullUrl, bodyString || "", MT_COOKIE);
    if (!sig) console.error("mtgsig: empty signature returned");
    return { mtgsig: sig, signedUrl: fullUrl };
  } catch (e) {
    console.error("mtgsig error:", e.message, e.stack?.slice(0, 200));
    return { mtgsig: "", signedUrl: url };
  }
}

async function mtApi(path, opts) {
  if (!MT_COOKIE) return null;
  try {
    const url = "https://i.waimai.meituan.com" + path;
    const bodyStr = opts?.body || "";
    const { mtgsig, signedUrl } = await mtGetSign(url, bodyStr);

    const baseHeaders = {
      ...MT_HEADERS,
      cookie: MT_COOKIE,
      "Accept-Language": "zh-CN,zh;q=0.9",
      "sec-ch-ua": "\"Chromium\";v=\"9\", \"Not?A_Brand\";v=\"8\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"Windows\"",
    };
    if (mtgsig) baseHeaders["mtgsig"] = mtgsig;

    // 合并 headers: opts.headers 作为基础, baseHeaders 覆盖（确保 mtgsig 不被覆盖）
    const mergedHeaders = { ...(opts.headers || {}), ...baseHeaders };
    const { headers: _, ...restOpts } = opts;
    const res = await fetch(signedUrl, { headers: mergedHeaders, ...restOpts });
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
    catch { return { ok: false, status: res.status, raw: text.slice(0, 500) }; }
  } catch (e) { return null; }
}

async function mtSearch(keyword, lat, lng) {
  const hasCookie = !!MT_COOKIE;
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

  const reason = mtDiagnose(result, hasCookie);
  if (reason) {
    return {
      source: "error", reason: reason, keyword: keyword,
      hint: reason === "no_cookie" ? "请设置 MEITUAN_COOKIE 环境变量" :
            "美团 API 暂时不可用，请稍后重试"
    };
  }

  // Parse shops from response
  const modules = result.data?.data?.module_list || [];
  const shops = [];
  for (const m of modules) {
    try {
      const d = JSON.parse(m.string_data || "{}");
      const products = (d.product_list || []).map(function(p) { return {
        id: String(p.product_spu_id || ""), name: p.product_name || "",
        price: p.price || p.activity_info?.activity_price || "", monthSales: p.month_sales || 0,
        pic: p.picture || ""
      }});
      shops.push({
        id: d.poi_id_str || "", name: d.name || "",
        addr: d.address || "", score: d.wm_poi_score || "",
        distance: d.distance || "", deliveryTime: d.delivery_time_tip || "",
        shippingFee: d.shipping_fee_tip || "", minPrice: d.min_price_tip || "",
        monthSales: d.month_sales_tip || "", products: products.slice(0, 5)
      });
    } catch {}
  }

  return { source: "real", keyword: keyword, count: shops.length, shops: shops.slice(0, 15) };
}

async function mtGetAddresses() {
  if (!MT_COOKIE) return { source: "error", reason: "no_cookie" };
  try {
    const result = await mtApi("/openh5/address/list", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        wm_latitude: "28673167",
        wm_longitude: "115887078",
        openh5_uuid: "7AEEA19018B2ABFC1C9F22CD67DB9A5389DB8A00850295DFC687E1F16155F59C",
      }).toString(),
    });

    const rawStr = JSON.stringify(result?.data || result?.raw || "").slice(0, 600);
    if (result && result.ok && result.data) {
      const d = result.data.data || result.data;
      const list = d?.addressList || d?.address_list || d?.list || d?.addresses || [];
      const addresses = (Array.isArray(list) ? list : []).map(a => ({
        id: String(a.addressId || a.address_id || a.id || ""),
        name: a.name || a.contact_name || "",
        phone: a.phone || a.contact_phone || "",
        address: a.poi || a.address || a.poi_address || "",
        lat: String(a.lat || a.latitude || ""),
        lng: String(a.lng || a.longitude || ""),
        gender: a.gender || "",
      }));
      return { source: "real", count: addresses.length, addresses, raw: rawStr };
    }
    return { source: "error", reason: "api_failed", count: 0, addresses: [], raw: rawStr, httpStatus: result?.status };
  } catch (e) {
    return { source: "error", reason: "api_error", hint: e.message };
  }
}

async function mtShopMenu(shopId) {
  if (!MT_COOKIE || !shopId) return { source: "error", reason: "need shopId" };
  const uuid = "7AEEA19018B2ABFC1C9F22CD67DB9A5389DB8A00850295DFC687E1F16155F59C";

  // 尝试获取菜单 tag
  let tagId = "";
  try {
    const tagRes = await mtApi("/openh5/v2/poi/menutags", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        wm_poi_id: "-100", poi_id_str: shopId,
        wm_latitude: "28673167", wm_longitude: "115887078",
        openh5_uuid: uuid, uuid: uuid,
        platform: "3", partner: "4",
      }).toString(),
    });
    if (tagRes?.data?.code === 0) {
      const tags = tagRes.data.data?.tag_list || tagRes.data.data?.tags || [];
      if (tags.length > 0) tagId = String(tags[0].tag_id || tags[0].id || "");
    }
  } catch {}
  if (!tagId) tagId = "914597353";

  const result = await mtApi("/openh5/v2/poi/menuproducts", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      wm_poi_id: "-100", poi_id_str: shopId,
      spu_tag_id: tagId,
      support_new_page_v3: "true",
      sort_type: "1", tag_type: "1",
      wm_latitude: "28673167", wm_longitude: "115887078",
      wm_actual_latitude: "28673167", wm_actual_longitude: "115887078",
      wmUuidDeregistration: "0", wmUserIdDeregistration: "0",
      openh5_uuid: uuid, uuid: uuid,
      platform: "3", partner: "4",
    }).toString(),
  });

  const rawStr = JSON.stringify(result?.data || "").slice(0, 800);
  if (result && result.ok && result.data?.code === 0) {
    const d = result.data.data || {};
    const list = d.spu_list || d.spuList || d.product_spu_list || d.product_spu_list || d.list || [];
    const items = (Array.isArray(list) ? list : []).slice(0, 15).map(spu => {
      // 从 SPU attrs 里取第一个 value 的 id 作为默认 attr_ids
      const defaultAttrIds = (spu.attrs || []).flatMap(a =>
        (a.values || []).slice(0, 1).map(v => v.id)
      );
      return {
        id: String(spu.spu_id || spu.id || spu.product_spu_id || ""),
        name: spu.name || spu.spu_name || spu.product_name || "",
        price: spu.price || spu.min_price || spu.current_price || spu.currentPrice || "",
        attrIds: defaultAttrIds,
        skus: (spu.sku_list || spu.skus || []).map(sku => ({
          id: String(sku.sku_id || sku.id || ""),
          name: sku.name || sku.sku_name || sku.spec || "",
          price: sku.price || spu.min_price || "",
        })),
      };
    });
    return { source: "real", count: items.length, products: items.slice(0, 10), raw: rawStr };
  }
  return { source: "error", reason: "menu_failed", raw: rawStr, httpStatus: result?.status };
}

async function mtPlaceOrder(shopId, itemId, addressId, quantity, attrIds, remark) {
  if (!MT_COOKIE) return { source: "error", reason: "no_cookie" };
  if (!shopId || !itemId) return { source: "error", reason: "shopId and itemId required" };

  const qty = quantity || 1;
  const uuid = "7AEEA19018B2ABFC1C9F22CD67DB9A5389DB8A00850295DFC687E1F16155F59C";
  const now = Date.now();

  // 用真实抓包参数格式: /openh5/order/v2/preview
  const orderData = {
    wm_poi_id: "-100",
    poi_id_str: shopId,
    wm_order_pay_type: 2,
    cart_id: "",
    foodlist: [{
      skuId: Number(itemId),
      id: Number(itemId),
      count: qty,
      attr_ids: attrIds || [],
      activityTag: "",
      remark: remark || "",
    }],
    expected_arrival_time: 0,
    lat: 0, lng: 0,
    orderToken: "",
    nb_app: "wap",
    pay_sdk_version: "1.1.8",
    callback_info: { activity_callback_info: "" },
    accepted_select_coupon: [],
    addr_longitude: 0, addr_latitude: 0,
    recipient_name: "", recipient_phone: "", recipient_gender: "", recipient_address: "",
    house_number: {},
    addr_id: addressId ? Number(addressId) : 0,
    wx_pay_params: { orderPayChannel: 1 },
    ext_param: { sqt_scene: "", sqtToken: "" },
    info: { time: Math.floor(Date.now() / 1000), channel: 1001, ctime: Math.floor(Date.now() / 1000), logType: "S", cType: "andriod" },
    wm_open_id: "",
  };

  const bodyParams = new URLSearchParams({
    data: JSON.stringify(orderData),
    wm_latitude: "28673167", wm_longitude: "115887078",
    wm_actual_latitude: "28673167", wm_actual_longitude: "115887078",
    wmUuidDeregistration: "0", wmUserIdDeregistration: "0",
    openh5_uuid: uuid, uuid: uuid,
  }).toString();

  const result = await mtApi("/openh5/order/v2/preview", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: bodyParams,
  });

  const rawStr = JSON.stringify(result?.data || "").slice(0, 600);
  if (result && result.ok && result.data?.code === 0) {
    const d = result.data.data || {};
    return {
      source: "real",
      step: "preview",
      totalPrice: d.totalPrice || d.total_price || d.total || "",
      deliveryFee: d.deliveryFee || d.delivery_fee || d.shipping_fee || "",
      discount: d.discount || "",
      foodTotal: d.foodTotal || d.food_total || d.productTotal || "",
      raw: rawStr,
    };
  }
  return { source: "error", reason: "preview_failed", raw: rawStr, httpStatus: result?.status };
}

async function mtOrderSubmit(shopId, itemId, addressId, quantity, attrIds, remark, recipientName, recipientPhone, recipientAddress) {
  if (!MT_COOKIE) return { source: "error", reason: "no_cookie" };
  if (!shopId || !itemId || !addressId) return { source: "error", reason: "shopId, itemId, and addressId required" };

  const uuid = "7AEEA19018B2ABFC1C9F22CD67DB9A5389DB8A00850295DFC687E1F16155F59C";
  const qty = quantity || 1;

  const orderData = {
    wm_poi_id: "-100",
    poi_id_str: shopId,
    wm_order_pay_type: 2,
    cart_id: "",
    foodlist: [{
      skuId: Number(itemId),
      id: Number(itemId),
      count: qty,
      attr_ids: attrIds || [],
      activityTag: "",
      remark: remark || "",
    }],
    expected_arrival_time: 0,
    lat: 0, lng: 0,
    orderToken: "",
    nb_app: "wap",
    pay_sdk_version: "1.1.8",
    callback_info: { activity_callback_info: "" },
    accepted_select_coupon: [],
    addr_longitude: 0, addr_latitude: 0,
    recipient_name: recipientName || "",
    recipient_phone: recipientPhone || "",
    recipient_gender: "",
    recipient_address: recipientAddress || "",
    house_number: {},
    addr_id: Number(addressId),
    wx_pay_params: { orderPayChannel: 1 },
    ext_param: { sqt_scene: "", sqtToken: "" },
    info: { time: Math.floor(Date.now() / 1000), channel: 1001, ctime: Math.floor(Date.now() / 1000), logType: "S", cType: "andriod" },
    wm_open_id: "",
  };

  const bodyParams = new URLSearchParams({
    data: JSON.stringify(orderData),
    wm_latitude: "28673167", wm_longitude: "115887078",
    wm_actual_latitude: "28673167", wm_actual_longitude: "115887078",
    wmUuidDeregistration: "0", wmUserIdDeregistration: "0",
    openh5_uuid: uuid, uuid: uuid,
  }).toString();

  const result = await mtApi("/openh5/order/v2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: bodyParams,
  });

  const rawStr = JSON.stringify(result?.data || "").slice(0, 600);
  if (result && result.ok && result.data?.code === 0) {
    const d = result.data.data || {};
    return {
      source: "real",
      step: "submitted",
      orderId: d.orderId || d.order_id || d.orderIdStr || "",
      totalPrice: d.totalPrice || d.total || d.total_price || "",
      status: d.status || d.orderStatus || "",
      payUrl: d.payUrl || d.pay_url || "",
      raw: rawStr,
    };
  }
  return { source: "error", reason: "submit_failed", raw: rawStr, httpStatus: result?.status };
}

async function addToPlaylist(pid, songId) {
  // trackIds MUST be JSON array format: "[123456]" — verified 2025-06-20
  const res = await fetch("https://music.163.com/api/playlist/manipulate/tracks", {
    method: "POST",
    headers: { ...H, "content-type": "application/x-www-form-urlencoded" },
    body: `op=add&pid=${encodeURIComponent(pid)}&trackIds=${encodeURIComponent(`[${String(songId)}]`)}`,
  });
  const r = await res.json();
  if (r.code !== 200) throw new Error(r.message || r.msg || `add failed (code=${r.code})`);
  return true;
}

// ─── MCP (lightweight JSON‑RPC) ────────────────────────────
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const txt = (id, text) => ok(id, { content: [{ type: "text", text }] });

const mcpInfo = {
  protocolVersion: "2024-11-05",
  serverInfo: { name: "home", version: "2.0.0" },
  capabilities: { tools: {} },
};

const tools = [
  { name: "play", description: "Search and play a song. AI constructs the keyword freely.",
    inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] } },
  { name: "skip", description: "Skip to next song.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "pause", description: "Toggle pause/resume.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "queue", description: "View current queue.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "playlists", description: "Get your NetEase playlists.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "add_to_playlist", description: "Add current song to a playlist.",
    inputSchema: { type: "object", properties: { songId: { type: "string" }, playlistId: { type: "string" } }, required: ["playlistId"] } },
  { name: "playlist_tracks", description: "Get tracks in a playlist. Supports pagination via offset.",
    inputSchema: { type: "object", properties: { playlistId: { type: "string" }, offset: { type: "number", default: 0 } }, required: ["playlistId"] } },
  { name: "mt_search", description: "Search nearby shops on Meituan (food, grocery, etc.)",
    inputSchema: { type: "object", properties: { keyword: { type: "string" }, lat: { type: "string" }, lng: { type: "string" } }, required: ["keyword"] } },
  { name: "mt_addresses", description: "Get your saved delivery addresses from Meituan.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "mt_menu", description: "Get full menu/products for a Meituan shop.",
    inputSchema: { type: "object", properties: { shopId: { type: "string" } }, required: ["shopId"] } },
  { name: "mt_order", description: "Preview or confirm a Meituan order. Call first without confirm to see price, then with confirm=true to submit.",
    inputSchema: { type: "object", properties: { shopId: { type: "string" }, itemId: { type: "string" }, addressId: { type: "string" }, quantity: { type: "number", default: 1 }, attrIds: { type: "array", items: { type: "number" } }, confirm: { type: "boolean", default: false } }, required: ["shopId", "itemId"] } },
  { name: "current_song", description: "Get current song info, playback position, and lyrics around current position. AI can see what you're hearing right now.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "lyrics", description: "Get full lyrics for the current or specified song.",
    inputSchema: { type: "object", properties: { songId: { type: "string" } }, required: [] } },
];

async function execTool(name, args) {
  const p = await getPlayer();
  try {
    switch (name) {
      case "play": {
        const songs = await searchSongs(args.keyword, 8);
        if (!songs.length) return `No results for "${args.keyword}"`;
        // Pick first result; player resolves URL on its side (avoids filtering out correct songs)
        const pick = songs[0];
        // Fallback: try song detail API if search didn't return cover
        let cover = pick.coverUrl;
        if (!cover) {
          try {
            const detailR = await apiGet(`/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify([{id:Number(pick.id)}]))}`);
            const ds = detailR.songs?.[0];
            if (ds) cover = extractCover(ds) || (ds.al || {}).picUrl || "";
          } catch {}
        }
        p.current = { id: pick.id, name: pick.name, artist: pick.artist, album: pick.album, coverUrl: cover, durationMs: pick.durationMs, playUrl: "" };
        p.status = "playing";
        if (!p.queue.find(q => q.id === pick.id)) p.queue.unshift({ id: pick.id, name: pick.name, artist: pick.artist, coverUrl: cover, durationMs: pick.durationMs });
        mcpTouch(); await saveState();
        return `🎵 ${pick.name} - ${pick.artist}`;
      }
      case "skip":
        if (p.queue.length > 1) {
          p.queue.shift(); p.current = p.queue[0]; p.current.playUrl = "";
          p.status = "playing";
          mcpTouch(); await saveState();
          return `⏭ ${p.current.name} - ${p.current.artist}`;
        }
        if (p.current?.id) {
          // Replay current from start
          p.status = "playing";
          p.current.playUrl = "";
          mcpTouch(); await saveState();
          return `🔄 Replaying ${p.current.name} - ${p.current.artist}`;
        }
        p.status = "idle";

        return "Queue empty";
      case "pause":
        p.status = p.status === "paused" ? "playing" : "paused";

        return p.status === "paused" ? "⏸ Paused" : "▶ Playing";
      case "queue":
        return JSON.stringify({ current: p.current?.name || null, count: p.queue.length, status: p.status });
      case "playlists": {
        const pl = await getPlaylists();
        return JSON.stringify(pl);
      }
      case "add_to_playlist": {
        const sid = args.songId || p.current?.id;
        if (!sid) return "No song to add";
        await addToPlaylist(args.playlistId, sid);
        const pls = await getPlaylists();
        const t = pls.find(pl => pl.id === String(args.playlistId));
        return `✅ Added to「${t?.name || args.playlistId}」`;
      }
      case "playlist_tracks": {
        const d = await getPlaylistDetail(args.playlistId, args.offset || 0);
        return JSON.stringify(d);
      }
      case "mt_search": {
        const result = await mtSearch(args.keyword, args.lat, args.lng);
        return JSON.stringify(result);
      }
      case "mt_addresses": {
        const addrs = await mtGetAddresses();
        return JSON.stringify(addrs);
      }
      case "mt_menu": {
        const menu = await mtShopMenu(args.shopId);
        return JSON.stringify(menu);
      }
      case "mt_order": {
        const confirm = args.confirm || false;
        const remark = args.remark || "";
        if (confirm && args.addressId) {
          // 真正提交订单！
          const order = await mtOrderSubmit(args.shopId, args.itemId, args.addressId,
            args.quantity || 1, args.attrIds || [], remark, "", "", "");
          return JSON.stringify(order);
        }
        // 默认：preview 模式
        const order = await mtPlaceOrder(args.shopId, args.itemId, args.addressId || "",
          args.quantity || 1, args.attrIds || [], remark);
        if (order.source === "real") {
          return `💰 预览订单\n商品: ${args.itemId}\n实付: ¥${order.totalPrice}\n配送费: ¥${order.deliveryFee}\n备注: ${remark || "无"}\n\n确认下单请提供收货地址并设置 confirm=true`;
        }
        return JSON.stringify(order);
      }
      case "current_song": {
        if (!p.current) return "No song playing";
        // Fetch lyrics if not cached
        if (!p.lyrics || p.lyrics._id !== p.current.id) {
          const lrc = await getLyricsRaw(p.current.id);
          p.lyrics = { _id: p.current.id, lines: parseLrc(lrc) };
        }
        const around = lyricsAround(p.lyrics.lines, p.currentTime || 0, 4);
        return JSON.stringify({
          name: p.current.name, artist: p.current.artist,
          position: fm(p.currentTime || 0),
          positionSec: p.currentTime || 0,
          lyricsContext: around,
        });
      }
      case "lyrics": {
        const id = args.songId || p.current?.id;
        if (!id) return "No song specified";
        const lrc = await getLyricsRaw(id);
        return lrc || "(no lyrics available)";
      }
      default: return "Unknown tool";
    }
  } catch (e) {
    return `❌ ${e.message}`;
  }
}

async function handleMcpMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;
  if (!method) return null;
  try {
    if (method === "initialize") return ok(id, mcpInfo);
    if (method === "notifications/initialized") return null;
    if (method === "tools/list") return ok(id, { tools });
    if (method === "tools/call") return txt(id, await execTool(params.name, params.arguments || {}));
    if (method === "ping") return ok(id, {});
    return txt(id, `Unknown method: ${method}`);
  } catch (e) {
    return txt(id, `❌ ${e.message}`);
  }
}

// ─── player HTML ───────────────────────────────────────────
function playerHtml(state) {
  const initJson = JSON.stringify({ current: state?.current || null, queue: (state?.queue || []).slice(0, 20), status: state?.status || "idle", mcpSetAt: state?._mcpSetAt || 0 });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover"/><meta name="referrer" content="no-referrer"/><title>🎵 v2.3 Claude 音乐</title><meta http-equiv="cache-control" content="no-cache, no-store, must-revalidate"/><meta http-equiv="pragma" content="no-cache"/><meta http-equiv="expires" content="0"/><style>*{margin:0;padding:0;box-sizing:border-box}:root{color-scheme:dark;--glass:rgba(20,20,20,0.55);--glassHover:rgba(30,30,30,0.65);--card:rgba(255,255,255,0.08);--muted:rgba(255,255,255,0.55);--accent:#eb8258;--accentGlow:rgba(235,130,88,0.3);--text:#f0ece6;--textDim:rgba(255,255,255,0.7)}body{background:var(--bg-color,#0d0d0d);color:var(--text);font-family:'SF Pro Display','PingFang SC',system-ui,sans-serif;min-height:100dvh;display:flex;flex-direction:column;align-items:center;padding:max(16px,4vw);-webkit-tap-highlight-color:transparent;position:relative;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;z-index:-2;background:url(__BG__) center/cover no-repeat}
body::after{content:'';position:fixed;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(0,0,0,0.35) 0%,rgba(0,0,0,0.55) 50%,rgba(0,0,0,0.75) 100%)}
h1{font-size:clamp(18px,4.5vw,24px);margin-bottom:4px;text-shadow:0 1px 3px rgba(0,0,0,.4)}.sub{color:var(--muted);font-size:13px;margin-bottom:18px}
.art{width:min(260px,62vw);aspect-ratio:1;border-radius:20px;object-fit:cover;background:var(--card);margin-bottom:16px;box-shadow:0 25px 50px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.06);transition:all .4s ease}
.art[src*='svg']{opacity:.5;transform:scale(.9)}
.info{text-align:center;margin-bottom:10px}.info .name{font-size:clamp(15px,3.6vw,20px);font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,.5)}.info .artist{color:var(--textDim);font-size:14px;margin-top:4px}
.progress-wrap{width:100%;max-width:min(340px,80vw);margin-bottom:6px}.progress-row{display:flex;align-items:center;gap:10px}.time{font-size:11px;color:var(--muted);min-width:36px;font-variant-numeric:tabular-nums}.time.end{text-align:right}.bar-wrap{flex:1;height:20px;display:flex;align-items:center;cursor:pointer;position:relative}.bar-bg{width:100%;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;overflow:visible}.bar-fill{height:100%;background:var(--accent);border-radius:2px;transition:width .15s linear;position:relative;box-shadow:0 0 8px var(--accentGlow)}.bar-fill::after{content:'';position:absolute;right:-6px;top:-4px;width:12px;height:12px;border-radius:50%;background:var(--accent);opacity:0;transition:opacity .2s;box-shadow:0 0 10px var(--accentGlow)}.bar-wrap:active .bar-fill::after{opacity:1}
.controls{display:flex;gap:22px;align-items:center;justify-content:center;margin-bottom:24px}.btn{border:none;border-radius:50%;display:grid;place-items:center;cursor:pointer;transition:all .2s;background:var(--glass);color:var(--text);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.08)}.btn:active{transform:scale(.92);opacity:.8}.btn.small{width:44px;height:44px}.btn.big{width:62px;height:62px;background:var(--accent);color:#fff;border:none;box-shadow:0 8px 25px var(--accentGlow)}.btn svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.btn.big svg{width:26px;height:26px;stroke-width:2.5;fill:currentColor}
.queue{width:100%;max-width:min(360px,85vw);margin-top:6px}.queue h3{font-size:13px;color:var(--muted);margin-bottom:8px;padding-left:4px}.queue-item{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:12px;margin-bottom:5px;background:var(--glass);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.04);transition:all .2s}.queue-item.active{background:rgba(235,130,88,0.15);border:1px solid rgba(235,130,88,0.3);box-shadow:0 0 20px rgba(235,130,88,0.1)}.queue-item img{width:40px;height:40px;border-radius:10px;object-fit:cover;background:rgba(255,255,255,.05);flex-shrink:0}.queue-item .qi{min-width:0}.queue-item .qname{font-size:13px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.queue-item .qart{font-size:11px;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.empty{color:var(--muted);font-size:13px;text-align:center;padding:20px}.status{font-size:11px;color:var(--muted);margin-top:6px;text-align:center}</style></head><body><h1>🎵 Claude 音乐</h1><div class="sub">v1.5.1 · 跟 Claude 说"放一首歌"试试<br><button id="testBtn" style="margin-top:8px;padding:8px 16px;border-radius:20px;border:1px solid var(--accent);background:transparent;color:var(--accent);font-size:13px;cursor:pointer">🧪 测试·3首连播</button></div><img class="art" id="art" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><rect fill='%231a1a1a' width='200' height='200'/><text fill='%23888' x='100' y='110' text-anchor='middle' font-size='40'>🎵</text></svg>"><div class="info"><div class="name" id="name">等待播放</div><div class="artist" id="artist">告诉 Claude 你想听什么</div></div><div class="progress-wrap"><div class="progress-row"><span class="time" id="curTime">0:00</span><div class="bar-wrap" id="barWrap"><div class="bar-bg"><div class="bar-fill" id="barFill" style="width:0%"></div></div></div><span class="time end" id="durTime">0:00</span></div></div><div class="controls"><button class="btn small" onclick="prev()"><svg viewBox="0 0 24 24"><polyline points="19 20 9 12 19 4"/><line x1="5" y1="19" x2="5" y2="5"/></svg></button><button class="btn big" id="playBtn" onclick="togglePlay()"><svg id="playIcon" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20"/></svg></button><button class="btn small" onclick="next()"><svg viewBox="0 0 24 24"><polyline points="5 4 15 12 5 20"/><line x1="19" y1="5" x2="19" y2="19"/></svg></button></div><div class="queue"><h3>📋 播放队列 <button onclick="clearQueue()" style="font-size:11px;padding:2px 10px;border-radius:10px;border:1px solid var(--muted);background:transparent;color:var(--muted);cursor:pointer;float:right">清空</button></h3><div id="queue"></div></div><div class="status" id="status">已连接</div><audio id="audio" style="display:none" preload="auto"></audio><script>window.__INIT__=${initJson.replace(/</g,"003c")};
const a=document.getElementById("audio");let currentId=null,resolvingUrl=null,lastQueueStr="",localQueue=[],playerActive=false;const LS_KEY="nm_player";function saveLocal(){try{localStorage.setItem(LS_KEY,JSON.stringify({q:localQueue,cid:currentId}));}catch(e){}}function loadLocal(){try{var d=JSON.parse(localStorage.getItem(LS_KEY)||"{}");if(d.q&&d.q.length){localQueue=d.q;currentId=d.cid;}}catch(e){}}
function fm(s){const m=Math.floor(s/60),sec=Math.floor(s%60);return m+":"+(sec<10?"0":"")+sec}
// Media Session
if("mediaSession" in navigator){navigator.mediaSession.setActionHandler("play",()=>a.play());navigator.mediaSession.setActionHandler("pause",()=>a.pause());navigator.mediaSession.setActionHandler("previoustrack",()=>prev());navigator.mediaSession.setActionHandler("nexttrack",()=>next());}
// Poll state
async function poll(){try{const r=await fetch("/api/state");if(!r.ok)return;const d=await r.json();render(d)}catch(e){}}
// Resolve URL (player-initiated, retries on next poll)
function resolveUrlFor(songId){if(!songId||resolvingUrl===songId)return;resolvingUrl=songId;document.getElementById("status").textContent="🔊 加载音频...";fetch("/api/url?id="+encodeURIComponent(songId)).then(r=>r.json()).then(j=>{if(j.playUrl&&currentId===songId){a.src=j.playUrl;a.play().catch(()=>{});document.getElementById("status").textContent="▶ 播放中"}else if(currentId===songId){document.getElementById("status").textContent="⚠ 无播放链接";}resolvingUrl=null;}).catch(()=>{resolvingUrl=null;document.getElementById("status").textContent="⚠ 加载失败·稍后重试"});}
function render(d){var clearedAt=parseInt(localStorage.getItem('nm_clearedAt')||'0');if(clearedAt&&(Date.now()-clearedAt<5000))return;if(clearedAt)localStorage.removeItem('nm_clearedAt');
  // Merge new songs from server into local queue (don't overwrite, don't switch)
  if(d.current&&d.current.id){
    var exists=localQueue.some(function(t){return t.id===d.current.id});
    if(!exists){localQueue.push({id:d.current.id,name:d.current.name,artist:d.current.artist,coverUrl:d.current.coverUrl,durationMs:d.current.durationMs});}
  }
  if(d.queue&&d.queue.length>0){
    for(var i=0;i<d.queue.length;i++){var s=d.queue[i];if(!localQueue.some(function(t){return t.id===s.id})){localQueue.push(s);}}
  }
  // Auto-switch: nothing playing OR server has new MCP command
  var lastMcp=0;try{lastMcp=parseInt(localStorage.getItem("nm_lastMcp")||"0")}catch(e){}
  var serverMcp=d.mcpSetAt||0;
  var mcpNewCmd=currentId&&d.current&&d.current.id&&d.current.id!==currentId&&serverMcp>lastMcp;
  if(mcpNewCmd){localStorage.setItem("nm_lastMcp",String(serverMcp))}
  if((!currentId||mcpNewCmd)&&d.current&&d.current.id){
    if(mcpNewCmd){var tgt=localQueue.find(function(t){return t.id===d.current.id});if(tgt)playSong(tgt)}
    else{currentId=d.current.id;playerActive=true;
    document.getElementById("art").src=d.current.coverUrl||"";document.getElementById("name").textContent=d.current.name||"";document.getElementById("artist").textContent=d.current.artist||"";
    if("mediaSession" in navigator){navigator.mediaSession.metadata=new MediaMetadata({title:d.current.name,artist:d.current.artist,album:d.current.album||"",artwork:[{src:d.current.coverUrl||"",sizes:"300x300"}]});}
    if(d.playUrl){a.src=d.playUrl;a.play().catch(function(){});document.getElementById("status").textContent="▶ 播放中"}else{resolveUrlFor(d.current.id)}
  }}
  // Progress bar
  if(a.duration&&!isNaN(a.duration)){var pct=(a.currentTime/a.duration*100).toFixed(1);document.getElementById("barFill").style.width=pct+"%";document.getElementById("curTime").textContent=fm(a.currentTime);document.getElementById("durTime").textContent=fm(a.duration)}
  // Play icon
  var pi=document.getElementById("playIcon");
  pi.innerHTML=a.paused?'<polygon points="6 4 20 12 6 20"/>':'<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
  // Queue display — only rebuild if changed
  var qStr=localQueue.map(function(t){return t.id}).join(",")+"|"+currentId;
  if(qStr!==lastQueueStr){lastQueueStr=qStr;var el=document.getElementById("queue");
    if(!localQueue.length)el.innerHTML='<div class="empty">队列空的</div>';
    else{var h='';for(var i=0;i<localQueue.length;i++){var t=localQueue[i];h+='<div class="queue-item'+(t.id===currentId?' active':'')+'"><img src="'+(t.coverUrl||'')+'" onerror="this.style.display=\\'none\\'"><div class="qi"><div class="qname">'+esc(t.name)+'</div><div class="qart">'+esc(t.artist)+'</div></div></div>';}el.innerHTML=h;}
  }}
function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
// Controls
function togglePlay(){a.paused?a.play().catch(()=>{}):a.pause();}function clearQueue(){a.pause();a.src='';localQueue=[];currentId=null;document.getElementById('art').src='data:image/svg+xml,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 200 200%27><rect fill=%27%231a1a1a%27 width=%27200%27 height=%27200%27/><text fill=%27%23888%27 x=%27100%27 y=%27110%27 text-anchor=%27middle%27 font-size=%2740%27>🎵</text></svg>';document.getElementById('name').textContent='等待播放';document.getElementById('artist').textContent='告诉 Claude 你想听什么';document.getElementById('status').textContent='队列已清空';localStorage.removeItem('nm_player');localStorage.removeItem('nm_clearedAt');lastQueueStr='';render({queue:[],current:null,status:'idle'});fetch('/api/clear',{method:'POST'}).catch(function(){})}
function syncNow(){var s={time:a.currentTime||0};if(currentId){var sc=localQueue.find(function(t){return t.id===currentId});s.songId=currentId;if(sc){s.name=sc.name;s.artist=sc.artist;s.coverUrl=sc.coverUrl;s.durationMs=sc.durationMs;s.album=sc.album}s.queue=localQueue.slice(0,20).map(function(t){return {id:t.id,name:t.name,artist:t.artist,coverUrl:t.coverUrl,durationMs:t.durationMs}})}fetch("/api/time",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(s)}).catch(function(){})}
function playSong(t){currentId=t.id;document.getElementById("art").src=t.coverUrl||"";document.getElementById("name").textContent=t.name||"";document.getElementById("artist").textContent=t.artist||"";if("mediaSession" in navigator){navigator.mediaSession.metadata=new MediaMetadata({title:t.name,artist:t.artist,artwork:[{src:t.coverUrl||"",sizes:"300x300"}]});}playerActive=true;resolveUrlFor(t.id);saveLocal();document.getElementById("status").textContent="⏭ 切歌中...";setTimeout(function(){syncNow()},500)}
function next(){a.pause();var idx=localQueue.findIndex(function(t){return t.id===currentId});if(idx>=0&&idx+1<localQueue.length){playSong(localQueue[idx+1]);saveLocal()}else if(localQueue.length>0){playSong(localQueue[0]);saveLocal();document.getElementById("status").textContent="🔁 回到开头"}else{document.getElementById("status").textContent="✅ 队列播完"}}
function prev(){a.pause();var idx=localQueue.findIndex(function(t){return t.id===currentId});if(idx>0){playSong(localQueue[idx-1]);saveLocal()}else if(localQueue.length>0){playSong(localQueue[0]);document.getElementById("status").textContent="🔁 第一首"}}
// Progress bar click to seek
document.getElementById("barWrap").addEventListener("click",function(e){if(!a.duration||isNaN(a.duration))return;const rect=this.getBoundingClientRect();const pct=(e.clientX-rect.left)/rect.width;a.currentTime=Math.max(0,Math.min(a.duration,pct*a.duration))});
// Audio events
a.addEventListener("play",()=>{document.getElementById("playIcon").innerHTML='<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';document.getElementById("status").textContent="▶ 播放中"});
a.addEventListener("pause",()=>{document.getElementById("playIcon").innerHTML='<polygon points="6 4 20 12 6 20"/>';if(!a.ended)document.getElementById("status").textContent="⏸ 暂停"});
a.addEventListener("ended",()=>{document.getElementById("status").textContent="✅ 播放完毕·切歌中";setTimeout(next,500)});
a.addEventListener("error",()=>{document.getElementById("status").textContent="⚠ 播放中断·重试中";setTimeout(()=>{if(currentId){if(a.src&&a.readyState===0){resolveUrlFor(currentId)}else{a.play().catch(function(){resolveUrlFor(currentId)})}}},1500)});
a.addEventListener("stalled",()=>{document.getElementById("status").textContent="⚠ 加载中·自动恢复";setTimeout(()=>{if(currentId&&a.readyState>=2)a.play().catch(()=>{resolveUrlFor(currentId)})},1000)});a.addEventListener("timeupdate",function(){if(a.duration&&!isNaN(a.duration)){const pct=(a.currentTime/a.duration*100).toFixed(1);document.getElementById("barFill").style.width=pct+"%";document.getElementById("curTime").textContent=fm(a.currentTime);document.getElementById("durTime").textContent=fm(a.duration)}});
loadLocal();if(window.__INIT__&&window.__INIT__.current)render(window.__INIT__);setInterval(poll,2000);poll();
// Sync full player state to server every 3s (source of truth for AI)
setInterval(()=>{var s={time:a.currentTime||0};if(currentId){var cur=localQueue.find(function(t){return t.id===currentId});s.songId=currentId;if(cur){s.name=cur.name;s.artist=cur.artist;s.coverUrl=cur.coverUrl;s.durationMs=cur.durationMs;s.album=cur.album}s.queue=localQueue.slice(0,20).map(function(t){return {id:t.id,name:t.name,artist:t.artist,coverUrl:t.coverUrl,durationMs:t.durationMs}})}fetch("/api/time",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(s)}).catch(function(){})},3000);
// Quick test button — simulates Claude calling "play"
document.getElementById("testBtn").addEventListener("click",function(){var btn=this;btn.textContent="加载第1首...";btn.disabled=true;var songs=["Justin Bieber Boyfriend","Justin Bieber As Long As You Love Me","Love Story Taylor Swift"];var done=0;function addOne(i){if(i>=songs.length){btn.textContent="✅ 3首已加入·刷新页面";btn.disabled=false;setTimeout(poll,500);return;}btn.textContent="加载第"+(i+1)+"首...";fetch("/api/mcp",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:90+i,method:"tools/call",params:{name:"play",arguments:{keyword:songs[i]}}})}).then(function(r){return r.json()}).then(function(j){done++;btn.textContent="✅ "+done+"/3";setTimeout(function(){addOne(i+1)},1000)}).catch(function(){btn.textContent="❌ 失败·重试";btn.disabled=false})}addOne(0)});

</script></body></html>`.replace('__BG__', BG_IMAGE);
}

// ─── Vercel handler ─────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    // Player page — versioned URL to defeat mobile browser cache
    const PLAYER_VER = "1.5.1";
    if (req.method === "GET" && (path === "/" || path.startsWith("/?"))) {
      const qv = url.searchParams.get("v");
      if (qv !== PLAYER_VER) {
        res.statusCode = 302;
        res.setHeader("Location", `/?v=${PLAYER_VER}`);
        res.end();
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      const initState = await getPlayer();
      res.statusCode = 200; res.end(playerHtml(initState)); return;
    }

    // Player state
    if (req.method === "GET" && path === "/api/state") {
      const p = await getPlayer();
      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ current: p.current || null, queue: p.queue.slice(0, 20), status: p.status, currentTime: p.currentTime || 0, playUrl: p.current?.playUrl || "", mcpSetAt: p._mcpSetAt || 0 }));
      return;
    }

    // Player requests URL for a song (called from browser JS directly)
    if (req.method === "GET" && path === "/api/url") {
      const id = url.searchParams.get("id");
      if (!id) { res.statusCode = 400; res.end(JSON.stringify({ error: "missing id" })); return; }
      let playUrl = "";
      try { playUrl = await getSongUrl(id) || ""; } catch {}
      // Cache it on the current song
      const p = await getPlayer();
      if (p.current?.id === id) p.current.playUrl = playUrl;
      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ playUrl }));
      return;
    }

    // Player next/prev — no blocking URL resolve
    if (req.method === "GET" && (path === "/api/next" || path === "/api/prev")) {
      const p = await getPlayer();
      if (path === "/api/next" && p.queue.length > 1) { p.queue.shift(); p.current = p.queue[0]; }
      p.current && (p.current.playUrl = "");
      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: p.current?.id || "", playUrl: p.queue.length > 1 ? "" : "" }));
      return;
    }

    // Clear server state (called from player Clear button)
    if (req.method === "POST" && path === "/api/clear") {
      const p = await getPlayer();
      p.queue = []; p.current = null; p.status = "idle"; p.currentTime = 0;
      await saveState();
      res.statusCode = 200; res.end("ok");
      return;
    }

    // Player syncs full state (authoritative) — called every 3s
    if (req.method === "POST" && (path === "/api/time" || path === "/api/sync")) {
      try {
        const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
        mergeFromPlayer(b); await saveState();
      } catch {}
      res.statusCode = 200; res.end("ok");
      return;
    }

    // Debug: comprehensive API test (add ?addPid=X&addSid=Y for detailed add trace)
    if (path === "/api/debug") {
      const results = { version: "2.1.0", deployed: "mt-addr-raw", cookieLen: COOKIE.length, mtCookieLen: MT_COOKIE.length, server: "Vercel HK", timestamp: new Date().toISOString() };
      try {
        // Test 1: search (use ?kw=xxx to test custom keyword)
        const testKw = url.searchParams.get("kw") || "Justin Bieber";
        const search = await searchSongs(testKw, 5);
        results.search = { keyword: testKw, ok: search.length > 0, count: search.length, first: search[0]?.name || "", firstArtist: search[0]?.artist || "", coverUrl: (search[0]?.coverUrl || "(empty)").slice(0, 80) };
      } catch (e) { results.search = { error: e.message }; }
      try {
        // Test 2: playlists
        const pl = await getPlaylists();
        results.playlists = { ok: true, count: pl.length, names: pl.slice(0, 5).map(p => p.name) };
      } catch (e) { results.playlists = { error: e.message }; }
      try {
        // Test 3: song URL (free song)
        let url = await getSongUrl("186016");
        results.songUrl = { ok: !!url, url: (url || "(empty)").slice(0, 80) };
      } catch (e) { results.songUrl = { error: e.message }; }
      try {
        // Test 4: playlist detail (if playlists available)
        const pl = await getPlaylists();
        if (pl.length > 0) {
          const detail = await getPlaylistDetail(pl[0].id);
          results.playlistDetail = { name: detail.name, trackCount: detail.trackCount, tracksReturned: detail.tracks.length };
        }
      } catch (e) { results.playlistDetail = { error: e.message }; }
      // Test 5: detailed add_to_playlist (all 3 formats, raw API response per format)
      const addPid = url.searchParams.get("addPid");
      const addSid = url.searchParams.get("addSid");
      if (addPid && addSid) {
        const addFormats = [
          { label: "A_jsonArr", body: `op=add&pid=${encodeURIComponent(addPid)}&trackIds=${encodeURIComponent(`[${addSid}]`)}` },
          { label: "B_plainId", body: `op=add&pid=${encodeURIComponent(addPid)}&trackIds=${encodeURIComponent(addSid)}` },
          { label: "C_tracks", body: `op=add&pid=${encodeURIComponent(addPid)}&tracks=${encodeURIComponent(addSid)}` },
        ];
        const addResults = [];
        for (const fmt of addFormats) {
          try {
            const fres = await fetch("https://music.163.com/api/playlist/manipulate/tracks", {
              method: "POST",
              headers: { ...H, "content-type": "application/x-www-form-urlencoded" },
              body: fmt.body,
            });
            const text = await fres.text();
            let parsed = {};
            try { parsed = JSON.parse(text); } catch {}
            addResults.push({ label: fmt.label, httpStatus: fres.status, code: parsed.code, message: parsed.message || parsed.msg || "", bodyPreview: text.slice(0, 200) });
          } catch (e) {
            addResults.push({ label: fmt.label, error: e.message });
          }
        }
        results.addTest = { pid: addPid, sid: addSid, formats: addResults };
      } else {
        try {
          const pl = await getPlaylists();
          if (pl.length > 0) {
            await addToPlaylist(pl[0].id, "186016");
            results.addTest = { ok: true, msg: "add succeeded for test song" };
          }
        } catch (e) { results.addTest = { ok: false, error: e.message }; }
      }
      // Test 6: Meituan search (mtgsig v1.2)
      try {
        const mtResult = await mtSearch("汉堡", "28.673167", "115.887078");
        results.mtSearch = { ok: mtResult.source === "real", source: mtResult.source, count: mtResult.count, firstShop: mtResult.shops?.[0]?.name || "" };
      } catch (e) { results.mtSearch = { error: e.message }; }
      // Test 7: Meituan addresses
      try {
        const addrResult = await mtGetAddresses();
        results.mtAddresses = { ok: addrResult.source === "real", count: addrResult.count || 0, firstAddr: addrResult.addresses?.[0]?.address?.slice(0, 30) || "", reason: addrResult.reason || "", raw: addrResult.raw || "", httpStatus: addrResult.httpStatus || "" };
      } catch (e) { results.mtAddresses = { error: e.message }; }
      // Test 8: Meituan shop menu
      try {
        const mtSearchResult = await mtSearch("汉堡", "28.673167", "115.887078");
        if (mtSearchResult.source === "real" && mtSearchResult.shops?.length > 0) {
          const shopId = mtSearchResult.shops[0].id;
          const menuResult = await mtShopMenu(shopId);
          results.mtMenu = { ok: menuResult.source === "real", count: menuResult.count || 0, raw: menuResult.raw || "", reason: menuResult.reason || "", shopName: mtSearchResult.shops[0].name };
        }
      } catch (e) { results.mtMenu = { error: e.message }; }
      // Test 9: Meituan order preview (use menu SKU, not search product)
      try {
        const mt2 = await mtSearch("汉堡", "28.673167", "115.887078");
        const shop = mt2.shops?.[0];
        if (shop) {
          const menu = await mtShopMenu(shop.id);
          if (menu.source === "real" && menu.products?.length > 0) {
            const prod = menu.products[0];
            const skuId = prod.skus?.[0]?.id || prod.id;
            const attrs = prod.attrIds || [];
            const orderResult = await mtPlaceOrder(shop.id, skuId, "test-no-real-order", 1, attrs);
            results.mtOrder = {
              ok: orderResult.source === "real", step: orderResult.step || "",
              totalPrice: orderResult.totalPrice || "", deliveryFee: orderResult.deliveryFee || "",
              raw: orderResult.raw || "", reason: orderResult.reason || "",
              shopName: shop.name, productName: prod.name, price: prod.price,
              skuId: skuId,
            };
          } else {
            results.mtOrder = { reason: "menu_empty" };
          }
        } else {
          results.mtOrder = { reason: "no_shop" };
        }
      } catch (e) { results.mtOrder = { error: e.message }; }

      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(results));
      return;
    }

    // Ping — returns git commit to verify which version is actually deployed
    if (path === "/api/ping") {
      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.end(JSON.stringify({ commit: "1c4b337", build: BUILD_ID, ts: Date.now() }));
      return;
    }

    // Health
    if (path === "/api/health") {
      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true })); return;
    }

    // MCP POST
    if (req.method === "POST" && path === "/api/mcp") {
      let body = req.body;
      if (body === undefined || body === null) {
        const chunks = []; for await (const c of req) chunks.push(c);
        body = JSON.parse(Buffer.concat(chunks).toString("utf8").trim() || "{}");
      } else if (typeof body === "string") {
        body = body.trim() ? JSON.parse(body) : {};
      }
      res.setHeader("Content-Type", "application/json");
      if (Array.isArray(body)) {
        const results = []; for (const msg of body) { const r = await handleMcpMessage(msg); if (r) results.push(r); }
        res.statusCode = 200; res.end(JSON.stringify(results));
      } else {
        const r = await handleMcpMessage(body);
        if (r) { res.statusCode = 200; res.end(JSON.stringify(r)); }
        else { res.statusCode = 202; res.end(""); }
      }
      return;
    }

    // MCP GET
    if (req.method === "GET" && path === "/api/mcp") {
      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true })); return;
    }

    // OAuth — 404
    if (path.includes("oauth") || path.includes("register")) {
      res.statusCode = 404; res.end(""); return;
    }

    res.statusCode = 404; res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (e) {
    res.statusCode = 500; res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message || "Internal error" }));
  }
}
