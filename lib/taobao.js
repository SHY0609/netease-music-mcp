/**
 * taobao.js — 淘宝 mtop 协议封装 (H5 移动版)
 *
 * 签名: MD5(token + "&" + t + "&" + appKey + "&" + data)
 * 域名: h5api.m.taobao.com
 * 方式: GET + JSONP callback
 * 需要发送 Cookie 作为请求头
 */
import { createHash } from "node:crypto";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const APP_KEY = "12574478";
const JSV = "2.7.0";
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
    preventFallback: "true",
    ecode: "1",
    data: dataStr,
  });

  const url = ACS + "/h5/" + api.toLowerCase() + "/" + version + "/?" + params.toString();
  console.error("[mtop] GET", url.slice(0, 120));

  try {
    const headers = {
      "User-Agent": UA,
      Referer: "https://h5.m.taobao.com/",
      Cookie: cookieStr || "",
    };
    const res = await fetch(url, { headers });
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

// ─── 结果解析辅助函数 ───────────────────────────────────────

/**
 * 在解析后的 JSON 中查找商品数组
 * 按概率从高到低尝试已知字段名
 */
function findItemArray(parsed) {
  const candidates = [
    "itemsList", "itemList", "listItems", "itemsArray",
    "auctionList", "items", "resultList", "productList", "data",
  ];
  for (const key of candidates) {
    const val = parsed[key];
    if (Array.isArray(val) && val.length > 0) {
      console.error(`[tbSearch] found items at "${key}" (${val.length} items)`);
      return val;
    }
  }
  // 兜底：深度搜索
  return deepFindItemArray(parsed);
}

/**
 * 递归查找包含商品特征的数组（最多 3 层）
 */
function deepFindItemArray(obj, depth = 0) {
  if (depth > 3) return null;
  if (typeof obj !== "object" || obj === null) return null;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0) {
      const first = val[0];
      if (first && typeof first === "object" &&
          (first.title || first.price || first.item_id || first.itemId)) {
        console.error(`[tbSearch] deep found items at "${key}" (${val.length} items, depth=${depth})`);
        return val;
      }
    }
    if (typeof val === "object" && !Array.isArray(val)) {
      const result = deepFindItemArray(val, depth + 1);
      if (result) return result;
    }
  }
  return null;
}

/**
 * 从原始商品对象提取标准化字段
 * 兼容淘宝 mtop API 的多种字段命名
 */
function extractProduct(item) {
  const itemId = item.item_id || item.auctionId || item.nid || item.id || item.itemId || "";
  return {
    id: String(itemId),
    title: item.title || item.name || item.itemName || item.raw_title || "",
    price: item.price || item.reservePrice || item.view_price || item.viewPrice || "",
    sold: item.sold || item.monthSold || item.soldQuantity || item.biz30day || item.sales || "",
    shopName: item.shopName || item.shop_title || item.nick || item.sellerName || "",
    image: item.pictUrl || item.imgUrl || item.image || item.pic || item.pic_url || "",
    url: itemId ? "https://h5.m.taobao.com/awp/core/detail.htm?id=" + itemId : "",
    location: item.location || item.city || item.province || "",
    shippingFee: item.shippingFee || item.fee || item.postFee || "",
  };
}

/**
 * 从详情数据中提取优惠券
 */
function extractCoupons(data) {
  const coupons = data.coupons || data.couponList || data.coupon || [];
  if (!Array.isArray(coupons) || coupons.length === 0) return [];
  return coupons.slice(0, 3).map(c => ({
    amount: c.amount || c.faceValue || c.value || "",
    condition: c.condition || c.conditionDesc || c.startFee || "",
    startTime: c.startTime || c.start || "",
    endTime: c.endTime || c.end || "",
  }));
}

// ─── 公开 API ──────────────────────────────────────────────

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
      // ret[0] 是 URL-encoded JSON 字符串
      const decoded = decodeURIComponent(ret0);
      console.error("[tbSearch] decoded ret[0] length:", decoded.length);

      // 检测淘宝风控/限流错误
      if (/RGV587_ERROR|FAIL_SYS_|被挤爆|请稍后重试|service\.error/i.test(decoded)) {
        console.error("[tbSearch] API anti-bot/rate-limit:", decoded.slice(0, 200));
        return { source: "error", reason: "rate_limited", hint: "淘宝接口限流或风控，请稍后重试或更新 Cookie", _raw: decoded.slice(0, 300) };
      }

      let parsed;
      try {
        parsed = JSON.parse(decoded);
      } catch {
        return { source: "error", reason: "json_parse_failed", _raw: decoded.slice(0, 500) };
      }

      // 查找商品数组
      const items = findItemArray(parsed);
      if (!items || !items.length) {
        return {
          source: "error",
          reason: "no_items_found",
          _keys: Object.keys(parsed).slice(0, 20).join(","),
          _raw: decoded.slice(0, 500),
        };
      }

      // 提取结构化商品数据
      let products = items.map(item => extractProduct(item));

      // 客户端价格过滤
      const minPrice = parseFloat(opts.minPrice) || 0;
      const maxPrice = parseFloat(opts.maxPrice) || Infinity;
      if (opts.minPrice || opts.maxPrice) {
        const before = products.length;
        products = products.filter(p => {
          const price = parseFloat(p.price) || 0;
          return price >= minPrice && price <= maxPrice;
        });
        console.error(`[tbSearch] price filter: ${before} → ${products.length} (¥${minPrice}-¥${maxPrice})`);
      }

      return {
        source: "real",
        keyword: keyword,
        totalCount: products.length,
        products: products,
      };
    } catch (e) {
      console.error("[tbSearch] parse error:", e.message);
      return { source: "error", reason: "parse_failed", hint: e.message, _raw: (result.data.ret[0] || "").slice(0, 500) };
    }
  }

  return { source: "error", reason: "empty_ret", _raw: JSON.stringify(result.data).slice(0, 500) };
}

/**
 * 获取商品详情
 */
export async function tbDetail(itemId, cookieStr = "") {
  const result = await mtopGet("mtop.taobao.detail.getdetail", "6.0", { itemNumId: itemId }, cookieStr);

  if (result.error) return { source: "error", reason: result.error, hint: result.hint };
  if (!result.ok || !result.data) {
    return { source: "error", reason: "api_failed", status: result.status };
  }

  try {
    const d = result.data.data || {};
    const item = d.item || {};
    const seller = d.seller || {};

    return {
      source: "real",
      id: itemId,
      title: item.title || "",
      subTitle: item.subTitle || item.sub_title || "",
      price: item.price || "",
      originalPrice: item.originalPrice || item.original_price || item.reservePrice || "",
      sold: item.sold || item.totalSold || "",
      stock: item.stock || item.quantity || "",
      shopId: String(seller.shopId || seller.shop_id || seller.userId || ""),
      shopName: seller.shopName || seller.nick || seller.shop_name || "",
      shopScore: seller.shopScore || seller.score || "",
      pics: (item.images || item.pics || item.picPaths || []).slice(0, 5),
      url: "https://h5.m.taobao.com/awp/core/detail.htm?id=" + itemId,
      deliveryInfo: item.delivery || item.deliveryInfo || item.postFee || "",
      coupons: extractCoupons(d),
    };
  } catch (e) {
    return { source: "error", reason: "parse_failed", hint: e.message };
  }
}
