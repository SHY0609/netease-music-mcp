// 美团规格弹窗 — 精确定位"加入购物车"按钮
const http = require("http"), WebSocket = require("ws");
const CDP_PORT = 9222;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); }).on("error", reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const tabs = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
  const mtTab = tabs.find(t => t.url && t.url.includes("meituan") && t.url.includes("menu"));
  if (!mtTab) { console.log("no tab"); return; }

  const ws = new WebSocket(mtTab.webSocketDebuggerUrl);
  await new Promise((r, e) => { ws.on("open", r); ws.on("error", e); });
  const pending = new Map(); let cid = 0;
  ws.on("message", data => {
    try { const m = JSON.parse(data.toString()); if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); m.error ? r.reject(new Error(m.error.message)) : r.resolve(m.result); } } catch {}
  });
  const send = (m, p) => new Promise((resolve, reject) => {
    const id = ++cid; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method: m, params: p }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout")); } }, 20000);
  });
  await send("Runtime.enable");
  const E = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }); return r?.result?.value || ""; };

  // 1. 检查弹窗是否还开着
  let hasPopup = await E("!!(document.body?.innerText||'').includes('加入购物车')");
  console.log("弹窗还开着:", hasPopup);

  if (hasPopup !== "true") {
    // 重新打开弹窗
    console.log("重新打开弹窗...");
    await E("window.scrollTo(0, 0)");
    await sleep(500);
    const pos = await E(`(function(){
      var b = document.querySelector("[class*=mBtnGroup]");
      if (!b) return null;
      var r = b.getBoundingClientRect();
      return JSON.stringify({x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)});
    })()`);
    if (pos) {
      const { x, y } = JSON.parse(pos);
      console.log("touch:", x, y);
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await sleep(150);
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x, y }] });
      await sleep(2500);
    }
  }

  // 2. 精确定位"加入购物车" — 找文字是"加入购物车"且有合理尺寸的元素
  console.log("\n=== 2. 精确定位'加入购物车' ===");
  const cartBtn = await E(`(function(){
    var all = document.querySelectorAll("*");
    var candidates = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el.offsetParent) continue;
      var t = (el.textContent||"").trim();
      // 精确匹配"加入购物车"且子元素不超过3个（避免匹配到大容器）
      if (t === "加入购物车" && el.children.length <= 3) {
        var rect = el.getBoundingClientRect();
        candidates.push({
          tag: el.tagName, cls: (el.className+"").slice(0, 50),
          x: Math.round(rect.x), y: Math.round(rect.y),
          w: Math.round(rect.width), h: Math.round(rect.height),
          children: el.children.length,
        });
      }
    }
    // 按尺寸过滤：按钮型元素（w>100, h>30, h<80）
    var btns = candidates.filter(function(c){ return c.w > 100 && c.h > 30 && c.h < 80; });
    if (btns.length === 0) btns = candidates.filter(function(c){ return c.h > 10; });
    return JSON.stringify({ all: candidates, buttons: btns }, null, 2);
  })()`);
  console.log(cartBtn);

  // 3. 也扫描弹窗容器
  console.log("\n=== 3. 弹窗容器 ===");
  const popupContainer = await E(`(function(){
    // 找所有尺寸>200x200的可见元素中，位置在页面下半部分的
    var all = document.querySelectorAll("*");
    var result = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el.offsetParent) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width > 300 && rect.height > 100 && rect.y > 200) {
        var hasCart = (el.textContent||"").includes("加入购物车");
        if (hasCart) {
          result.push({
            tag: el.tagName, cls: (el.className+"").slice(0, 60),
            x: Math.round(rect.x), y: Math.round(rect.y),
            w: Math.round(rect.width), h: Math.round(rect.height),
            zIndex: getComputedStyle(el).zIndex,
            position: getComputedStyle(el).position,
          });
        }
      }
    }
    return JSON.stringify(result, null, 2);
  })()`);
  console.log(popupContainer);

  // 4. 找弹窗底部的提交按钮区域
  console.log("\n=== 4. 弹窗底部按钮 ===");
  const bottomBtns = await E(`(function(){
    // 找 y>400 区域中所有按钮型元素
    var all = document.querySelectorAll("button, [class*=btn], [class*=submit], [class*=confirm], [role=button]");
    var result = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el.offsetParent) continue;
      var rect = el.getBoundingClientRect();
      if (rect.y > 300 && rect.width > 100) {
        result.push({
          tag: el.tagName, cls: (el.className+"").slice(0, 50),
          text: (el.textContent||"").trim().slice(0, 30),
          x: Math.round(rect.x), y: Math.round(rect.y),
          w: Math.round(rect.width), h: Math.round(rect.height),
        });
      }
    }

    // 也找所有含"加入购物车"的元素所属的父容器
    if (result.length === 0) {
      var spans = document.querySelectorAll("span, div");
      for (var i = 0; i < spans.length; i++) {
        if (!spans[i].offsetParent) continue;
        if ((spans[i].textContent||"").trim() === "加入购物车") {
          // 递归往上找第一个尺寸合理的元素
          var p = spans[i];
          for (var j = 0; j < 5; j++) {
            if (!p || p === document.body) break;
            var pr = p.getBoundingClientRect();
            if (pr.width > 100 && pr.height > 30 && pr.height < 80) {
              result.push({
                tag: p.tagName, cls: (p.className+"").slice(0, 50),
                text: "加入购物车(父元素)",
                x: Math.round(pr.x), y: Math.round(pr.y),
                w: Math.round(pr.width), h: Math.round(pr.height),
              });
              break;
            }
            p = p.parentElement;
          }
        }
      }
    }
    return JSON.stringify(result, null, 2);
  })()`);
  console.log(bottomBtns);

  await ws.close();
  console.log("\n=== DONE ===");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
