/**
 * taobao.js — 淘宝 mtop 协议封装
 *
 * 签名算法: MD5(_m_h5_tk前半段 + "&" + timestamp + "&" + appKey + "&" + data)
 * 比美团的 jsdom+h5guard 简单 100 倍
 */
import { createHash } from "node:crypto";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const APP_KEY = "12574478";
const JSV = "2.7.0";
const H5API = "https://h5api.m.taobao.com";

function md5(s) {
  return createHash("md5").update(s, "utf8").digest("hex");
}

/**
 * 从 Cookie 字符串中提取 _m_h5_tk 的 token 部分
 * _m_h5_tk 格式: "abc123def456_1720000000" → 取 "abc123def456"
 */
function getToken(cookieStr) {
  const m = cookieStr.match(/_m_h5_tk=([^;]+)/);
  if (!m) return null;
  const tk = decodeURIComponent(m[1]);
  return tk.split("_")[0];
}

/**
 * 生成 mtop sign
 */
function makeSign(token, t, data) {
  const str = token + "&" + t + "&" + APP_KEY + "&" + data;
  return md5(str);
}

/**
 * 通用 mtop API 调用
 */
async function mtopApi(api, version, data, cookieStr) {
  const token = getToken(cookieStr);
  if (!token) {
    console.error("[mtopApi] no token found in cookie, cookieLen:", (cookieStr||"").length);
    return { error: "no_token", hint: "Cookie 中缺少 _m_h5_tk" };
  }

  const t = String(Date.now());
  const dataStr = JSON.stringify(data);
  const sign = makeSign(token, t, dataStr);
  console.error("[mtopApi]", api, "token:", token.slice(0,8)+"...", "sign:", sign.slice(0,12)+"...");

  const params = new URLSearchParams({
    jsv: JSV,
    appKey: APP_KEY,
    t: t,
    sign: sign,
    api: api,
    v: version,
    type: "originaljson",
    dataType: "jsonp",
    data: dataStr,
  });

  try {
    const res = await fetch(H5API + "/h5/" + api + "/" + version + "/", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookieStr,
        "Referer": "https://h5.m.taobao.com/",
      },
      body: params.toString(),
    });
    const text = await res.text();
    console.error("[mtopApi] response — status:", res.status, "textLen:", text.length);
    // mtop 响应是 JSONP 格式: mtopjsonp1({...})
    const json = text.replace(/^mtopjsonp\d+\(/, "").replace(/\)$/, "");
    try {
      const parsed = JSON.parse(json);
      console.error("[mtopApi] parsed ret[0] keys:", parsed?.ret ? String(parsed.ret[0] || "").slice(0, 80) : "no_ret");
      return { ok: res.ok, status: res.status, data: parsed };
    } catch (e) {
      console.error("[mtopApi] JSON parse failed:", e.message, "raw:", text.slice(0, 200));
      return { ok: false, status: res.status, raw: text.slice(0, 500) };
    }
  } catch (e) {
    return { error: "fetch_failed", hint: e.message };
  }
}

/**
 * 搜索商品
 * @param {string} keyword - 搜索关键词
 * @param {object} opts - 可选: pageSize, page, sort, minPrice, maxPrice
 * @param {string} cookieStr - 淘宝 Cookie
 */
export async function tbSearch(keyword, opts = {}, cookieStr = "") {
  const data = {
    q: keyword,
    pageSize: opts.pageSize || 20,
    page: opts.page || 1,
    sort: opts.sort || "_coefp",
  };
  // 价格筛选是可选的
  if (opts.minPrice || opts.maxPrice) {
    data.filter = {
      price: {
        start: opts.minPrice || "",
        end: opts.maxPrice || "",
      },
    };
  }

  const result = await mtopApi(
    "mtop.taobao.wsearch.h5search",
    "1.0",
    data,
    cookieStr
  );

  if (result.error) return { source: "error", reason: result.error, hint: result.hint };
  if (!result.ok || !result.data) {
    return { source: "error", reason: "api_failed", status: result.status, raw: (result.raw || "").slice(0, 300) };
  }

  const ret = result.data.ret || [];
  const msg = result.data.msg || "";
  // ret[0] 是搜索结果，格式为 JSON 字符串
  try {
    const listItems = JSON.parse(ret[0] || "{}");
    const items = listItems.items || listItems.listItem || [];
    const products = (Array.isArray(items) ? items : []).slice(0, 20).map(item => ({
      id: item.item_id || item.auctionId || item.nid || "",
      name: item.title || item.name || "",
      price: item.price || item.view_price || "",
      sold: item.sold || item.soldQuantity || "",
      shop: item.shopName || item.nick || "",
      pic: item.pic_url || item.picUrl || item.image || "",
      url: item.item_id ? "https://h5.m.taobao.com/awp/core/detail.htm?id=" + item.item_id : "",
      // 闪购/小时达特有字段
      deliveryTime: item.deliveryTime || item.delivery_time || "",
      shopIcon: item.shopIcon || item.headPic || "",
    }));

    return {
      source: "real",
      keyword: keyword,
      count: products.length,
      totalCount: listItems.totalCount || listItems.total_count || products.length,
      products: products,
    };
  } catch (e) {
    return { source: "error", reason: "parse_failed", hint: e.message, raw: ret[0]?.slice(0, 500) || "" };
  }
}

/**
 * 获取商品详情
 * @param {string} itemId - 商品 ID
 * @param {string} cookieStr - 淘宝 Cookie
 */
export async function tbDetail(itemId, cookieStr = "") {
  const result = await mtopApi(
    "mtop.taobao.detail.getdetail",
    "6.0",
    { itemNumId: itemId },
    cookieStr
  );

  if (result.error) return { source: "error", reason: result.error, hint: result.hint };
  if (!result.ok || !result.data) {
    return { source: "error", reason: "api_failed", status: result.status };
  }

  try {
    const d = result.data.data || {};
    const item = d.item || {};
    const seller = d.seller || {};
    const apiStack = d.apiStack || [];

    // 解析 SKU 信息
    const skus = (d.skuCore || {}).sku2info || {};
    const skuList = Object.entries(skus).map(([k, v]) => ({
      id: k,
      name: (v.names || v.name || ""),
      price: v.price || "",
      stock: v.quantity || v.stock || "",
    }));

    // 解析优惠券/券后价
    let couponInfo = null;
    for (const entry of apiStack) {
      if (entry.name === "mtop.taobao.pcdetail.data.get" && entry.data) {
        const couponData = JSON.parse(entry.data);
        const shopCoupon = couponData.data?.shopCoupon || couponData.data?.coupon || {};
        couponInfo = {
          title: shopCoupon.title || "",
          amount: shopCoupon.amount || shopCoupon.couponAmount || "",
          startFee: shopCoupon.startFee || "",
        };
        break;
      }
    }

    return {
      source: "real",
      id: itemId,
      name: item.title || "",
      price: item.price || "",
      originalPrice: item.originalPrice || item.reservePrice || "",
      sold: item.sold || item.soldQuantity || "",
      shop: seller.shopName || seller.nick || "",
      coupon: couponInfo,
      skus: skuList.slice(0, 15),
      desc: (item.desc || item.subtitle || "").slice(0, 200),
      pics: (item.images || []).slice(0, 5),
      url: "https://h5.m.taobao.com/awp/core/detail.htm?id=" + itemId,
    };
  } catch (e) {
    return { source: "error", reason: "parse_failed", hint: e.message };
  }
}
