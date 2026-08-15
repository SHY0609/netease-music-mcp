// 美团加购测试 v2 — CDP 鼠标坐标点击 + 按钮子元素
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
  let mtTab = tabs.find(t => t.url && t.url.includes("meituan") && t.url.includes("menu"));
  if (!mtTab) {
    // 用上一轮进店的 tab
    mtTab = tabs.find(t => t.url && t.url.includes("meituan") && !t.url.includes("search"));
  }
  if (!mtTab) { console.log("❌ 没找到菜单 tab"); return; }
  console.log("tab:", mtTab.url.slice(0, 100));

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
  await send("Page.enable");
  const E = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }); return r?.result?.value || ""; };

  // 1. 深入分析第一个有加购按钮的商品
  console.log("\n=== 1. 加购按钮内部结构 ===");
  const btnStruct = await E(`(function(){
    // 找第一个 btnGroup
    var container = document.querySelector("[class*=btnGroup], [class*=addBtnWrap], [class*=spec-add]");
    if (!container) return "no_btnGroup";

    // 列出直接子元素
    var kids = [];
    for (var i = 0; i < container.children.length; i++) {
      var c = container.children[i];
      var rect = c.getBoundingClientRect();
      kids.push({
        tag: c.tagName,
        cls: (c.className+"").slice(0,30),
        text: (c.textContent||"").trim().slice(0,10),
        visible: !!c.offsetParent,
        rect: {x:Math.round(rect.x), y:Math.round(rect.y), w:Math.round(rect.width), h:Math.round(rect.height)}
      });
    }

    // 也看 container 本身
    var cr = container.getBoundingClientRect();
    return JSON.stringify({
      containerTag: container.tagName,
      containerCls: (container.className+"").slice(0,50),
      containerRect: {x:Math.round(cr.x), y:Math.round(cr.y), w:Math.round(cr.width), h:Math.round(cr.height)},
      children: kids,
      // 父元素信息
      parentTag: container.parentElement?.tagName,
      parentCls: (container.parentElement?.className+"").slice(0,40),
      grandparentCls: (container.parentElement?.parentElement?.className+"").slice(0,40),
    });
  })()`);
  console.log(btnStruct);

  // 2. 解析按钮坐标，用 CDP 鼠标精确点击 +
  const btnData = JSON.parse(btnStruct);
  if (btnData.children) {
    console.log("\n=== 2. CDP 鼠标点击 + ===");
    // 找 children 中看起来像 + 的那个（通常是最右边/文字是+的）
    const plusChild = btnData.children.find(c => c.text === "+" || c.cls.includes("plus") || c.cls.includes("increase"));
    const target = plusChild || btnData.children[btnData.children.length - 1]; // 默认点最后一个子元素（通常是+）

    if (target && target.visible !== false) {
      const x = target.rect.x + target.rect.w / 2;
      const y = target.rect.y + target.rect.h / 2;
      console.log(`   目标: ${target.tag}.${target.cls} text="${target.text}"`);
      console.log(`   坐标: (${x}, ${y}) size=${target.rect.w}x${target.rect.h}`);

      // CDP 原生鼠标点击
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sleep(50);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await sleep(80);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await sleep(1500);

      console.log("   ✅ CDP 鼠标点击完成");
    } else {
      // 没子元素，直接点 container
      const cr = btnData.containerRect;
      const cx = cr.x + cr.w / 2;
      const cy = cr.y + cr.h / 2;
      console.log(`   直接点 container: (${cx}, ${cy})`);

      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
      await sleep(50);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
      await sleep(80);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
      await sleep(1500);
    }
  }

  // 3. 检查结果
  console.log("\n=== 3. 加购后检查 ===");
  const result = await E(`(function(){
    var t = document.body?.innerText || "";

    // 检查是否有数量选择器出现（说明加购成功）
    var hasNumSelector = !!document.querySelector("[class*=numSelect], [class*=countCtrl], [class*=amount]");

    // 检查购物车
    var cartEls = document.querySelectorAll("[class*=cart], [class*=Cart]");
    var cartInfo = [];
    for (var i = 0; i < cartEls.length; i++) {
      if (cartEls[i].offsetParent) {
        cartInfo.push((cartEls[i].textContent||"").trim().slice(0, 60));
      }
    }

    // 检查是否有 "已选" 或数量标记
    var hasSelected = t.includes("已选");

    // 检查底部
    var bottom = t.split("\\n").slice(-10).join(" | ");

    return JSON.stringify({
      hasNumSelector: hasNumSelector,
      cartInfo: cartInfo,
      hasSelected: hasSelected,
      bottomArea: bottom,
    });
  })()`);
  console.log(result);

  // 4. 如果没成功，尝试点第二个商品
  const r = JSON.parse(result);
  if (!r.hasNumSelector && r.cartInfo.length === 0) {
    console.log("\n=== 4. 尝试 JS 点击（带 React fiber）===");
    const reactAdd = await E(`(function(){
      // 找 btnGroup，遍历所有父元素找 React 事件
      var btns = document.querySelectorAll("[class*=btnGroup], [class*=sqt-menu-add]");
      for (var i = 0; i < btns.length; i++) {
        var el = btns[i];
        if (!el.offsetParent) continue;

        // 在 el 及其父元素上找 React props
        var node = el;
        for (var j = 0; j < 5; j++) {
          var rk = Object.keys(node).find(function(k){ return k.startsWith("__reactProps"); });
          if (rk) {
            var props = node[rk];
            var handlers = Object.keys(props||{}).filter(function(k){ return k.startsWith("on") && k !== "onTouchStart" && k !== "onTouchEnd"; });
            // 试触发 onMouseDown / onTouchStart / onClick
            if (props.onTouchStart) {
              try { props.onTouchStart({preventDefault:function(){}, stopPropagation:function(){}, touches:[], targetTouches:[], changedTouches:[]}); } catch(e){}
            }
            if (props.onClick) {
              try { props.onClick({preventDefault:function(){}, stopPropagation:function(){}}); } catch(e){}
            }
            return "react_fired handlers=" + handlers.join(",") + " at_level=" + j + " tag=" + node.tagName + " cls=" + ((node.className+"").slice(0,25));
          }
          node = node.parentElement;
          if (!node) break;
        }
      }
      return "no_react_props";
    })()`);
    console.log(reactAdd);
    await sleep(2000);

    const result2 = await E(`(function(){
      var t = document.body?.innerText || "";
      var bottom = t.split("\\n").slice(-8).join(" | ");
      return "hasSelected=" + t.includes("已选") + " bottom=" + bottom;
    })()`);
    console.log("二次检查:", result2);
  }

  await ws.close();
  console.log("\n=== DONE ===");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
