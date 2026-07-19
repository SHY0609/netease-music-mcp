/**
 * taobao-browser.js — Puppeteer 浏览器搜索淘宝
 * 策略: 打开 H5 搜索页 → 等 JS 渲染完 → 从 DOM 提取商品卡片
 */
import puppeteer from "puppeteer-core";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
let browser = null;

async function getBrowser() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: "new",
    executablePath: "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  return browser;
}

export async function browserSearch(keyword, opts = {}, cookieStr = "") {
  const b = await getBrowser();
  const page = await b.newPage();

  // 拦截并记录所有 h5api 响应（只记不阻断）
  const mtopData = [];
  page.on("response", async (resp) => {
    const url = resp.url();
    if (url.includes("wsearch") || url.includes("h5search") || url.includes("search")) {
      try {
        const text = await resp.text();
        console.error("[browser] mtop resp:", url.slice(0, 80), "len:", text.length);
        if (text.length > 200 && !text.includes("RGV587")) mtopData.push(text);
      } catch {}
    }
  });

  await page.setUserAgent(UA);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  if (cookieStr) {
    const cookies = cookieStr.split(";").map(s => s.trim()).filter(Boolean).map(p => {
      const eq = p.indexOf("=");
      return { name: eq > 0 ? p.slice(0, eq).trim() : p, value: eq > 0 ? p.slice(eq + 1) : "true", domain: ".taobao.com", path: "/" };
    });
    await page.setCookie(...cookies);
  }

  // 先访问首页建立会话
  console.error("[browser] visiting home...");
  try { await page.goto("https://h5.m.taobao.com", { waitUntil: "domcontentloaded", timeout: 12000 }); } catch {}
  await new Promise(r => setTimeout(r, 2000));

  // 再进入搜索页
  const searchUrl = "https://h5.m.taobao.com/awp/core/search.htm?q=" +
    encodeURIComponent(keyword) + "&sst=1&n=" + (opts.pageSize || 10) + "&buying=buyitnow&page=" + (opts.page || 1);
  console.error("[browser] searching:", keyword);
  try { await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 }); } catch {}

  // 等 JS 渲染商品卡片（轮询 DOM）
  console.error("[browser] waiting for products...");
  let products = null;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 1500));
    products = await page.evaluate(() => {
      const items = [];
      // H5 taobao 搜索页常见选择器
      document.querySelectorAll("[class*=card], [class*=item], [class*=Card], [class*=Item], .product, [data-spm]").forEach(el => {
        const text = (el.textContent || "").trim();
        if (text.length < 30) return; // 跳过空卡片
        const img = el.querySelector("img")?.src || el.querySelector("img")?.dataset?.src || "";
        const price = (el.textContent || "").match(/¥\s*([\d.]+)/)?.[1] || "";
        const id = el.getAttribute("data-id") || el.getAttribute("data-item-id") ||
          (el.querySelector("a")?.href?.match(/[?&]id=(\d+)/) || [])[1] || "";
        const title = el.querySelector("[class*=title]")?.textContent?.trim() ||
          el.querySelector("h3, h2")?.textContent?.trim() || "";
        items.push({ id, title, price, image: img?.replace(/^\/\//, "https://") });
      });
      return items.filter(it => it.id && it.title).length > 0 ? items.filter(it => it.id && it.title) : null;
    });
    if (products) {
      console.error("[browser] DOM found", products.length, "products at", i * 1.5 + "s");
      break;
    }
    console.error("[browser] ... no products yet (" + (i + 1) * 1.5 + "s)");
  }

  // 如果 DOM 提取失败，尝试从拦截的 API 响应解析
  if (!products) {
    console.error("[browser] DOM failed, trying API response parse...");
    for (const text of mtopData) {
      try {
        const jsonStr = text.replace(/^mtopjsonp\d+\(/, "").replace(/\);?\s*$/, "");
        const parsed = JSON.parse(jsonStr);
        const ret0 = parsed.ret?.[0];
        if (!ret0 || /ERROR/i.test(ret0)) continue;
        const decoded = decodeURIComponent(ret0);
        const inner = JSON.parse(decoded);
        const key = ["itemsList","itemList","listItems","itemsArray","auctionList","items"]
          .find(k => Array.isArray(inner[k]) && inner[k].length > 0);
        if (key) {
          products = inner[key].map(item => ({
            id: String(item.itemId || item.item_id || item.nid || ""),
            title: item.title || item.raw_title || "",
            price: item.price || item.view_price || "",
            image: (item.pictUrl || item.pic_url || "").replace(/^\/\//, "https://"),
            shopName: item.nick || item.shopName || "",
          }));
          console.error("[browser] API data found:", products.length, "products");
          break;
        }
      } catch {}
    }
  }

  // 都不行 → 截图诊断
  if (!products) {
    await page.screenshot({ path: "/tmp/taobao-debug.png" });
    console.error("[browser] screenshot saved to /tmp/taobao-debug.png");
  }

  await page.close();

  if (!products || !products.length) {
    return { source: "error", reason: "no_results", hint: "page rendered no products, check /tmp/taobao-debug.png" };
  }

  const result = {
    source: "real", keyword, totalCount: products.length,
    products: products.slice(0, 30).map(p => ({
      ...p, url: p.id ? "https://h5.m.taobao.com/awp/core/detail.htm?id=" + p.id : "",
    })),
  };
  console.error("[browser] done:", products.length, "products");
  return result;
}

export async function closeBrowser() {
  if (browser) { try { await browser.close(); } catch {} }
  browser = null;
}
