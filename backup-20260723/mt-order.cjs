// mt-order — 美团 CDP 下单全流程
// 搜店→进店→选品→加购→结算→填单→提交
const http = require("http"), WebSocket = require("ws");
const CDP_PORT = 9222;
const HOME = "https://h5.waimai.meituan.com/waimai/mindex/home";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CDP 工具 ────────────────────────────────────
function httpGet(url) {
  return new Promise(r => { http.get(url, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { r(JSON.parse(d)) } catch { r([]) } }); }).on("error", () => r([])); });
}

async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  const pending = new Map(); let cid = 0;
  ws.on("message", data => {
    try { const m = JSON.parse(data.toString()); if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); m.error ? r.reject(new Error(m.error.message || "cdp")) : r.resolve(m.result); } } catch { }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++cid; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout:" + method)); } }, 20000);
  });
  await send("Runtime.enable"); await send("Page.enable");
  return { ws, send, close: () => ws.close() };
}

// ── 核心操作 ────────────────────────────────────

/** 在当前 tab 执行 JS，返回原始字符串 */
async function E(session, expr) {
  const r = await session.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  return r?.result?.value || "";
}

/** Touch 事件 */
async function touch(session, x, y) {
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await sleep(150);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x, y }] });
}

/** 安全 JSON parse */
function safeJson(raw) { try { return JSON.parse(raw || "{}"); } catch { return {}; } }

// ── 步骤函数 ────────────────────────────────────

/** 1. 连接美团 tab（优先找已有的，否则需要VNC手动打开首页） */
async function getMeituanTab() {
  const tabs = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
  // 优先：首页 > 任意美团页
  let t = tabs.find(t => t.url && t.url.includes("mindex/home"));
  if (!t) t = tabs.find(t => t.url && t.url.includes("meituan") && !t.url.includes("163"));
  if (!t) return null;
  return { tab: t, session: await cdpConnect(t.webSocketDebuggerUrl) };
}

/** 2. 确保定位为指定地址 */
async function ensureAddress(session, addrName) {
  const has = await E(session, `(document.body?.innerText||"").includes(${JSON.stringify(addrName)})?"yes":"no"`);
  if (has === "yes") return true;

  // 点地址栏
  await E(session, `(function(){var el=document.querySelector("[class*=addr]");if(el)el.click();})()`);
  await sleep(2000);

  // 直接点列表中的地址
  const pos = safeJson(await E(session, `(function(){
    var all=document.querySelectorAll("*");
    for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;
      var t=(all[i].textContent||"").trim();
      if(t.includes(${JSON.stringify(addrName)})&&t.length<20&&all[i].children.length<=2){
        var r=all[i].getBoundingClientRect();if(r.y>50)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
      }
    }return"{}";
  })()`));
  if (pos.x) await touch(session, pos.x, pos.y);
  await sleep(2000);
  return (await E(session, `(document.body?.innerText||"").includes(${JSON.stringify(addrName)})?"yes":"no"`)) === "yes";
}

