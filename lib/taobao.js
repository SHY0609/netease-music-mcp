/**
 * taobao.js — 淘宝 mtop 协议封装 (H5 移动版)
 *
 * 签名: MD5(token + "&" + t + "&" + appKey + "&" + data)
 * 域名: acs.m.taobao.com (不是 h5api!)
 * 方式: GET + JSONP callback
 */
import { createHash } from "node:crypto";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const APP_KEY = "12574478";
const JSV = "2.6.1";
const ACS = "https://h5api.m.taobao.com";

function md5(s) {
  return createHash("md5").update(s, "utf8").digest("hex");
}

function getToken(cookieStr) {
  const m = cookieStr.match(/_m_h5_tk=([^;]+)/);
  if (!m) return null;
  const tk = decodeURIComponent(m[1]);
  return tk.split("_")[0];
}

function makeSign(token, t, data) {
  return md5(token + "&" + t + "&" + APP_KEY + "&" + data);
}

/**
 * 通用 mtop GET 调用
 */
async function mtopGet(api, version, data, cookieStr) {
  const token = getToken(cookieStr);
  if (!token) {
    console.error("[mtop] no _m_h5_tk in cookie");
    return { error: "no_token" };
  }

  const t = String(Date.now());
  const dataStr = JSON.stringify(data);
  const sign = makeSign(token, t, dataStr);

  const params = new URLSearchParams({
    jsv: JSV,
    appKey: APP_KEY,
    t: t,
    sign: sign,
    api: api,
    v: version,
    type: "jsonp",
    dataType: "jsonp",
    callback: "mtopjsonp1",
    H5Request: "true",
    ecode: "1",
    data: dataStr,
  });

  const url = ACS + "/h5/" + api.toLowerCase() + "/" + version + "/?" + params.toString();
  console.error("[mtop] GET", url.slice(0, 120));

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Cookie": cookieStr,
        "Referer": "https://h5.m.taobao.com/",
      },
    });
    const text = await res.text();
    console.error("[mtop] status:", res.status, "bodyLen:", text.length);

    // JSONP → JSON
    const json = text.replace(/^\/?\*?\*?\/?\s*mtopjsonp\d+\(/, "").replace(/\);?\s*$/, "").replace(/^\s*\)\s*/, "");
    try {
      const parsed = JSON.parse(json);
      console.error("[mtop] ret:", parsed?.ret?.[0]?.slice(0, 80) || "no_ret", "msg:", parsed?.msg || "");
      return { ok: res.ok, status: res.status, data: parsed };
    } catch (e) {
      console.error("[mtop] JSON parse failed:", e.message, "raw:", text.slice(0, 300));
      return { ok: false, status: res.status, raw: text.slice(0, 500) };
    }
  } catch (e) {
    console.error("[mtop] fetch failed:", e.message);
    return { error: "fetch_failed", hint: e.message };
  }
}

/**
 * 搜索商品
 */
export async function tbSearch(keyword, opts = {}, cookieStr = "") {
  const data = {
    q: keyword,
    sst: "1",
    n: opts.pageSize || 20,
    buying: "buyitnow",
    m: "api4h5",
    token4h5: "",
    abtest: "14",
    wlsort: opts.sort || "14",
    page: opts.page || 1,
  };

  const result = await mtopGet("mtop.taobao.wsearch.h5search", "1.0", data, cookieStr);

  if (result.error) return { source: "error", reason: result.error, hint: result.hint };
  if (!result.ok || !result.data) {
    return { source: "error", reason: "api_failed", status: result.status, raw: (result.raw || "").slice(0, 300) };
  }

  if (result.data.ret?.[0]) {
    try {
      const ret0 = result.data.ret[0];
      // ret[0] 可能是 URL-encoded JSON 字符串，需要 decode
      const decoded = decodeURIComponent(ret0);
      console.error("[tbSearch] decoded ret[0] length:", decoded.length);
      return {
        source: "real",
        keyword: keyword,
        _raw: decoded.slice(0, 2000),
      };
    } catch (e) {
      return { source: "real", _raw: result.data.ret[0].slice(0, 2000) };
    }
  }

  return { source: "error", reason: "empty_ret", _raw: JSON.stringify(result.data).slice(0, 500) };
}

/**
 * 获取商品详情
 */
export async function tbDetail(itemId, cookieStr = "") {
  const result = await mtopGet("mtop.taobao.detail.getdetail", "6.0", { itemNumId: itemId }, cookieStr);

  if (result.error) return { source: "error", reason: result.error };
  if (!result.ok || !result.data) {
    return { source: "error", reason: "api_failed", status: result.status };
  }

  try {
    const d = result.data.data || {};
    return {
      source: "real",
      id: itemId,
      name: d.item?.title || "",
      price: d.item?.price || "",
      sold: d.item?.sold || "",
      shop: d.seller?.shopName || "",
      pics: (d.item?.images || []).slice(0, 5),
      url: "https://h5.m.taobao.com/awp/core/detail.htm?id=" + itemId,
    };
  } catch (e) {
    return { source: "error", reason: "parse_failed", hint: e.message };
  }
}
