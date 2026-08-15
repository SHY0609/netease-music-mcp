// CDP 美团浏览器自动化 — FINAL
const { spawn } = require("child_process"), http = require("http"), WebSocket = require("ws");
const CDP_PORT = 9222, DISPLAY = process.env.DISPLAY || ":99", MT = "https://h5.waimai.meituan.com";
const COOKIE = process.env.MEITUAN_COOKIE || "";

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); }).on("error", reject);
  });
}
function httpPut(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'PUT' }, (res) => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); });
    req.on("error", reject); req.end();
  });
}

async function startBrowser() {
  try { const v = await httpGet(`http://127.0.0.1:${CDP_PORT}/json/version`); if (v.Browser) return; } catch {}
  const fs = require("fs");
  const bin = ["/snap/bin/chromium","/usr/bin/chromium-browser"].find(p=>fs.existsSync(p));
  if (!bin) { console.error("[cdp] no chromium"); return; }
  const p = spawn(bin, [
    `--remote-debugging-port=${CDP_PORT}`,
    "--password-store=basic","--gtk-version=3",
    "--disable-features=TFLiteLanguageDetectionEnabled",
    "--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
    "--disable-setuid-sandbox","--user-data-dir=/home/ubuntu/chrome-cdp-profile",
    "about:blank",
  ], { env: {...process.env, DISPLAY}, detached: true, stdio: "ignore" });
  p.unref();
  for (let i=0;i<30;i++) { await new Promise(r=>setTimeout(r,500)); try { if((await httpGet(`http://127.0.0.1:${CDP_PORT}/json/version`)).Browser) return; } catch {} }
}

async function newSession() {
  await startBrowser();
  let tabs = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
  let pg = tabs.find(t=>t.type==="page"&&t.url==="about:blank")||tabs.find(t=>t.type==="page");
  if (!pg) pg = await httpPut(`http://127.0.0.1:${CDP_PORT}/json/new`);
  if (!pg?.webSocketDebuggerUrl) throw new Error("no_ws_url");

  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });

  const pending = new Map(); let cid = 0;
  ws.on("message", data => {
    try { const m = JSON.parse(data.toString()); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message||"cdp")) : resolve(m.result); } } catch {}
  });

  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++cid; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout:"+method)); } }, 15000);
  });

  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  try { await send("Emulation.setGeolocationOverride", { latitude: 27.623, longitude: 113.854, accuracy: 10 }); } catch {}

  if (COOKIE) {
    COOKIE.split(";").map(c=>c.trim()).filter(Boolean).forEach(p => { const eq=p.indexOf("="); if (eq>0) { const n=p.slice(0,eq).trim(); if (n==='oops'||n==='token'||n==='mt_c_token'||n==='w_token'||n==='auth'||n==='userId') { try { send("Network.setCookie",{name:n,value:p.slice(eq+1).trim(),domain:".meituan.com",path:"/",httpOnly:false,secure:false,sameSite:"Lax"}); } catch {} } }});
  }
  return { ws, send, pageId: pg.id, close: () => ws.close() };
}

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const evalText = (s, expr) => s.send("Runtime.evaluate", { expression: expr, returnByValue: true }).then(r=>r?.result?.value||"");

let pxSession = null, pxReady = false;

async function ensurePingxiang() {
  if (pxReady && pxSession?.ws?.readyState === WebSocket.OPEN) return pxSession;
  pxSession = await newSession();
  // 导航到首页
  await pxSession.send("Page.navigate", { url: MT + "/waimai/mindex" });
  await sleep(3000);
  // 点击地址栏
  await evalText(pxSession, `(function(){var a=document.querySelector(".addr_W3eGpu");if(a){a.click();return"ok";}return"nf";})()`);
  await sleep(2500);
  // 选默认地址（精准定位最小子元素）
  await evalText(pxSession, `(function(){var all=document.querySelectorAll("*");var best=null,min=999;for(var i=0;i<all.length;i++){var t=all[i].textContent||"";if(all[i].offsetParent&&t.indexOf("默认地址")>=0&&all[i].children.length<min){best=all[i];min=all[i].children.length;}}if(best){best.click();return"ok";}return"nf";})()`);
  await sleep(2500);
  pxReady = true;
  console.error("[cdp] 萍乡 ready");
  return pxSession;
}

// ═══ 文本解析（省 token） ═══════════════════════════════

