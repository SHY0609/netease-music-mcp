// 美团全流程 v2 — 深入 dFooter 内部结构，精准点击
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
  console.log("tab:", mtTab.url.slice(0, 80));

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

  // 1. 弹窗还开着吗？
  let popupOpen = await E("!!(document.body?.innerText||'').includes('加入购物车')");
  console.log("弹窗开着:", popupOpen);

  if (popupOpen !== "true") {
    // 重新打开
    console.log("重新打开...");
    await E("window.scrollTo(0,0)"); await sleep(800);
    const pos = await E(`(function(){
      var b=document.querySelector("[class*=mBtnGroup]");
      if(!b)return null;
      var r=b.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
    })()`);
    if (pos) {
      const {x,y}=JSON.parse(pos);
      await send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y}]});
      await sleep(150);
      await send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[{x,y}]});
      await sleep(3000);
    }
  }

  // 2. 深入 dFooter 结构
  console.log("\n=== dFooter 内部结构 ===");
  const footerStruct = await E(`(function(){
    var footer = document.querySelector("[class*=dFooter], [class*=submitBar], [class*=bottomBar]");
    if (!footer) return "no_footer";

    function show(el, depth) {
      if (depth > 5) return "";
      var tag = el.tagName;
      var cls = (el.className+"").slice(0, 40);
      var text = el.children.length === 0 ? " \\"" + (el.textContent||"").trim().slice(0, 30) + "\\"" : "";
      var r = el.getBoundingClientRect();
      var dims = " (" + Math.round(r.width) + "x" + Math.round(r.height) + ")";
      var reactKeys = Object.keys(el).filter(function(k){ return k.startsWith("__react"); });

      var line = "  ".repeat(depth) + tag + "." + cls + dims + text;
      if (reactKeys.length) line += " [react:" + reactKeys.join(",") + "]";

      var out = line;
      for (var i = 0; i < el.children.length; i++) {
        out += "\\n" + show(el.children[i], depth + 1);
      }
      return out;
    }
    return show(footer, 0);
  })()`);
  console.log(footerStruct);

  // 3. 找 dFooter 内部所有带 React 事件的元素
  console.log("\n=== dFooter 内 React 事件元素 ===");
  const reactInFooter = await E(`(function(){
    var footer = document.querySelector("[class*=dFooter]");
    if (!footer) return "no_footer";
    var all = footer.querySelectorAll("*");
    var result = [];
    for (var i = 0; i < all.length; i++) {
      var keys = Object.keys(all[i]).filter(function(k){ return k.startsWith("__react"); });
      if (keys.length > 0) {
        var r = all[i].getBoundingClientRect();
        result.push({
          tag: all[i].tagName, cls: (all[i].className+"").slice(0, 40),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          keys: keys,
        });
      }
    }
    return JSON.stringify(result, null, 2);
  })()`);
  console.log(reactInFooter);

  // 4. 尝试点击 dFooter 的每一个子元素
  console.log("\n=== 尝试点击 dFooter 子元素 ===");
  const childrenCoords = await E(`(function(){
    var footer = document.querySelector("[class*=dFooter]");
    if (!footer) return "[]";
    var kids = [];
    for (var i = 0; i < footer.children.length; i++) {
      var c = footer.children[i];
      if (!c.offsetParent) continue;
      var r = c.getBoundingClientRect();
      kids.push({
        idx: i, tag: c.tagName,
        cls: (c.className+"").slice(0, 30),
        text: (c.textContent||"").trim().slice(0, 20),
        x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2),
        w: Math.round(r.width), h: Math.round(r.height),
      });
    }
    return JSON.stringify(kids, null, 2);
  })()`);
  console.log(childrenCoords);

  // 5. 精准找 addToCartBtn_bQzcZn 按钮
  console.log("\n=== 精准定位 addToCartBtn ===");
  const exactBtn = await E(`(function(){
    var btn = document.querySelector("[class*=addToCartBtn]");
    if (!btn) return "no_btn";
    var r = btn.getBoundingClientRect();

    // 检查 React handlers
    var ehKey = Object.keys(btn).find(function(k){ return k.includes("EventHandlers"); });
    var handlers = [];
    if (ehKey) {
      var eh = btn[ehKey];
      handlers = Object.keys(eh||{}).filter(function(k){ return k.startsWith("on") && typeof eh[k] === "function"; });
      // 也检查 fiber props
      var fiberKey = Object.keys(btn).find(function(k){ return k.includes("Fiber") || k.includes("InternalInstance"); });
      if (fiberKey) {
        var fiber = btn[fiberKey];
        if (fiber && fiber.memoizedProps) {
          var props = fiber.memoizedProps;
          var propHandlers = Object.keys(props).filter(function(k){ return k.startsWith("on") && typeof props[k] === "function"; });
          handlers = handlers.concat(propHandlers);
        }
      }
    }

    return JSON.stringify({
      x: Math.round(r.x + r.width/2),
      y: Math.round(r.y + r.height/2),
      w: Math.round(r.width), h: Math.round(r.height),
      cls: (btn.className+"").slice(0, 40),
      handlers: handlers,
    });
  })()`);
  console.log(exactBtn);

  if (exactBtn !== "no_btn") {
    const eb = JSON.parse(exactBtn);
    console.log(`\n=== 点击 addToCartBtn (${eb.x}, ${eb.y}) handlers=${eb.handlers.join(",")} ===`);

    // 先试 touch
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: eb.x, y: eb.y }] });
    await sleep(150);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: eb.x, y: eb.y }] });
    await sleep(2500);

    let result = await E(`(function(){
      var t = document.body?.innerText || "";
      return JSON.stringify({popupOpen: t.includes("加入购物车"), bottom: t.split("\\n").slice(-6).join(" | ")});
    })()`);
    console.log("Touch 结果:", result);

    // 如果弹窗还在，用 React fiber onClick
    if (result.includes('"popupOpen":true')) {
      console.log("\n=== Touch 没关闭弹窗，尝试 React fiber onClick ===");
      const reactResult = await E(`(function(){
        var btn = document.querySelector("[class*=addToCartBtn]");
        if (!btn) return "no_btn";
        var fiberKey = Object.keys(btn).find(function(k){ return k.includes("Fiber") || k.includes("InternalInstance"); });
        if (!fiberKey) return "no_fiber";
        var fiber = btn[fiberKey];
        if (!fiber || !fiber.memoizedProps) return "no_memoizedProps";

        var props = fiber.memoizedProps;
        var handlerNames = Object.keys(props).filter(function(k){ return k.startsWith("on") && typeof props[k] === "function"; });
        if (handlerNames.length === 0) {
          // 往上找 stateNode 或 return
          var node = fiber;
          for (var i = 0; i < 5; i++) {
            node = node["return"] || node.stateNode;
            if (!node) break;
            if (node.memoizedProps) {
              var h = Object.keys(node.memoizedProps).filter(function(k){ return k.startsWith("on"); });
              if (h.length > 0) {
                handlerNames = h;
                props = node.memoizedProps;
                break;
              }
            }
          }
        }

        if (handlerNames.length > 0) {
          // 调用第一个 onClick handler
          var handler = props[handlerNames[0]];
          if (typeof handler === "function") {
            try {
              handler({preventDefault:function(){}, stopPropagation:function(){}, nativeEvent:{}});
              return "called " + handlerNames[0];
            } catch(e) { return "error: " + e.message; }
          }
        }
        return "no_click_handler found=" + handlerNames.join(",");
      })()`);
      console.log("React:", reactResult);
      await sleep(2000);

      result = await E(`(function(){
        var t = document.body?.innerText || "";
        return JSON.stringify({popupOpen: t.includes("加入购物车"), bottom: t.split("\\n").slice(-6).join(" | ")});
      })()`);
      console.log("React 后:", result);
    }
  }

  await ws.close();
  console.log("\n=== DONE ===");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