/** 3. 搜索店铺并进店 */
async function searchAndEnter(session, shopName) {
  const curUrl = await E(session, "location.href");
  if (curUrl.includes("menu") && (await E(session, "document.body?.innerText||''")).includes(shopName.slice(0, 4))) {
    return true; // 已经在目标店铺菜单页
  }

  // 回首页
  if (!curUrl.includes("mindex/home")) {
    await session.send("Page.navigate", { url: HOME });
    await sleep(4000);
  }

  // 点搜索 → 输入 → Enter
  await E(session, `(function(){var el=document.querySelector("[class*=search]");if(el)el.click();})()`);
  await sleep(1500);
  await E(session, `(function(){var i=document.querySelector("input[type=text],input[type=search]");if(!i)return;i.focus();
    var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
    s.call(i,${JSON.stringify(shopName)});i.dispatchEvent(new Event("input",{bubbles:true,composed:true}));})()`);
  await sleep(2000);
  for (const ev of [
    { type: "keyDown", key: "Enter", code: "Enter", keyCode: 13, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    { type: "char", text: "\r", key: "Enter" },
    { type: "keyUp", key: "Enter", code: "Enter", keyCode: 13, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  ]) { await session.send("Input.dispatchKeyEvent", ev); await sleep(80); }
  await sleep(6000);

  // 进店 — 点第一个搜索结果
  const clicked = await E(session, `(function(){
    var all=document.querySelectorAll("*");
    for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;
      var t=(all[i].textContent||"").trim();
      if(t.includes("月售")&&t.includes("起送")&&all[i].children.length<=3&&t.length<100){
        var card=all[i];
        for(var j=0;j<6;j++){var p=card.parentElement;if(!p||p===document.body)break;
          if((p.className+"").includes("shop")||(p.className+"").includes("card")||(p.className+"").includes("item"))card=p;else break;}
        ["mousedown","mouseup","click"].forEach(function(e){card.dispatchEvent(new MouseEvent(e,{bubbles:true,cancelable:true,view:window}));});
        return"ok";
      }
    }return"nf";
  })()`);
  if (clicked !== "ok") return false;
  await sleep(5000);
  return (await E(session, "location.href")).includes("menu");
}

/** 4. 一次扫描全菜单，返回 [{name, price, y}] */
async function scanMenu(session) {
  await E(session, "window.scrollTo(0,0)"); await sleep(500);
  return JSON.parse(await E(session, `(function(){
    var items=document.querySelectorAll("[class*=spu],dd,li");var r=[];
    for(var i=0;i<items.length;i++){if(!items[i].offsetParent)continue;
      var n=items[i].querySelector("[class*=name],h4,[class*=title]");
      var name=n?(n.textContent||"").trim().slice(0,40):"";
      var pr=items[i].querySelector("[class*=price]");
      var price=pr?(pr.textContent||"").trim().slice(0,12):"";
      var rect=items[i].getBoundingClientRect();
      if(name)r.push({name:name,price:price,y:Math.round(rect.y)});
    }return JSON.stringify(r);
  })()`));
}

/** 5. 点击商品加购 — 自动检测按钮类型 */
async function addProduct(session, productName, specs) {
  // 一次扫描找到目标商品
  const all = await scanMenu(session);
  const target = all.find(m => m.name.includes(productName.slice(0, 4)));
  if (!target) return { ok: false, reason: "product_not_found", menu: all.slice(0, 20) };

  // 直接跳到目标位置
  await E(session, `window.scrollTo(0,${Math.max(0, target.y - 300)})`);
  await sleep(800);

  // 找按钮并判断类型
  const btnInfo = safeJson(await E(session, `(function(){
    var g=document.querySelectorAll("[class*=mBtnGroup],[class*=btnGroup]");
    for(var i=0;i<g.length;i++){if(!g[i].offsetParent)continue;
      var p=g[i];for(var j=0;j<5;j++){if(!p)break;
        if((p.textContent||"").includes(${JSON.stringify(productName.slice(0,6))})){
          var r=g[i].getBoundingClientRect();
          if(r.y>50&&r.y<750)return JSON.stringify({
            x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
            w:Math.round(r.width),h:Math.round(r.height),
            cls:(g[i].className+"").slice(0,30),type:r.width<=30?"direct":"spec"
          });
        }p=p.parentElement;}
    }return"{}";
  })()`));

  if (!btnInfo.x) return { ok: false, reason: "button_not_found" };

  // 点击按钮
  await touch(session, btnInfo.x, btnInfo.y);
  await sleep(3000);

  if (btnInfo.type === "spec") {
    // 规格弹窗模式
    const hasPopup = await E(session, "(document.body?.innerText||'').includes('加入购物车')?'yes':'no'");
    if (hasPopup !== "yes") return { ok: false, reason: "spec_popup_not_opened" };

    // 读取当前规格
    let cur = await E(session, `(function(){var m=(document.body?.innerText||"").match(/已选规格：([^\\n]*)/);return m?m[1]:"";})()`);

    // 选择规格
    if (specs && typeof specs === "object") {
      for (const [key, value] of Object.entries(specs)) {
        if (cur.includes(value)) continue; // 已选，跳过
        // 尝试 Touch
        const optPos = safeJson(await E(session, `(function(){
          var els=document.querySelectorAll("[class*=attr_] span,[class*=attr_] div");
          for(var i=0;i<els.length;i++){if(!els[i].offsetParent)continue;
            if((els[i].textContent||"").trim().indexOf(${JSON.stringify(value)})===0){
              var r=els[i].getBoundingClientRect();if(r.y>100&&r.y<650)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
            }
          }return"{}";
        })()`));
        if (optPos.x) { await touch(session, optPos.x, optPos.y); await sleep(600); }
        else {
          // Touch 没找到，尝试 Fiber onClick
          await E(session, `(function(){
            var els=document.querySelectorAll("[class*=attr_] span,[class*=attr_] div");
            for(var i=0;i<els.length;i++){if(!els[i].offsetParent)continue;
              if((els[i].textContent||"").trim().indexOf(${JSON.stringify(value)})===0){
                var n=els[i];for(var j=0;j<5;j++){
                  var fk=Object.keys(n).find(function(k){return k.includes("Fiber")||k.includes("InternalInstance");});
                  if(fk&&n[fk]&&n[fk].memoizedProps){
                    var mp=n[fk].memoizedProps;var hk=Object.keys(mp).find(function(k){return k.startsWith("on")&&typeof mp[k]==="function";});
                    if(hk){mp[hk]({preventDefault:function(){},stopPropagation:function(){}});return;}
                  }n=n.parentElement;if(!n)break;
                }
              }
            }
          })()`);
          await sleep(600);
        }
      }
    }

    // 验证规格
    cur = await E(session, `(function(){var m=(document.body?.innerText||"").match(/已选规格：([^\\n]*)/);return m?m[1]:"";})()`);

    // 点加入购物车
    const cartBtn = safeJson(await E(session, `(function(){
      var b=document.querySelector("[class*=addToCartBtn]");if(!b)return"{}";
      var r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`));
    if (cartBtn.x) await touch(session, cartBtn.x, cartBtn.y);
  }
  // direct 类型：点+按钮直接加购完成

  await sleep(3000);
  const result = safeJson(await E(session, `(function(){
    var t=document.body?.innerText||"";
    return JSON.stringify({added:!t.includes("加入购物车"),settle:t.includes("去结算")});})()`));
  return { ok: result.added, settle: result.settle, spec: btnInfo.type, currentSpecs: cur || "" };
}

/** 6. 去结算 → 填单 → 提交 */
async function checkoutAndSubmit(session, addressName, remark, useCoupons) {
  // 去结算
  const settleBtn = safeJson(await E(session, `(function(){
    var all=document.querySelectorAll("*");
    for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;
      if((all[i].textContent||"").trim()==="去结算"){
        var btn=all[i];for(var j=0;j<5;j++){var r=btn.getBoundingClientRect();if(r.width>60&&r.height>25&&r.y>200)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});btn=btn.parentElement;if(!btn)break;}
      }
    }return"{}";
  })()`));
  if (!settleBtn.x) return { ok: false, reason: "no_settle_button" };
  await touch(session, settleBtn.x, settleBtn.y);
  await sleep(5000);
  if (!(await E(session, "location.href")).includes("preview")) return { ok: false, reason: "not_on_preview" };

  // 地址
  const hasAddr = await E(session, `(document.body?.innerText||"").includes(${JSON.stringify(addressName)})?"yes":"no"`);
  if (hasAddr !== "yes") {
    await E(session, `(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;if((all[i].textContent||"").trim()==="选择收货地址"){all[i].scrollIntoView({block:"center"});return;}}})()`);
    await sleep(1000);
    const sel = safeJson(await E(session, `(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;if((all[i].textContent||"").trim()==="选择收货地址"){var r=all[i].getBoundingClientRect();if(r.y>0)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return"{}";})()`));
    if (sel.x) await touch(session, sel.x, sel.y);
    await sleep(2500);
    const lx = safeJson(await E(session, `(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;var t=(all[i].textContent||"").trim();if(t.includes(${JSON.stringify(addressName)})&&t.length<30){var r=all[i].getBoundingClientRect();if(r.y>50)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return"{}";})()`));
    if (lx.x) await touch(session, lx.x, lx.y);
    await sleep(2000);
  }

  // 备注
  if (remark) {
    const rmk = safeJson(await E(session, `(function(){
      var el=document.querySelector("[class*=remark2_]");if(!el)return"{}";
      el.scrollIntoView({block:"center"});var r=el.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`));
    await sleep(1000);
    if (rmk.x) { await touch(session, rmk.x, rmk.y); await sleep(2000); }
    await E(session, `(function(){var el=document.querySelector("input[type=text],textarea,[contenteditable=true]");if(!el)return;el.focus();
      var s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),"value");
      if(s&&s.set){s.set.call(el,${JSON.stringify(remark)});el.dispatchEvent(new Event("input",{bubbles:true,composed:true}));return;}
      el.textContent=${JSON.stringify(remark)};el.dispatchEvent(new Event("input",{bubbles:true}));})()`);
    await sleep(500);
    const done = safeJson(await E(session, `(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;if((all[i].textContent||"").trim()==="完成"){var r=all[i].getBoundingClientRect();if(r.width>30)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return"{}";})()`));
    if (done.x) await touch(session, done.x, done.y);
    await sleep(1000);
  }

  // 红包
  if (useCoupons) {
    const hbLine = safeJson(await E(session, `(function(){
      var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;
        var t=(all[i].textContent||"").trim();
        if((t==="美团红包"||t.includes("美团红包"))&&all[i].children.length===0&&t.length<10&&!t.includes("暂无可用")){
          var p=all[i].parentElement;for(var j=0;j<4;j++){if(!p)break;var r=p.getBoundingClientRect();if(r.width>200&&r.height>25)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});p=p.parentElement;}
        }
      }return"{}";
    })()`));
    if (hbLine.x) {
      await touch(session, hbLine.x, hbLine.y); await sleep(2500);
      // 切换到红包 tab
      const hbTabs = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
      const hbTab = hbTabs.find(t => t.url && t.url.includes("red_packet"));
      if (hbTab) {
        const oldWs = session.ws;
        const hbSession = await cdpConnect(hbTab.webSocketDebuggerUrl);
        // 选确认
        const ok = safeJson(await E(hbSession, `(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;if((all[i].textContent||"").trim()==="确认"){var r=all[i].getBoundingClientRect();if(r.width>30)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return"{}";})()`));
        if (ok.x) await touch(hbSession, ok.x, ok.y);
        await sleep(1500);
        hbSession.close();
        // 切回 preview tab
        session.ws = oldWs; // Note: 简化的 tab 切换，实际可能需要重连
      }
    }
  }

  // 提交订单
  await E(session, "window.scrollTo(0,document.body.scrollHeight)"); await sleep(800);
  const sub = safeJson(await E(session, `(function(){var b=document.querySelector("button.submit_QDYt9D");if(!b)return"{}";var r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`));
  if (sub.x) {
    await touch(session, sub.x, sub.y);
    await sleep(1000);
    await E(session, `(function(){var b=document.querySelector("button.submit_QDYt9D");if(!b)return;var n=b;for(var j=0;j<5;j++){var fk=Object.keys(n).find(function(k){return k.includes("Fiber")||k.includes("InternalInstance");});if(fk&&n[fk]&&n[fk].memoizedProps){var mp=n[fk].memoizedProps;var hk=Object.keys(mp).find(function(k){return k.startsWith("on")&&typeof mp[k]==="function";});if(hk){mp[hk]({preventDefault:function(){},stopPropagation:function(){}});return;}}n=n.parentElement;if(!n)break;}})()`);
    await sleep(5000);
  }

  const finalUrl = await E(session, "location.href");
  if (finalUrl.includes("order-detail")) {
    return { ok: true, status: "paid_or_pending", url: finalUrl };
  }
  return { ok: false, status: "403", previewUrl: "https://h5.waimai.meituan.com/waimai/mindex/preview?placeholder=1&redirectfrom=1" };
}

// ═══ 主入口 ═══════════════════════════════════════

/**
 * mt_order — 全流程下单
 * @param {Object} opts
 * @param {string} opts.shopName - 店铺名（如"一点点"、"肯德基"）
 * @param {string} opts.productName - 商品名（如"藏青盐咸奶绿"、"热辣香骨鸡"）
 * @param {Object} [opts.specs] - 规格选择，如 {份量:"大杯", 糖度:"三分糖"}
 * @param {string} [opts.addressName="黎先菜店"] - 收货地址
 * @param {string} [opts.remark] - 备注
 * @param {boolean} [opts.useCoupons=true] - 是否选红包
 * @returns {Object} { ok, status, previewUrl?, url? }
 */
async function mtOrder(opts = {}) {
  const { shopName, productName, specs, addressName = "黎先菜店", remark, useCoupons = true } = opts;
  if (!shopName || !productName) return { ok: false, reason: "need shopName and productName" };

  // 1. 连接
  const conn = await getMeituanTab();
  if (!conn) return { ok: false, reason: "no_meituan_tab", hint: "请先在VNC打开美团首页" };
  const { session } = conn;

  try {
    // 2. 定位
    const addrOk = await ensureAddress(session, addressName);
    if (!addrOk) return { ok: false, reason: "address_not_set" };

    // 3. 搜店进店
    const entered = await searchAndEnter(session, shopName);
    if (!entered) return { ok: false, reason: "shop_not_entered", hint: "搜索结果可能没有这家店" };

    // 4. 加购
    const cart = await addProduct(session, productName, specs);
    if (!cart.ok) return cart; // 返回错误+菜单列表让 Claude 重选

    // 5. 结算+填单+提交
    const result = await checkoutAndSubmit(session, addressName, remark, useCoupons);
    return result;
  } finally {
    session.close();
  }
}

module.exports = { mtOrder };
