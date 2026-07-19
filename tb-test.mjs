import { readFileSync } from "fs";
import { browserSearch, closeBrowser } from "./lib/taobao-browser.js";

const c = readFileSync("taobao-cookie.txt", "utf8").trim();
console.log("Cookie:", c.length, "chars");

const r = await browserSearch("蓝牙耳机", { pageSize: 5 }, c);
console.log("source:", r.source);

if (r.products) {
  r.products.slice(0, 5).forEach((p, i) => {
    console.log((i + 1) + ". " + (p.title || "").slice(0, 50));
    console.log("   Y" + p.price + " | 销量:" + (p.sold || "") + " | " + (p.shopName || ""));
    console.log("   图:" + (p.image || "").slice(0, 50));
    console.log("   " + p.url);
  });
} else {
  console.log("失败:", r.reason, r.hint || "");
}

await closeBrowser();