function parseShops(raw) {
  // 快速解析：店名后跟 评分/月售/起送/配送 = 一个店铺条目
  const shops = [];
  const lines = raw.split('\n').map(l=>l.trim()).filter(Boolean);
  let cur = null;
  for (let i=0;i<lines.length;i++){
    const l=lines[i];
    // 评分行：如 "4.5"
    if (/^\d\.\d$/.test(l) && cur && !cur.rating){
      cur.rating=l;
      continue;
    }
    // 月售
    if (l.startsWith('月售') && cur){ cur.sales=l; continue; }
    // 起送
    if (l.startsWith('起送') && cur){ cur.minPrice=lines[i+1]||''; i++; continue; }
    // 配送
    if (l.startsWith('配送') && cur){
      const parts=[];
      for(let j=i+1;j<Math.min(i+4,lines.length);j++) if(!/^\d/.test(lines[j])&&!lines[j].startsWith('约')&&!lines[j].includes('减')&&!lines[j].includes('折')&&!lines[j].includes('支持')&&!lines[j].includes('准时')&&!lines[j].includes('放心')&&!lines[j].includes('票')&&!lines[j].includes('返')&&!lines[j].includes('领')&&!lines[j].includes('津贴')&&!lines[j].includes('新客')) parts.push(lines[j]);
      cur.delivery='¥'+parts.join('');
      i+=Math.min(3,lines.length-i-1);
      continue;
    }
    // 产品行：¥开头
    if (l.startsWith('¥') && cur){
      const name = lines[i-1]||'';
      if (!name.startsWith('¥')&&!name.startsWith('起送')&&!name.startsWith('配送')&&!name.startsWith('月售')&&!/^\d/.test(name)){
        if(!cur.products)cur.products=[];
        if(cur.products.length<3)cur.products.push({name,l});
      }
      continue;
    }
    // 跳过杂项
    if (l.includes('减')||l.includes('折起')||l.includes('支持自取')||l.includes('准时宝')||l.includes('放心吃')||l.includes('票')||l.includes('返')||l.includes('领')||l.includes('津贴')||l.includes('新客')||l.includes('青山')||l.includes('极速退款')||/^\d+min$/.test(l)||/^\d+km$/.test(l)||/^\d+m$/.test(l)) continue;
    // 可能是新店铺名（包含中文且不是纯数字/符号）
    if (/[一-龥]/.test(l)&&!l.startsWith('¥')&&!l.startsWith('月售')&&!l.startsWith('起送')&&!l.startsWith('配送')&&l.length>1){
      if(cur&&cur.name)shops.push(cur);
      cur={name:l};
    }
  }
  if(cur&&cur.name)shops.push(cur);
  return shops.slice(0,8);
}

// ═══ 美团操作 ═══════════════════════════════════════════

async function mtSearch(keyword) {
  const s = await ensurePingxiang();
  await evalText(s, `(function(){var tabs=document.querySelectorAll('[class*=tab],.nav-item,a[href*=\"/mindex\"]');for(var i=0;i<tabs.length;i++)if((tabs[i].textContent||'').includes('首页')||(tabs[i].textContent||'').includes('外卖')){tabs[i].click();return'home';}return'nf';})()`);
  await sleep(2000);
  await evalText(s, `(function(){var el=document.querySelector('[class*=search],.index-search');if(el)el.click();return"ok";})()`);
  await sleep(1500);
  await evalText(s, `(function(){var kw=${JSON.stringify(keyword)},inp=document.querySelector('input[type=text],input[type=search]');if(!inp)return"no";var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;setter.call(inp,kw);inp.dispatchEvent(new Event("input",{bubbles:true}));var btn=document.querySelector("[class*=searchText]");if(btn)btn.click();else inp.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return"ok";})()`);
  await sleep(4000);
  const text = await evalText(s, "document.body?.innerText?.slice(0,3000)||''");
  const shops = parseShops(text);
  return { source:"real", keyword, shops, rawText: text.slice(0,500) };
}

async function mtMenu(shopName) {
  const s = await ensurePingxiang();
  await evalText(s, `(function(){var el=document.querySelector('[class*=search],.index-search');if(el)el.click();return"ok";})()`);
  await sleep(1500);
  await evalText(s, `(function(){var kw=${JSON.stringify(shopName)},inp=document.querySelector('input[type=text]');var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;setter.call(inp,kw);inp.dispatchEvent(new Event("input",{bubbles:true}));var btn=document.querySelector("[class*=searchText]");if(btn)btn.click();else inp.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return"ok";})()`);
  await sleep(4000);
  await evalText(s, `(function(){var t=${JSON.stringify(shopName)},all=document.querySelectorAll('a,button,li,[class*=shop],[class*=store],[class*=food],[class*=product]');for(var i=0;i<all.length;i++){if(all[i].offsetParent&&all[i].children.length<5&&(all[i].textContent||'').indexOf(t)>=0){all[i].click();return"ok";}}return"nf";})()`);
  await sleep(4000);
  // 提取产品+价格（去描述省token）
  const raw = await evalText(s, "(function(){var items=document.querySelectorAll('[class*=food],[class*=product],[class*=spu],[class*=item]');var r=[];items.forEach(function(it){if(it.offsetParent){var n=it.querySelector('[class*=name],h3,h4');var p=it.querySelector('[class*=price]');if(n&&p)r.push((n.textContent||'').trim().slice(0,20)+' '+(p.textContent||'').trim());}});return r.slice(0,15).join('|')||document.body?.innerText?.slice(0,800)||'';})()");
  return { source:"real", keyword:shopName, products:raw };
}

