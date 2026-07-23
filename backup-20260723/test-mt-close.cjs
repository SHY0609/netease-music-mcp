// 美团 — 点蔓越莓奶绿，大杯/三分糖/标准冰
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
  const mtTab = tabs.find(t => t.url && t.url.includes("meituan"));
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

  // Step 1: 找"蔓越莓奶绿"的 mBtnGroup
  console.log("Step 1: 找'蔓越莓奶绿'的按钮");
  await E("window.scrollTo(0, 800)"); // 从之前经验，大概在下方
  await sleep(1000);

  // 精确找法：遍历所有 mBtnGroup，检查所属商品是否含"蔓越莓奶绿"
  let btnPos = await E(`(function(){
    var groups = document.querySelectorAll("[class*=mBtnGroup], [class*=btnGroup]");
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!g.offsetParent) continue;
      var r = g.getBoundingClientRect();
      if (r.y < 0 || r.y > 800) continue;
      // 找 g 所属的商品容器
      var p = g.closest("[class*=spu], dd, li, [class*=food], [class*=item]");
      if (p && (p.textContent||"").includes("蔓越莓奶绿")) {
        return JSON.stringify({
          x: Math.round(r.x + r.width/2),
          y: Math.round(r.y + r.height/2),
          w: Math.round(r.width), h: Math.round(r.height),
        });
      }
    }
    // 兜底：找含"蔓越莓奶绿"文字的元素，往下找按钮
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      if (!all[i].offsetParent) continue;
      if ((all[i].textContent||"").trim() === "蔓越莓奶绿" && all[i].children.length === 0) {
        // 往上找 spu 容器，然后往里找按钮
        var spu = all[i].closest("[class*=spu], dd, li");
        if (spu) {
          var btn = spu.querySelector("[class*=mBtnGroup], [class*=btnGroup]");
          if (btn && btn.offsetParent) {
            var br = btn.getBoundingClientRect();
            return JSON.stringify({x:Math.round(br.x+br.width/2),y:Math.round(br.y+br.height/2),w:Math.round(br.width),h:Math.round(br.height)});
          }
        }
      }
    }
    return "not_found";
  })()`);

  if (btnPos === "not_found") {
    // 再滚动一点
    console.log("  没找到，再滚动...");
    await E("window.scrollBy(0, 400)");
    await sleep(1000);
    btnPos = await E(`(function(){
      var groups=document.querySelectorAll("[class*=mBtnGroup],[class*=btnGroup]");
      for(var i=0;i<groups.length;i++){
        if(!groups[i].offsetParent)continue;
        var r=groups[i].getBoundingClientRect();
        if(r.y<0||r.y>800)continue;
        var p=groups[i].closest("[class*=spu],dd,li");
        if(p&&(p.textContent||"").includes("蔓越莓奶绿")){
          return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});
        }
      }
      return "not_found";
    })()`);
  }

  if (btnPos === "not_found") {
    console.log("❌ 还是没找到蔓越莓奶绿的按钮");
    await ws.close(); return;
  }

  const bp = JSON.parse(btnPos);
  console.log(`  mBtnGroup at (${bp.x}, ${bp.y}) size=${bp.w}x${bp.h}`);

  // 如果 y > 700，滚到按钮在视口中间
  if (bp.y > 700) {
    const scrollBy = bp.y - 350;
    console.log(`  按钮在视口外(y=${bp.y})，滚动 ${scrollBy}px`);
    await E(`window.scrollBy(0, ${scrollBy})`);
    await sleep(1000);
    // 重新获取坐标
    const newPos = await E(`(function(){
      var g=document.querySelector("[class*=mBtnGroup]");
      if(!g)return null;
      var all=document.querySelectorAll("[class*=mBtnGroup],[class*=btnGroup]");
      for(var i=0;i<all.length;i++){
        if(!all[i].offsetParent)continue;
        var p=all[i].closest("[class*=spu],dd,li");
        if(p&&(p.textContent||"").includes("蔓越莓奶绿")){
          var r=all[i].getBoundingClientRect();
          return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
        }
      }
      return null;
    })()`);
    if (newPos) {
      const np = JSON.parse(newPos);
      console.log(`  新坐标: (${np.x}, ${np.y})`);
      bp.x = np.x; bp.y = np.y;
    }
  }

  // Touch!
  console.log(`  Touch (${bp.x}, ${bp.y})`);
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bp.x, y: bp.y }] });
  await sleep(150);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: bp.x, y: bp.y }] });
  await sleep(3000);

  // Step 2: 检查弹窗
  const popup = await E("!!(document.body?.innerText||'').includes('加入购物车')");
  console.log("Step 2: 弹窗打开:", popup);
  if (popup !== "true") { console.log("❌ 弹窗没开"); await ws.close(); return; }

  // Step 3: 选规格 — 大杯、三分糖、标准冰
  console.log("Step 3: 选规格");

  // 读弹窗里的规格选项
  const specInfo = await E(`(function(){
    var attrs = document.querySelectorAll("[class*=attr_]");
    var result = [];
    for (var i = 0; i < attrs.length; i++) {
      if (!attrs[i].offsetParent) continue;
      var r = attrs[i].getBoundingClientRect();
      var text = (attrs[i].textContent||"").trim().slice(0, 80);

      // 找里面的可选子项
      var children = [];
      var kids = attrs[i].querySelectorAll("span, div");
      for (var j = 0; j < kids.length; j++) {
        if (!kids[j].offsetParent) continue;
        var kt = (kids[j].textContent||"").trim();
        if (kt.length > 1 && kt.length < 10 && kids[j].children.length === 0) {
          var kr = kids[j].getBoundingClientRect();
          children.push({text: kt, x: Math.round(kr.x+kr.width/2), y: Math.round(kr.y+kr.height/2)});
        }
      }

      result.push({
        group: text.slice(0, 20),
        options: children,
      });
    }
    return JSON.stringify(result, null, 2);
  })()`);
  console.log(specInfo);

  // 解析规格，逐一点击
  const specs = JSON.parse(specInfo);
  const selections = { "大杯": true, "三分糖": true, "标准冰": true };

  for (const group of specs) {
    for (const opt of group.options) {
      if (selections[opt.text]) {
        console.log(`  点 ${opt.text} (${opt.x}, ${opt.y})`);
        await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: opt.x, y: opt.y }] });
        await sleep(150);
        await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: opt.x, y: opt.y }] });
        await sleep(800);
      }
    }
  }

  // Step 4: 点"加入购物车"
  console.log("Step 4: 加入购物车");
  const cartBtn = await E(`(function(){
    var btn = document.querySelector("[class*=addToCartBtn]");
    if (!btn) return null;
    var r = btn.getBoundingClientRect();
    return JSON.stringify({x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)});
  })()`);

  if (cartBtn) {
    const cb = JSON.parse(cartBtn);
    console.log(`  Touch addToCartBtn (${cb.x}, ${cb.y})`);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cb.x, y: cb.y }] });
    await sleep(150);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: cb.x, y: cb.y }] });
    await sleep(2500);
  }

  // Step 5: 结果
  const result = await E(`(function(){
    var t = document.body?.innerText || "";
    var popupOpen = t.includes("加入购物车");
    return JSON.stringify({
      popupOpen: popupOpen,
      bottom: t.split("\\n").filter(Boolean).slice(-6).join(" | "),
    });
  })()`);
  console.log("Step 5: 结果", result);

  await ws.close();
  console.log("\n=== DONE ===");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
