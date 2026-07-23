// 美团搜索结果 DOM 深度扫描 v2 — 先 fresh 导航再搜
const http = require("http"), WebSocket = require("ws");
const CDP_PORT = 9222;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); }).on("error", reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connectToTab(tabUrl) {
  const ws = new WebSocket(tabUrl);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  const pending = new Map(); let cid = 0;
  ws.on("message", data => {
    try { const m = JSON.parse(data.toString()); if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); m.error ? r.reject(new Error(m.error.message||"cdp")) : r.resolve(m.result); } } catch {}
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++cid; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout:"+method)); } }, 20000);
  });
  await send("Runtime.enable"); await send("Page.enable");
  return { ws, send, close: () => ws.close() };
}

async function evalText(s, expr) {
  const r = await s.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  return r?.result?.value || "";
}

async function main() {
  const tabs = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
  let mtTab = tabs.find(t => t.url && t.url.includes("mindex/home"));
  if (!mtTab) mtTab = tabs.find(t => t.url && t.url.includes("meituan") && !t.url.includes("search"));
  if (!mtTab) mtTab = tabs.find(t => t.url && t.url.includes("meituan"));
  if (!mtTab) mtTab = tabs.find(t => t.type === "page" && t.url === "about:blank");

  console.log("连接:", mtTab.url.slice(0, 100));
  const s = await connectToTab(mtTab.webSocketDebuggerUrl);

  // 1. 导航到首页
  console.log("\n=== 1. fresh 导航到首页 ===");
  await s.send("Page.navigate", { url: "https://h5.waimai.meituan.com/waimai/mindex/home" });
  await sleep(6000);
  const homeLen = await evalText(s, "document.body?.innerText?.length || 0");
  console.log("首页 body 长度:", homeLen);
  if (homeLen < 200) {
    console.log("⚠️ 首页内容太少，再等 5s...");
    await sleep(5000);
    console.log("body 长度:", await evalText(s, "document.body?.innerText?.length || 0"));
  }

  // 2. 搜索
  console.log("\n=== 2. 搜索'一点点' ===");
  await evalText(s, `(function(){ var el=document.querySelector("[class*=search]"); if(el&&el.offsetParent)el.click(); })()`);
  await sleep(1500);
  await evalText(s, `(function(){
    var i=document.querySelector('input[type=text],input[type=search]');
    if(!i)return; i.focus();
    var ss=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
    ss.call(i,"一点点"); i.dispatchEvent(new Event("input",{bubbles:true,composed:true}));
  })()`);
  await sleep(2000);
  // CDP Enter
  for (const ev of [
    { type:"keyDown", key:"Enter", code:"Enter", keyCode:13, windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 },
    { type:"char", text:"\r", key:"Enter" },
    { type:"keyUp", key:"Enter", code:"Enter", keyCode:13, windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 },
  ]) { await s.send("Input.dispatchKeyEvent", ev); await sleep(100); }

  // 等搜索结果渲染
  console.log("等待搜索结果...");
  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    const len = await evalText(s, "document.body?.innerText?.length || 0");
    const hasYuan = await evalText(s, "!!(document.body?.innerText||'').includes('¥')");
    const url = await evalText(s, "location.href.slice(0, 60)");
    console.log(`  ${i+1}: body=${len} url=${url} has¥=${hasYuan}`);
    if (len > 500 && hasYuan === "true") break;
  }

  // 3. DOM 扫描
  console.log("\n=== 3. DOM 总览 ===");
  const summary = await evalText(s, `(function(){
    return JSON.stringify({
      bodyLen: (document.body?.innerText||"").length,
      totalElems: document.querySelectorAll("*").length,
      links: document.querySelectorAll("a").length,
      inputs: document.querySelectorAll("input").length,
      divs: document.querySelectorAll("div").length,
    });
  })()`);
  console.log(summary);

  // 4. 店铺卡片 DOM 树
  console.log("\n=== 4. 第一个店铺卡片结构 ===");
  const tree = await evalText(s, `(function(){
    function walk(el, depth, maxDepth) {
      if (depth > maxDepth || !el) return "";
      var tag = el.tagName || "?";
      var cls = typeof el.className === "string" ? el.className.split(" ").slice(0,2).join(".") : "";
      var id = el.id ? "#" + el.id : "";
      var txt = (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3)
        ? " \\"" + el.textContent.trim().slice(0, 30) + "\\""
        : (el.children.length === 0 ? " \\"" + (el.textContent||"").trim().slice(0, 20) + "\\"" : "");
      var attr = [];
      var attrsToCheck = ["href","data-spm","data-poi","data-track","data-click","onclick","role"];
      for (var a = 0; a < attrsToCheck.length; a++) {
        var v = el.getAttribute(attrsToCheck[a]);
        if (v) attr.push(attrsToCheck[a] + "=" + (typeof v === "string" ? v.slice(0,40) : v));
      }

      var prefix = "  ".repeat(depth);
      var line = prefix + tag + id + (cls ? "." + cls : "") + (attr.length ? " [" + attr.join(",") + "]" : "") + txt + "\\n";

      if (depth < maxDepth) {
        for (var i = 0; i < Math.min(el.children.length, 6); i++) {
          line += walk(el.children[i], depth + 1, maxDepth);
        }
      }
      return line;
    }

    // 找第一个含"月售"和"起送"的元素，然后往上找根容器
    var all = document.querySelectorAll("*");
    var target = null;
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || "");
      if (all[i].offsetParent && t.includes("月售") && t.includes("起送") && all[i].children.length <= 3) {
        target = all[i];
        break;
      }
    }
    if (!target) return "NO_SHOP_FOUND bodyLen=" + (document.body?.innerText||"").length;

    // 往上走 5 级找根
    var root = target;
    for (var j = 0; j < 6; j++) {
      if (root.parentElement && root.parentElement.tagName !== "BODY" && root.parentElement.tagName !== "HTML") {
        root = root.parentElement;
      }
    }
    return walk(root, 0, 6) + "\\nROOT_IS: " + root.tagName + "." + ((root.className+"").split(" ")[0]||"");
  })()`);
  console.log(tree);

  // 5. React fiber 探索
  console.log("\n=== 5. React 事件处理器 ===");
  const react = await evalText(s, `(function(){
    var all = document.querySelectorAll("*");
    var results = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el.offsetParent) continue;
      var t = (el.textContent || "").trim();
      if (!t.includes("月售") || !t.includes("起送")) continue;

      // 从这个元素往上找 React props
      var p = el;
      for (var j = 0; j < 8; j++) {
        var keys = Object.keys(p);
        var propsKey = keys.find(function(k){ return k.startsWith("__reactProps"); });
        if (propsKey) {
          var props = p[propsKey];
          var handlerNames = Object.keys(props || {}).filter(function(k){ return k.startsWith("on") && typeof props[k] === "function"; });
          results.push({
            level: j,
            tag: p.tagName,
            cls: (p.className+"").slice(0, 30),
            handlers: handlerNames,
          });
        }
        p = p.parentElement;
        if (!p || p === document.body) break;
      }
      break; // 只查第一个匹配
    }
    return JSON.stringify(results, null, 2);
  })()`);
  console.log(react);

  // 6. 直接测试所有点击策略
  console.log("\n=== 6. 暴力点击测试 ===");
  const strategies = await evalText(s, `(function(){
    var results = [];

    // 策略A: 用 MouseEvent 模拟完整点击链
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el.offsetParent) continue;
      var t = (el.textContent || "").trim();
      if (t.includes("月售") && t.includes("起送") && el.children.length <= 3 && t.length < 100) {
        // 往上找最外层卡片容器
        var card = el;
        for (var j = 0; j < 6; j++) {
          var p = card.parentElement;
          if (!p || p === document.body) break;
          if ((p.className+"").includes("shop") || (p.className+"").includes("card") || (p.className+"").includes("item") || (p.className+"").includes("list")) card = p;
          else if (p.children.length === 1 && p.children[0] === card) card = p; // wrapper
          else break;
        }
        // 在卡片容器上触发完整事件
        ["mousedown","mouseup","click"].forEach(function(evt){
          card.dispatchEvent(new MouseEvent(evt, {bubbles:true, cancelable:true, view:window}));
        });
        // 也试试 touch 事件（移动端）
        ["touchstart","touchend"].forEach(function(evt){
          card.dispatchEvent(new TouchEvent(evt, {bubbles:true, cancelable:true}));
        });
        results.push("strategyA: card=" + card.tagName + "." + ((card.className+"").split(" ")[0]||""));
        break;
      }
    }

    // 策略B: 找到所有 A 标签看看
    var links = document.querySelectorAll("a");
    results.push("links_count=" + links.length);
    for (var i = 0; i < links.length; i++) {
      if (links[i].offsetParent) {
        results.push("  link["+i+"]: " + links[i].href.slice(0,60) + " text=" + (links[i].textContent||"").trim().slice(0,30));
      }
    }

    return results.join("\\n");
  })()`);
  console.log(strategies);

  // 7. 看看页面有没有跳转
  await sleep(3000);
  const finalUrl = await evalText(s, "location.href.slice(0, 80)");
  console.log("\n最终 URL:", finalUrl);
  console.log(finalUrl.includes("menu") ? "✅ 进店成功！" : "❌ 没跳转");

  await s.close();
  console.log("\n=== DONE ===");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