async function mtOrder(shopName, productName, addressName, quantity) {
  const qty = quantity || 1;
  const s = await ensurePingxiang();
  // 回首页（SPA内导航，不丢定位）
  await evalText(s, `(function(){var tabs=document.querySelectorAll('[class*=tab],.nav-item,a[href*=\"/mindex\"]');for(var i=0;i<tabs.length;i++)if((tabs[i].textContent||'').includes('首页')||(tabs[i].textContent||'').includes('外卖')){tabs[i].click();return'home_tab';}window.history.back();return'back';})()`);
  await sleep(2000);

  // 1. 搜店→进店
  await evalText(s, `(function(){var el=document.querySelector('[class*=search],.index-search');if(el)el.click();return"ok";})()`);
  await sleep(1500);
  await evalText(s, `(function(){var kw=${JSON.stringify(shopName)},inp=document.querySelector('input[type=text]');var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;setter.call(inp,kw);inp.dispatchEvent(new Event("input",{bubbles:true}));var btn=document.querySelector("[class*=searchText]");if(btn)btn.click();else inp.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return"ok";})()`);
  await sleep(4000);
  const sc = await evalText(s, `(function(){var t=${JSON.stringify(shopName)},all=document.querySelectorAll('a,button,li,[class*=shop],[class*=store]');for(var i=0;i<all.length;i++){if(all[i].offsetParent&&all[i].children.length<5&&(all[i].textContent||'').indexOf(t)>=0){all[i].click();return"clicked";}}return"nf";})()`);
  if (sc === "nf") return { source:"error", reason:"shop_not_found" };
  await sleep(4000);

  // 2. 滚动页面让更多商品可见，然后找商品
  await evalText(s, `window.scrollBy(0,800)`);
  await sleep(500);
  // 点 + 号：循环点qty次
  for (let k = 0; k < qty; k++) {
    const r = await evalText(s, `(function(){
      var t=${JSON.stringify(productName)},all=document.querySelectorAll('[class*=food],[class*=product],[class*=spu],[class*=item]');
      for(var i=0;i<all.length;i++){
        if(all[i].offsetParent&&(all[i].textContent||'').indexOf(t)>=0){
          var btn=all[i].querySelector('[class*=add-],[class*=mBtnGroup]');
          if(!btn)btn=all[i].parentElement?.querySelector('[class*=add-],[class*=mBtnGroup]');
          if(!btn){var p=all[i].closest('[class*=item],[class*=food],[class*=product]');if(p)btn=p.querySelector('[class*=add-],[class*=mBtnGroup]');}
          if(btn){btn.click();return"added";}
          all[i].click();return"text_click";
        }
      }
      return"nf";
    })()`);
    console.error('[cdp] add #'+(k+1)+':', r);
    await sleep(800);
  }
  await sleep(2000);

  // 3. 点购物车→去结算
  await evalText(s, `(function(){var bars=document.querySelectorAll('[class*=cart]');for(var i=bars.length-1;i>=0;i--){var c=bars[i].className||'';if(bars[i].offsetParent&&c.indexOf("Tip")===-1){bars[i].click();return"cart";}}return"nf";})()`);
  await sleep(2000);
  await evalText(s, `(function(){var all=document.querySelectorAll('button,span,div,[class*=btn]');for(var i=0;i<all.length;i++){var t=(all[i].textContent||'').trim();if(all[i].offsetParent&&(t.includes('去结算')||t.includes('选好了'))){all[i].click();return t;}}return"nf";})()`);
  await sleep(3000);

  // 4. 提交订单
  await evalText(s, `(function(){var all=document.querySelectorAll('button,span,[class*=btn],[class*=submit]');for(var i=0;i<all.length;i++){var t=(all[i].textContent||'').trim();if(all[i].offsetParent&&(t.includes('提交订单')||t.includes('去支付')||t.includes('确认'))){all[i].click();return t;}}return"nf";})()`);
  await sleep(2000);

  // 精简输出：只看总价和结算状态
  const summary = await evalText(s, "(function(){var t=document.body?.innerText||'';var m=t.match(/[¥￥]\\s*\\d+[\\d.]*/g);var prices=m?m.slice(0,5).join(' '):'';var status=t.includes('提交订单')?'可提交':t.includes('去结算')?'待结算':t.includes('支付')?'待支付':'菜单';return status+' | '+prices+' | '+(t.match(/配送[^\\n]{0,20}/)||[''])[0];})()");
  const text = await evalText(s, "document.body?.innerText?.slice(0,2000)||''");
  return {
    source:"real", step:"preview", shopName, productName, quantity:qty,
    summary, detail: text,
    hint: text.includes("提交订单")||text.includes("支付") ? "🎉 已进入结算页！" : "商品已加购，查看详情确认。",
  };
}

module.exports = { startBrowser, mtSearch, mtMenu, mtOrder };
