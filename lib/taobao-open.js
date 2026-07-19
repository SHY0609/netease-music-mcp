/**
 * taobao-open.js — 淘宝开放平台 API
 * 使用官方 API，不走 mtop，不会被风控
 * 文档: https://open.taobao.com/api.htm
 */
import { createHash } from "node:crypto";

const API_URL = "https://eco.taobao.com/router/rest";
let APP_KEY = process.env.TAOBAO_APP_KEY || "";
let APP_SECRET = process.env.TAOBAO_APP_SECRET || "";

function md5(s) { return createHash("md5").update(s, "utf8").digest("hex").toUpperCase(); }

/**
 * 签名: 所有参数按 key 排序 → secret + 拼接 + secret → MD5 大写
 */
function sign(params, secret) {
  const sorted = Object.keys(params).sort().map(k => k + params[k]).join("");
  return md5(secret + sorted + secret);
}

/**
 * 通用 API 调用
 */
async function callApi(method, params = {}, session = "") {
  const sysParams = {
    method,
    app_key: APP_KEY,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "").replace("T", " ").replace(/-/g, "-").replace(/:/g, ":"),
    format: "json",
    v: "2.0",
    sign_method: "md5",
    ...params,
  };
  if (session) sysParams.session = session;
  sysParams.sign = sign(sysParams, APP_SECRET);

  const body = new URLSearchParams(sysParams).toString();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  return json;
}

/**
 * 搜索商品 — 使用 taobao.tbk.dg.material.optional（淘宝客物料搜索）
 * 无需用户授权，有 appkey 就能用
 */
export async function openSearch(keyword, opts = {}) {
  if (!APP_KEY || !APP_SECRET) {
    return { source: "error", reason: "no_appkey", hint: "请设置 TAOBAO_APP_KEY 和 TAOBAO_APP_SECRET 环境变量" };
  }

  try {
    const params = {
      adzone_id: opts.adzoneId || process.env.TAOBAO_ADZONE_ID || "",
      q: keyword,
      page_size: String(opts.pageSize || 20),
      page_no: String(opts.page || 1),
      sort: opts.sort || "",  // price_asc / price_desc / sales_des / tk_rate_des
      is_tmall: opts.isTmall ? "true" : "false",
      has_coupon: opts.hasCoupon ? "true" : "false",
    };

    console.error("[openapi] searching:", keyword);
    const result = await callApi("taobao.tbk.dg.material.optional", params);

    if (result.error_response) {
      const err = result.error_response;
      console.error("[openapi] error:", err.code, err.msg);
      return {
        source: "error",
        reason: "api_error",
        code: err.code,
        hint: err.msg + (err.sub_msg ? " — " + err.sub_msg : ""),
      };
    }

    const data = result.tbk_dg_material_optional_response?.result_list?.map_data || [];
    if (!data.length) {
      return { source: "real", keyword, totalCount: 0, products: [], hint: "no results" };
    }

    const products = data.map(item => ({
      id: String(item.item_id || item.num_iid || ""),
      title: item.title || "",
      price: item.zk_final_price || item.reserve_price || "",
      originalPrice: item.reserve_price || "",
      sold: item.volume || item.biz30day || "",
      shopName: item.nick || item.seller_nick || item.shop_title || "",
      image: (item.pict_url || item.small_images?.string?.[0] || "").replace(/^\/\//, "https://"),
      url: item.coupon_share_url || item.url || ("https://item.taobao.com/item.htm?id=" + item.item_id),
      coupon: item.coupon_amount ? "减" + item.coupon_amount + "元" : "",
      commission: item.commission_rate ? item.commission_rate + "%" : "",
    }));

    console.error("[openapi] got", products.length, "products");
    return { source: "real", keyword, totalCount: products.length, products };
  } catch (e) {
    console.error("[openapi] error:", e.message);
    return { source: "error", reason: "fetch_error", hint: e.message };
  }
}

/** 设置 appkey（从环境变量或手动设置） */
export function setAppKey(key, secret, adzoneId) {
  if (key) APP_KEY = key;
  if (secret) APP_SECRET = secret;
  if (adzoneId) process.env.TAOBAO_ADZONE_ID = adzoneId;
}
