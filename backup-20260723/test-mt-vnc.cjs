// 美团 VNC+CDP Hybrid 验证 v5 — 提取 POI ID 直接导航进店
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
  console.log("=".repeat(60));
  console.log("🔍 美团 VNC+CDP Hybrid 验证 v5");
  console.log("=".repeat(60));

  // Step 1: 扫描
  console.log("\n📋 Step 1: 扫描 tab...");
  const tabs = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
  const pageTabs = tabs.filter(t => t.type === "page");
  pageTabs.forEach((t, i) => {
    console.log(`   [${i}] ${(t.title||"").slice(0,30)} | ${(t.url||"").slice(0,80)}`);
  });

  // Step 2: 找美团 tab
  console.log("\n📋 Step 2: 找美团 tab...");
  let mtTab = pageTabs.find(t => t.url && t.url.includes("mindex/home"));
  if (!mtTab) mtTab = pageTabs.find(t => t.url && t.url.includes("waimai.meituan") && !t.url.includes("search"));
  if (!mtTab) mtTab = pageTabs.find(t => t.url && t.url.includes("waimai.meituan"));
  if (!mtTab) { console.log("❌ 没找到"); return; }
  console.log(`✅ ${mtTab.url.slice(0, 100)}`);

  // Step 3: 连接 + 回首页
  console.log("\n📋 Step 3: 连接...");
  const s = await connectToTab(mtTab.webSocketDebuggerUrl);
  const curUrl = await evalText(s, "location.href");
  if (curUrl.includes("search")) {
    await s.send("Page.navigate", { url: "https://h5.waimai.meituan.com/waimai/mindex/home" });
    await sleep(5000);
  }
  console.log("✅ 已就绪");

  // Step 4: 搜索
  console.log("\n📋 Step 4: 搜索'一点点'...");
  await evalText(s, `(function(){
    var el = document.querySelector("[class*=search]"); if (el) el.click();
    else { var i=document.querySelector('input[type=text]'); if(i){i.focus();i.click();} }
  })()`);
  await sleep(1500);
  await evalText(s, `(function(){
    var i=document.querySelector('input[type=text],input[type=search]');
    if(!i)return; i.focus();
    var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
    s.call(i,"一点点"); i.dispatchEvent(new Event("input",{bubbles:true,composed:true}));
  })()`);
  await sleep(2000);
  await s.send("Input.dispatchKeyEvent", { type:"keyDown", key:"Enter", code:"Enter", keyCode:13, windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 });
  await sleep(100);
  await s.send("Input.dispatchKeyEvent", { type:"char", text:"\r", key:"Enter" });
  await sleep(100);
  await s.send("Input.dispatchKeyEvent", { type:"keyUp", key:"Enter", code:"Enter", keyCode:13, windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 });
  await sleep(5000);
  console.log("✅ 搜索完成");

  // Step 5: 提取 POI ID
  console.log("\n📋 Step 5: 提取店铺 POI ID...");
  const poiId = await evalText(s, `(function(){
    // 方案A: 从 JS 全局变量/React fiber 中找
    var scripts = document.querySelectorAll("script");
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i].textContent || "";
      var m = s.match(/"poi_id_str"\s*:\s*"?(\\d+)"?/);
      if (m) return "script:" + m[1];
    }
    // 方案B: 从页面 hidden input 找
    var inputs = document.querySelectorAll("input[type=hidden]");
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].value && /^\\d{5,}$/.test(inputs[i].value)) return "input:" + inputs[i].value;
    }
    // 方案C: 从 __INITIAL_STATE__ 或 __NEXT_DATA__ 找
    if (window.__INITIAL_STATE__) {
      try { return "state:" + JSON.stringify(Object.keys(window.__INITIAL_STATE__)).slice(0,100); } catch(e){}
    }
    // 方案D: 搜索 DOM 中所有数字串
    var text = document.body?.innerText || "";
    // 找店铺名后的数字ID模式
    var m2 = text.match(/1点点[^\\d]*(\\d{6,})/);
    if (m2) return "text:" + m2[1];
    return "not_found";
  })()`);
  console.log(`   POI ID: ${poiId}`);

  // 如果没有 POI ID，尝试直接从 URL 进入已知店铺
  if (poiId === "not_found" || !poiId.match(/\d{5,}/)) {
    // 尝试另一种方式：直接搜店铺的 DOM 数据属性
    const poiDom = await evalText(s, `(function(){
      var all = document.querySelectorAll("[data-poi], [data-poiid], [data-poi-id], [data-spm]");
      for (var i = 0; i < Math.min(all.length, 5); i++) {
        var el = all[i];
        var attrs = [];
        for (var j = 0; j < el.attributes.length; j++) {
          attrs.push(el.attributes[j].name + "=" + el.attributes[j].value.slice(0,30));
        }
        // 返回前几个元素的属性
      }
      return "checked_" + all.length + "_elems";
    })()`);
    console.log(`   DOM data: ${poiDom}`);
  }

  // Step 6: 直接用 Page.navigate 进店（如果拿到了 POI ID）
  console.log("\n📋 Step 6: 进店...");
  const idMatch = poiId.match(/(\d{5,})/);
  if (idMatch) {
    const id = idMatch[1];
    const menuUrl = `https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=${id}`;
    console.log(`   导航到: ${menuUrl}`);
    await s.send("Page.navigate", { url: menuUrl });
    await sleep(6000);

    const menu = await evalText(s, "(function(){ var t=document.body?.innerText||''; return 'url='+location.href.slice(0,60)+' len='+t.length+' hasFood='+(t.includes('¥')&&t.split('\\n').length>10)+' preview='+t.split('\\n').slice(0,12).join(' | ').slice(0,400); })()");
    console.log(`   菜单: ${menu}`);
    if (menu.includes("网络好像不太给力")) {
      console.log("   ❌ 直接导航菜单页被风控！");
    } else if (menu.includes("hasFood=true")) {
      console.log("   ✅ 菜单页加载成功！");
    }
  } else {
    // 方案B: 不做搜索，直接从首页点进店（首页的店铺卡片可能是可点击的）
    console.log("   没拿到 POI ID，换个思路：从首页直接点店铺（不搜）...");
    await s.send("Page.navigate", { url: "https://h5.waimai.meituan.com/waimai/mindex/home" });
    await sleep(5000);

    // 首页点击店铺 — 三管齐下
    const homeClick = await evalText(s, `(function(){
      // 找第一个店铺卡片
      var cards = document.querySelectorAll("[class*=shop], [class*=store], [class*=poi], [class*=food]");
      for (var i = 0; i < cards.length; i++) {
        if (!cards[i].offsetParent) continue;
        var t = (cards[i].textContent || "");
        if (t.includes("月售") && t.includes("起送")) {
          // 模拟完整点击事件链
          cards[i].dispatchEvent(new MouseEvent("mousedown", {bubbles:true}));
          cards[i].dispatchEvent(new MouseEvent("mouseup", {bubbles:true}));
          cards[i].dispatchEvent(new MouseEvent("click", {bubbles:true}));
          cards[i].click();
          return "clicked_card:" + t.slice(0,30);
        }
      }
      return "no_card";
    })()`);
    console.log(`   首页点击: ${homeClick}`);
    await sleep(5000);

    const menu2 = await evalText(s, "(function(){ var t=document.body?.innerText||''; return 'url='+location.href.slice(0,60)+' isMenu='+(t.includes('购物车')||t.includes('去结算')||(t.includes('¥')&&t.includes('加入')))+' preview='+t.split('\\n').slice(0,10).join(' | ').slice(0,300); })()");
    console.log(`   菜单: ${menu2}`);
  }

  // Step 7: 加购
  console.log("\n📋 Step 7: 加购...");
  const added = await evalText(s, `(function(){
    var btns = document.querySelectorAll("[class*=add-], [class*=mBtnGroup], [class*=spec-add]");
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].offsetParent) { btns[i].click(); return "added_" + i; }
    }
    return "no_btn";
  })()`);
  console.log(`   加购: ${added}`);
  await sleep(2000);
  const cart = await evalText(s, "document.querySelector('[class*=cart]')?.textContent?.trim()?.slice(0,80) || 'no_cart'");
  console.log(`   购物车: ${cart}`);

  await s.close();
  console.log("\n" + "=".repeat(60));
  console.log("✅ v5 完成");
  console.log("=".repeat(60));
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
