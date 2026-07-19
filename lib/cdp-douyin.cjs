// CDP 抖音浏览器自动化 — 对标美团 ensurePingxiang 持久 session 模式
const { spawn } = require("child_process"), http = require("http"), WebSocket = require("ws");
const CDP_PORT = 9222, DISPLAY = process.env.DISPLAY || ":99";
const DY = "https://www.douyin.com";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); }).on("error", reject);
  });
}
// Chromium 新版要求 PUT /json/new
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
  if (!bin) { console.error("[dy:cdp] no chromium"); return; }
  // 对标 cyberboss 教程的 Chromium 启动参数
  const p = spawn(bin, [
    `--remote-debugging-port=${CDP_PORT}`,
    "--password-store=basic","--gtk-version=3",
    "--disable-features=TFLiteLanguageDetectionEnabled",
    "--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
    "--disable-setuid-sandbox","--user-data-dir=/home/ubuntu/chrome-cdp-profile",
    "about:blank",
  ], { env: {...process.env, DISPLAY}, detached: true, stdio: "ignore" });
  p.unref();
  for (let i=0;i<30;i++) { await new Promise(r=>setTimeout(r,500)); try { if ((await httpGet(`http://127.0.0.1:${CDP_PORT}/json/version`)).Browser) return; } catch {} }
}

// blockImages=false 时放行图片（登录扫码需要看到二维码）
async function newSession(blockImages = true) {
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

  // 🔥 Stealth 反检测 — 对标 Lozzi1910/Douyin-mcp
  // 注入到每个新页面，隐藏 webdriver 标记
  try {
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        // 隐藏自动化标记
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        // 伪装 plugins
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        // 伪装 languages
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
        // 伪装 platform
        Object.defineProperty(navigator, 'platform', { get: () => 'Linux aarch64' });
        // 伪装 hardwareConcurrency
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        // 去掉 chrome 对象
        delete window.chrome;
        // 伪装 permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );
      `
    });
  } catch (e) { console.error("[dy] stealth inject failed:", e.message); }

  if (blockImages) {
    try {
      await send("Network.setBlockedURLs", {
        urls: ["*.png","*.jpg","*.jpeg","*.gif","*.webp","*.svg","*.ico","*.mp4","*.avi",
               "*.woff*","*.ttf","*.eot","*.mp3","*.ogg","*.wav",
               "p3-pc-sign.douyinpic.com","p3-sign.douyinpic.com","p6-sign.douyinpic.com"]
      });
    } catch {}
  }

  try { await send("Emulation.setGeolocationOverride", { latitude: 27.623, longitude: 113.854, accuracy: 10 }); } catch {}
  try { await send("Emulation.setUserAgentOverride", { userAgent: UA }); } catch {}

  return { ws, send, pageId: pg.id, close: () => ws.close() };
}

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const evalText = (s, expr) => s.send("Runtime.evaluate", { expression: expr, returnByValue: true }).then(r=>r?.result?.value||"");

// ═══ 持久 session —— 对标美团 ensurePingxiang ═══
let dySession = null, dyReady = false;

async function ensureDouyin() {
  if (dyReady && dySession?.ws?.readyState === WebSocket.OPEN) {
    await dySession.send("Page.navigate", { url: DY });
    await sleep(5000);
    return dySession;
  }
  dySession = await newSession();
  await dySession.send("Page.navigate", { url: DY });
  await sleep(4000);
  // 检查验证码
  const title = await evalText(dySession, "document.title");
  if (title.includes("验证码")) {
    dyReady = false;
    throw new Error("captcha — 抖音触发验证码，请等几分钟再试");
  }
  dyReady = true;
  console.error("[dy] session ready");
  return dySession;
}

// ═══ 多账号 Cookie（和美团一样，走 Chrome profile 持久化）═══
const fs = require("fs");
let activeAccount = "default";
const accFile = name => `/home/ubuntu/douyin-cookies-${name}.json`;
const activeFile = "/home/ubuntu/douyin-active.txt";

function loadCookies(name) {
  try { return JSON.parse(fs.readFileSync(accFile(name), "utf8")); } catch { return []; }
}
function saveCookies(name, cookies) {
  try { fs.writeFileSync(accFile(name), JSON.stringify(cookies, null, 2)); } catch {}
}
try { activeAccount = fs.readFileSync(activeFile, "utf8").trim() || "default"; } catch {}

// ═════════════════════════════════════════════════════════
//  工具（全部复用 ensureDouyin session，不关！）
// ═════════════════════════════════════════════════════════

async function dyTrending() {
  const s = await ensureDouyin();
  await s.send("Page.navigate", { url: `${DY}/hot` });
  await sleep(3000);

  const text = await evalText(s, "document.body?.innerText?.slice(0,4000)||''");
  // 解析热搜
  const items = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let inHot = false, pendingTitle = "";
  for (const line of lines) {
    if (line.includes("抖音热榜")) { inHot = true; continue; }
    if (!inHot) continue;
    if (line.includes("热榜规则")) continue;
    if (/^\d+[\.\d]*万热度$/.test(line)) {
      if (pendingTitle) { items.push({ title: pendingTitle.slice(0, 50), hotValue: line }); pendingTitle = ""; }
      continue;
    }
    if (/^\d{1,2}$/.test(line)) continue;
    if (line.length > 3 && !line.includes("充钻石") && !line.includes("客户端") && !line.includes("通知") && !line.includes("投稿") && !line.includes("登录")) {
      if (pendingTitle && items.length > 0 && !items[items.length-1].hotValue) {
        items[items.length-1].title = line.slice(0, 50);
      } else { pendingTitle = line; }
    }
  }
  // 回到首页
  await s.send("Page.navigate", { url: DY });
  await sleep(1500);

  let rank = 0;
  return { source: "text", count: items.length, items: items.slice(0, 20).map(i => ({ rank: ++rank, ...i })) };
}

async function dySearch(keyword) {
  const s = await ensureDouyin();

  // 填搜索框 → change事件 → Enter键（React SPA 搜索的标准触发方式）
  await evalText(s, `(function(){
    var kw=${JSON.stringify(keyword)};
    var inp=document.querySelector('input[placeholder*="搜索"]');
    if(!inp)return;
    var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(inp,kw);
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    inp.dispatchEvent(new Event('change',{bubbles:true}));
    var ke=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true});
    inp.dispatchEvent(ke);
  })()`);
  await sleep(8000);

  // 读搜索结果
  const text = await evalText(s, "document.body?.innerText?.slice(0,5000)||''");

  // 解析搜索结果：格式为 点赞数\n标题+标签\n@作者 ·日期
  const videos = [];
  const lines = text.split('\n').map(l=>l.trim());
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 匹配 数字+万 开头（点赞数），后面跟标题行 和 @作者行
    if (/^\d+[\.\d]*万$/.test(line) && i+2 < lines.length) {
      const likes = line;
      const desc = lines[i+1];
      const authorLine = lines[i+2] || '';
      if (desc && desc.length > 4 && authorLine.includes('@')) {
        const author = (authorLine.match(/@(\S+)/) || [])[1] || '';
        videos.push({ desc: desc.slice(0, 100), author, likes });
        i += 3;
        if (videos.length >= 15) break;
        continue;
      }
    }
    i++;
  }

  await s.send("Page.navigate", { url: DY });
  await sleep(1500);

  if (videos.length > 0) return { source: "search", keyword, count: videos.length, videos: videos.slice(0, 10) };
  return { source: "search", keyword, videos: [], raw: text.slice(0, 1000) };
}

// ═══ SPA 点击辅助函数 ═══

// 通知/消息/投稿 按钮的特殊选择器（桌面版 SPA 顶部工具栏）
const BTN_SELECTORS = {
  "通知": '[data-e2e="something-button"].AlK6Qry0, .TftbcKo9.thj5WivM, [class*="notice" i]',
  "消息": '[data-e2e="im-entry"], .yOm_yUgK.thj5WivM, [class*="message" i], [class*="im-entry" i]',
};

async function clickToolbar(s, label) {
  const selector = BTN_SELECTORS[label];
  const result = await evalText(s, `(function(){
    var sel = ${JSON.stringify(selector)};
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) {
      if (els[i].offsetParent) {
        // React 16/18: 需要触发原生事件 + React 合成事件
        els[i].focus();
        els[i].click();
        // 双重保险：dispatch MouseEvent
        var ev = new MouseEvent('click', {bubbles:true, cancelable:true, view:window});
        els[i].dispatchEvent(ev);
        // 也尝试点父元素
        var p = els[i].parentElement;
        if (p) { p.focus(); p.click(); p.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); }
        return 'clicked:' + els[i].tagName + '.' + (els[i].className||'').slice(0,30);
      }
    }
    // fallback: text match on leaf nodes only
    var all = document.querySelectorAll('p,span,a,li');
    for (var j = 0; j < all.length; j++) {
      if (all[j].offsetParent && (all[j].textContent||'').trim() === ${JSON.stringify(label)}) {
        all[j].click();
        all[j].dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
        return 'fallback:' + all[j].tagName;
      }
    }
    return 'not_found';
  })()`);
  console.error('[dy] clickToolbar:', label, '→', result);
  return result;
}

async function navAndReadPanel(s, buttonLabel, waitMs = 3000) {
  await clickToolbar(s, buttonLabel);
  await sleep(waitMs);
  return await evalText(s, `(function(){
    var panels = document.querySelectorAll('[class*="panel"],[class*="Panel"],[class*="popup"],[class*="Popup"],[class*="modal"],[class*="Modal"],[class*="drawer"],[class*="Drawer"],[class*="dropdown"],[class*="Dropdown"],[class*="popper"],[class*="Popper"],[class*="notice"],[class*="Notice"],[class*="message"],[class*="Message"],[class*="chat"],[class*="Chat"],[class*="im-"],[class*="conversation"],[class*="Conversation"],[class*="notify"],[class*="Notify"],[class*="notification"],[class*="Notification"],[role="dialog"],[role="menu"],[role="listbox"]');
    for (var i = 0; i < panels.length; i++) {
      var txt = (panels[i].textContent || '').trim();
      if (panels[i].offsetParent && txt.length > 20) {
        return 'PANEL:' + txt.slice(0, 2500);
      }
    }
    return 'BODY:' + (document.body?.innerText?.slice(0, 2500)||'');
  })()`);
}

async function dyVideo(videoId) {
  const s = await ensureDouyin();

  // 🔥 直接导航到视频详情页，而不是在首页搜索
  const videoUrl = `${DY}/video/${videoId}`;
  console.error('[dy_video] navigate to:', videoUrl);
  await s.send("Page.navigate", { url: videoUrl });
  await sleep(6000);

  // 检查页面
  const pageTitle = await evalText(s, "document.title");
  if (pageTitle.includes('404') || pageTitle.includes('不存在')) {
    await s.send("Page.navigate", { url: DY });
    await sleep(1500);
    return { source: "error", id: videoId, error: "视频不存在或已删除" };
  }

  // 提取视频详情（标题、作者、点赞等）
  const detail = await evalText(s, `(function(){
    var txt = (document.body?.innerText || '').slice(0, 3000);
    var title = document.querySelector('title')?.textContent || '';
    return JSON.stringify({title: title.slice(0, 100), bodyText: txt});
  })()`);

  let title = "", bodyText = "";
  try { const d = JSON.parse(detail); title = d.title; bodyText = d.bodyText; } catch {}

  // 解析关键信息
  const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
  let author = "", likes = "", comments = "", shares = "", date = "";
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('@') && !author) author = lines[i];
    if (/^\d+[\.\d]*万?(点赞|赞)$/.test(lines[i])) likes = lines[i];
    if (/^\d+[\.\d]*万?(评论|回复)$/.test(lines[i])) comments = lines[i];
    if (/^\d+[\.\d]*万?(分享|转发)$/.test(lines[i])) shares = lines[i];
    if (/\d{4}-\d{2}-\d{2}/.test(lines[i]) && !date) date = lines[i].match(/\d{4}-\d{2}-\d{2}/)[0];
  }

  await s.send("Page.navigate", { url: DY });
  await sleep(1500);

  return {
    source: "detail_page",
    id: videoId,
    title: title || lines.slice(0, 3).join(' '),
    author, likes, commentCount: comments, shares, date,
    link: videoUrl,
  };
}

async function dyComment(videoId, text, replyTo) {
  // replyTo: 可选，匹配评论内容来回复（子评论）
  if (!videoId || !text) return { ok: false, hint: "需要 videoId 和 text" };

  // 🔥 复用 VNC 已打开的 tab（CDP 自己开的 tab 没评论区）
  // 扫描所有 CDP 页面 tab，找 URL 中含 modal_id 或 note 的
  let ws = null, s = null;
  try {
    const tabs = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
    const vncTab = tabs.find(t =>
      t.type === 'page' && t.url && (t.url.includes('modal_id') || t.url.includes('/note/') || t.url.includes('/article/'))
    );
    if (vncTab && vncTab.webSocketDebuggerUrl) {
      ws = new WebSocket(vncTab.webSocketDebuggerUrl);
      const pending = new Map(); let cid = 0;
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.on('message', data => {
        try { const m = JSON.parse(data.toString()); if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); m.error ? r.reject(new Error(m.error.message)) : r.resolve(m.result); } } catch {}
      });
      s = {
        ws,
        send: (method, params) => new Promise((resolve, reject) => {
          const id = ++cid; pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
          setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout:' + method)); } }, 15000);
        }),
      };
      await s.send('Runtime.enable');
      console.error('[dy_comment] using VNC tab:', vncTab.url.slice(0, 80));
    }
  } catch (e) { console.error('[dy_comment] VNC tab error:', e.message); }

  if (!s) {
    return { ok: false, hint: "未找到 VNC tab，请先在 VNC 中打开笔记页面" };
  }

  // Step 0: 如果有 replyTo，先滚动到评论区顶部确保按钮可见，再点目标\"回复\"
  if (replyTo && replyTo.length > 0) {
    // 🔥 先 JS focus 编辑器（确保页面渲染评论组件），再滚到评论列表顶部
    await s.send("Runtime.evaluate", {
      expression: `(function(){
        // 先聚焦编辑器确保 React 渲染完整
        var ce=document.querySelector("[contenteditable=true]");
        if(ce) ce.focus();
        // 再滚到评论区开头
        var all=document.querySelectorAll("*");
        for(var i=0;i<all.length;i++){
          var t=(all[i].textContent||"").trim();
          if(all[i].offsetParent && /^评论\\(\\d+\\)/.test(t)){
            all[i].scrollIntoView({block:"start"});
            return "scrolled_to_"+t;
          }
        }
        window.scrollTo(0, 0);
        return "scrolled_top";
      })()`,
      returnByValue: true,
    });
    await sleep(2000);

    const replyPos = await s.send("Runtime.evaluate", {
      expression: [
        '(function(){',
        'var target=' + JSON.stringify(replyTo) + ';',
        'var all=document.querySelectorAll("*");',
        'for(var i=0;i<all.length;i++){',
        'var t=(all[i].textContent||"").trim();',
        'var br=all[i].getBoundingClientRect();',
        // 找\"回复\" SPAN（限 y<900，排除底部输入栏的"回复"）',
        'if(all[i].offsetParent && br.x<240 && br.y<2500 && (t==="回复"||t==="回复中") && all[i].tagName==="SPAN"){',
        'var ci=all[i].closest("[class*=comment-item]");',
        'var p=ci; for(var d=0;d<5;d++){p=p?.parentElement;}',
	        'var parentText=(p?.textContent||\"\").slice(0,500);',
        'var parentText=(p?.textContent||\"\").slice(0,500);',
        // 确保不是底部输入栏',
        'if(!parentText.includes(\"留下你的精彩评论吧\") && parentText.includes(target)){',
        'return JSON.stringify({x:Math.round(br.left+br.width/2),y:Math.round(br.top+br.height/2)});',
        '}',
        '}',
        '}',
        'return "null";',
        '})()'
      ].join(''),
      returnByValue: true,
    });
    const rp = replyPos?.result?.value || 'null';
    console.error('[dy_comment] replyPos:', rp);

    if (rp !== 'null') {
      // 🔥 JS 点击父容器（CDP 鼠标点 SPAN 无效，必须 JS click parentElement）
      await s.send("Runtime.evaluate", {
        expression: [
          '(function(){',
          'var target=' + JSON.stringify(replyTo) + ';',
          'var all=document.querySelectorAll("span");',
          'for(var i=0;i<all.length;i++){',
          'var t=all[i].textContent||"";',
          'var br=all[i].getBoundingClientRect();',
          'if(all[i].offsetParent&&br.y<2500&&(t==="回复"||t==="回复中")){',
          'var ci=all[i].closest("[class*=comment-item]");',
          'var parentText=(ci?.parentElement?.parentElement?.textContent||"");',
          'if(parentText.includes(target)){',
          'var parent=all[i].parentElement;',
          'if(parent){parent.click();parent.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));}',
          'return "clicked_parent";',
          '}}}return"not_found";',
          '})()'
        ].join(''),
        returnByValue: true,
      });
      await sleep(3000);  // 回复模式多等一下确保"回复中"稳定
    } else {
      if (ws) ws.close();
      return { ok: false, hint: "未找到匹配的评论来回复: " + replyTo.slice(0, 30) };
    }
  }

  const isReply = replyTo && replyTo.length > 0;
  const editorPos = await s.send("Runtime.evaluate", {
    expression: [
      '(function(){',
      // 找 contenteditable（类名可能变，直接用属性选择器）',
      'var ce=document.querySelector("[contenteditable=true]");',
      // fallback: 找公共占位符所在容器',
      'if(!ce){ var all=document.querySelectorAll(\"*\"); for(var i=0;i<all.length;i++){ if((all[i].textContent||\"\").trim()===\"留下你的精彩评论吧\"&&all[i].offsetParent){ ce=all[i].parentElement?.querySelector(\"[contenteditable=true]\")||all[i]; break; }}}',
      // 最后找 DraftEditor 类名',
      'if(!ce) ce=document.querySelector(\"[class*=DraftEditor-root]\")?.querySelector(\"[contenteditable=true]\");',
      'if(!ce) ce=document.querySelector(\"[class*=DraftEditor-root]\");',
      'if(!ce) return "null";',
      'var r=ce.getBoundingClientRect();',
      'return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});',
      '})()'
    ].join(''),
    returnByValue: true,
  });
  const ep = editorPos?.result?.value || 'null';
  console.error('[dy_comment] editorPos:', ep);

  if (ep === 'null') {
    // 评论区可能滚出视野了，尝试滚动 + 点评论 tab 再找
    await s.send("Runtime.evaluate", {
      expression: `(function(){
        window.scrollTo(0, document.body.scrollHeight);
        var all=document.querySelectorAll("*");
        for(var i=0;i<all.length;i++){
          var t=(all[i].textContent||"").trim();
          if(all[i].offsetParent && /^评论/.test(t) && all[i].children.length<=2){
            all[i].click(); return "clicked_comment_tab";
          }
        }
        return "scrolled";
      })()`,
      returnByValue: true,
    });
    await sleep(3000);

    const retry = await s.send("Runtime.evaluate", {
      expression: [
        '(function(){',
        'var ce=document.querySelector("[contenteditable=true]");',
        'if(!ce){ var all=document.querySelectorAll(\"*\"); for(var i=0;i<all.length;i++){ if((all[i].textContent||\"\").trim()===\"留下你的精彩评论吧\"){ ce=all[i].parentElement?.querySelector(\"[contenteditable=true]\")||all[i]; break; }}}',
        'if(!ce) return "null";',
        'var r=ce.getBoundingClientRect();',
        'return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});',
        '})()'
      ].join(''),
      returnByValue: true,
    });
    const retryVal = retry?.result?.value || 'null';
    if (retryVal === 'null') {
      if (ws) ws.close();
      return { ok: false, hint: "找不到评论区编辑器，请确认 VNC 页面已加载完整" };
    }
    ep = retryVal; // 用重试结果覆盖
  }

  if (isReply) {
    // 回复模式：确认"回复中"还在，然后点编辑器（点左侧避开回复按钮）
    const verifyReply = await s.send("Runtime.evaluate", {
      expression: '!!document.body?.innerText?.includes("回复中")',
      returnByValue: true,
    });
    if (!verifyReply?.result?.value) {
      if (ws) ws.close();
      return { ok: false, hint: "回复状态丢失，请重试" };
    }
    // CDP 点击编辑器——用较小的 x 坐标避免误触回复按钮区域
    const edPos = JSON.parse(ep);
    await s.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:Math.min(edPos.x, 300),y:edPos.y});
    await s.send('Input.dispatchMouseEvent',{type:'mousePressed',x:Math.min(edPos.x, 300),y:edPos.y,button:'left',clickCount:1});
    await sleep(100);
    await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:Math.min(edPos.x, 300),y:edPos.y,button:'left',clickCount:1});
    await sleep(1500);
    // 再次确认
    const verify2 = await s.send("Runtime.evaluate", {
      expression: '!!document.body?.innerText?.includes("回复中")',
      returnByValue: true,
    });
    console.error('[dy_comment] reply state after click:', verify2?.result?.value);
  } else {
    const edPos = JSON.parse(ep);
    await s.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:edPos.x,y:edPos.y});
    await s.send('Input.dispatchMouseEvent',{type:'mousePressed',x:edPos.x,y:edPos.y,button:'left',clickCount:1});
    await sleep(100);
    await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:edPos.x,y:edPos.y,button:'left',clickCount:1});
    await sleep(1500);
  }

  // Step 2: 清空旧内容 + CDP 逐字打字
  // JS 清空
  await s.send("Runtime.evaluate", {
    expression: [
      '(function(){',
      'var ed=document.querySelector("[class*=DraftEditor-root] [contenteditable=true]");',
      'if(!ed) return;',
      'ed.focus();',
      'ed.innerHTML="";',
      '})()'
    ].join(''),
    returnByValue: true,
  });
  await sleep(500);

  // CDP 逐字输入（每个字符 keyDown+char+keyUp ≈80ms）
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: code, key: ch });
    await sleep(20);
    await s.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
    await sleep(20);
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, key: ch });
    await sleep(40);
  }
  await sleep(1500);

  // Step 3: 找发送箭头 — 优先用已知 class（Note/Article 通用）
  const sendPos = await s.send("Runtime.evaluate", {
    expression: [
      '(function(){',
      // 1: 已知的发送按钮 class（Note 和 Article 都用这个）',
      'var btn=document.querySelector(".wchsYBpK.jfGCpJo0");',
      'if(btn){',
      'var r=btn.getBoundingClientRect();',
      'return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});',
      '}',
      // 2: 搜编辑区附近所有 36x36 SPAN（发送箭头总是36x36，回复模式下 wchs 可能消失）',
      'var allSpans=document.querySelectorAll("span");',
      'for(var jj=0;jj<allSpans.length;jj++){',
      'var rr=allSpans[jj].getBoundingClientRect();',
      'if(Math.round(rr.width)===36&&Math.round(rr.height)===36&&rr.y<500){',
      'return JSON.stringify({x:Math.round(rr.left+rr.width/2),y:Math.round(rr.top+rr.height/2)});',
      '}',
      '}',
      // 3: fallback — commentInput-right-ct 可见 SPAN',
      'var ct=document.querySelector("[class*=commentInput][class*=right]");',
      'if(!ct) ct=document.querySelector("[class*=commentInput-right]");',
      'if(!ct){ var ed=document.querySelector("[class*=DraftEditor-root]"); if(ed) ct=ed.parentElement?.parentElement?.querySelector("[class*=right]"); }',
      'if(ct){',
      'var spans=ct.querySelectorAll("span");',
      'for(var i=spans.length-1;i>=0;i--){',
      'var r=spans[i].getBoundingClientRect();',
      'if(spans[i].offsetParent && r.width>10 && r.height>10){',
      'return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});',
      '}}}',
      'return "null";',
      '})()'
    ].join(''),
    returnByValue: true,
  });
  const sp = sendPos?.result?.value || 'null';
  console.error('[dy_comment] sendPos:', sp);

  if (sp === 'null') {
    if (ws) ws.close();
    return { ok: false, hint: "找不到发送按钮，请确认 VNC 已打开 Note 页且评论区已渲染" };
  }

  const btnPos = JSON.parse(sp);
  // 检查按钮是否可见（CDP 自己开的 tab 返回 {0,0}）
  if (!btnPos.x && !btnPos.y) {
    if (ws) ws.close();
    return { ok: false, hint: "发送按钮未激活(0,0)，需要 VNC 打开 Note 页并点击评论区" };
  }

  // 🔥 JS 直接点击发送按钮（wchsYBpK class 是通用发送箭头，Note/Article 都有）
  const jsClick = await s.send("Runtime.evaluate", {
    expression: `(function(){
      var btn=document.querySelector(".wchsYBpK.jfGCpJo0");
      if(btn){ btn.click(); btn.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true})); return "clicked"; }
      return "no_wchs";
    })()`,
    returnByValue: true,
  });
  console.error('[dy_comment] jsClick:', jsClick?.result?.value);

  // fallback: wchs 没找到 → 用 36x36 SPAN 或坐标
  if (jsClick?.result?.value === 'no_wchs') {
    // 尝试找任意 36x36 SPAN 发送按钮
    const altBtn = await s.send("Runtime.evaluate", {
      expression: `(function(){
        var all=document.querySelectorAll("span");
        for(var i=0;i<all.length;i++){
          var r=all[i].getBoundingClientRect();
          if(Math.round(r.width)===36&&Math.round(r.height)===36&&r.y<500){
            all[i].click();all[i].dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));
            return "clicked_36x36:"+Math.round(r.y);
          }
        }
        return "no_alt";
      })()`,
      returnByValue: true,
    });
    console.error('[dy_comment] altBtn:', altBtn?.result?.value);
  }

  if (btnPos.x > 0 || btnPos.y > 0) {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btnPos.x, y: btnPos.y });
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btnPos.x, y: btnPos.y, button: 'left', clickCount: 1 });
    await sleep(100);
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btnPos.x, y: btnPos.y, button: 'left', clickCount: 1 });
  }
  await sleep(3000);

  // 清理：VNC tab 保持不动，只关 WebSocket
  if (ws) { try { ws.close(); } catch {} }

  return { ok: true, videoId, text: text.slice(0, 60), hint: "✅ 评论已发送" };
}

async function dyUser(userId) {
  const s = await ensureDouyin();
  if (userId === 'following') {
    // 进个人主页 → 点"关注"看列表
    const pos2 = await evalText(s, `(function(){
      var els=document.querySelectorAll('*');
      for(var i=0;i<els.length;i++){
        var t=(els[i].textContent||'').trim();
        if(els[i].offsetParent&&t==='我的'){
          var r=els[i].getBoundingClientRect();
          return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});
        }
      }
      return'null';
    })()`);
    if (pos2 !== 'null') {
      const {x,y} = JSON.parse(pos2);
      await s.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
      await s.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
      await sleep(100);
      await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
    }
    await sleep(3500);
    // 点"关注"
    await evalText(s, `(function(){
      var els=document.querySelectorAll('*');
      for(var i=0;i<els.length;i++){
        var t=(els[i].textContent||'').trim();
        if(els[i].offsetParent&&t==='关注'&&els[i].children.length===0){
          var p=els[i].parentElement;
          if(p){p.click();p.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return;}
        }
      }
    })()`);
    await sleep(3000);
    const ft = await evalText(s, "document.body?.innerText?.slice(0,3000)||''");
    await s.send("Page.navigate", { url: DY });
    await sleep(1500);
    return { source: "spa_click", type: "following", raw: ft };
  }

  if (!userId || userId === 'self' || userId === 'me') {
    // 点击"我的" — 用 CDP 鼠标点击（React 页面，JS click 可能不稳）
    const pos = await evalText(s, `(function(){
      var els = document.querySelectorAll('*');
      for (var i = 0; i < els.length; i++) {
        var t = (els[i].textContent || '').trim();
        if (els[i].offsetParent && t === '我的') {
          var r = els[i].getBoundingClientRect();
          return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)});
        }
      }
      return 'null';
    })()`);
    if (pos !== 'null') {
      const {x, y} = JSON.parse(pos);
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleep(100);
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    await sleep(3500);
    const text = await evalText(s, "document.body?.innerText?.slice(0,2500)||''");
    return { source: "spa_click", type: "self", raw: text };
  }

  // 方案2: 搜索用户然后点进去
  await evalText(s, `(function(){
    var inp=document.querySelector('input[placeholder*="搜索"],input[type=search],input[type=text]');
    if(!inp)return;
    var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(inp,${JSON.stringify(userId)});inp.dispatchEvent(new Event('input',{bubbles:true}));
    setTimeout(function(){
      inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    },300);
  })()`);
  await sleep(4000);

  // 点第一个用户结果
  await evalText(s, `(function(){
    var els=document.querySelectorAll('*');
    for(var i=0;i<els.length;i++){
      var t=(els[i].textContent||'').trim();
      if(els[i].offsetParent && (t==='粉丝'||t.includes('获赞')||t.includes('作品'))){
        // 找到了用户相关文字，点它的父元素
        var p=els[i].closest('a')||els[i].closest('[class*=user]')||els[i].parentElement;
        if(p&&p.click){p.click();return'clicked';}
      }
    }
    return'no_user_found';
  })()`);
  await sleep(3500);

  const text = await evalText(s, "document.body?.innerText?.slice(0,2500)||''");
  await s.send("Page.navigate", { url: DY });
  await sleep(1500);
  return { source: "spa_click", raw: text };
}

async function dyNotifications() {
  const s = await ensureDouyin();
  const text = await navAndReadPanel(s, "通知", 3000);
  await s.send("Page.navigate", { url: DY });
  await sleep(1500);

  if (text.startsWith('PANEL:')) {
    const content = text.slice(6);
    if (content.length < 30) return { source: "spa_click", raw: content, hint: "暂无新通知" };
    const lines = content.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.includes('充钻石') && !t.includes('客户端') && !t.includes('广告')
        && !t.includes('读屏标签') && !t.includes('扫码') && t.length > 1;
    });
    return { source: "spa_click", count: lines.length, raw: lines.join('\n').slice(0, 2000) };
  }
  // fallback: body 文本
  const body = text.slice(5);
  return { source: "spa_click", raw: body.slice(0, 2000), hint: "（未找到通知面板，显示页面内容）" };
}

async function dyMessages() {
  const s = await ensureDouyin();
  const text = await navAndReadPanel(s, "消息", 3000);
  await s.send("Page.navigate", { url: DY });
  await sleep(1500);

  if (text.startsWith('PANEL:')) {
    const content = text.slice(6);
    if (content.length < 30) return { source: "spa_click", raw: content, hint: "暂无新私信" };
    const lines = content.split('\n').filter(l => {
      const t = l.trim();
      return t && !t.includes('充钻石') && !t.includes('客户端') && !t.includes('广告')
        && !t.includes('读屏标签') && t.length > 1;
    });
    return { source: "spa_click", count: lines.length, raw: lines.join('\n').slice(0, 2000) };
  }
  const body = text.slice(5);
  return { source: "spa_click", raw: body.slice(0, 2000), hint: "（未找到私信面板，显示页面内容）" };
}

// ═══ 扫码登录 — 独立 session（不拦截图片），截图二维码 ═══
async function dyLogin(account = "default") {
  activeAccount = account;
  try { fs.writeFileSync(activeFile, account); } catch {}
  const accLabel = account === "default" ? "默认账号" : account;

  // 检查已有 Cookie
  const saved = loadCookies(account);
  if (saved.length > 0) {
    return { ok: true, step: "done", account: accLabel,
      hint: `✅ ${accLabel} 已登录（${saved.length} Cookie）。` };
  }

  // 创建不拦截图片的临时 session
  const s = await newSession(false);
  await s.send("Page.navigate", { url: DY });
  await sleep(4000);

  // 检查是否已登录（Chrome profile 可能有上一次的 session）
  const c = await evalText(s, "document.cookie");
  if (c.includes("sessionid")) {
    try {
      const allCookies = await s.send("Network.getCookies");
      const dyCookies = (allCookies?.cookies || []).filter(c =>
        c.domain.includes("douyin.com") || c.domain.includes("snssdk.com")
      );
      saveCookies(account, dyCookies);
    } catch {}
    s.close();
    return { ok: true, step: "done", account: accLabel, hint: `✅ ${accLabel} 已登录！` };
  }

  // 未登录 → 在首页点登录按钮（移动端弹二维码弹窗）
  await s.send("Page.navigate", { url: DY });
  await sleep(3000);

  await evalText(s, `(function(){
    var btns=document.querySelectorAll('button,span,a');
    for(var i=0;i<btns.length;i++){
      if(btns[i].offsetParent&&(btns[i].textContent||'').includes('登录')){
        btns[i].click();return'clicked';
      }
    }
    return'skipped';
  })()`);
  await sleep(4000);

  // 截图二维码
  let screenshot = "";
  try {
    // 找二维码元素位置
    const clip = JSON.parse(await evalText(s, `(function(){
      var imgs=document.querySelectorAll('img[src*="qr"],img[class*="qr"],canvas');
      for(var i=0;i<imgs.length;i++){
        var r=imgs[i].getBoundingClientRect();
        if(r.width>80&&r.height>80){return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),scale:1});}
      }
      return 'null';
    })()`) || "null");
    if (clip) {
      screenshot = (await s.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true }))?.data || "";
    }
  } catch {}
  if (!screenshot) {
    try { screenshot = (await s.send("Page.captureScreenshot", { format: "png" }))?.data || ""; } catch {}
  }

  // 轮询等扫码（15s）
  let done = false;
  for (let i = 0; i < 5; i++) {
    await sleep(3000);
    const cookie = await evalText(s, "document.cookie");
    if (cookie.includes("sessionid")) {
      done = true;
      try {
        const allCookies = await s.send("Network.getCookies");
        const dyCookies = (allCookies?.cookies || []).filter(c =>
          c.domain.includes("douyin.com") || c.domain.includes("snssdk.com")
        );
        saveCookies(account, dyCookies);
        console.error(`[dy:login] saved ${dyCookies.length} cookies for "${account}"`);
      } catch {}
      break;
    }
  }

  s.close();
  if (done) {
    return { ok: true, step: "done", account: accLabel, hint: `✅ ${accLabel} 扫码成功！` };
  }
  return {
    ok: true, step: "qr", account: accLabel,
    qrScreenshot: screenshot ? `data:image/png;base64,${screenshot}` : "",
    hint: screenshot ? "📱 扫码上方二维码登录，然后说'我已扫码'" : "⚠️ 二维码截取失败，请重试"
  };
}

function dySwitch(account) {
  activeAccount = account;
  try { fs.writeFileSync(activeFile, account); } catch {}
  const cookies = loadCookies(account);
  console.error(`[dy:switch] "${account}", ${cookies.length} cookies`);
  return {
    ok: true, account,
    hasCookies: cookies.length > 0,
    hint: cookies.length > 0
      ? `✅ 已切换到「${account}」，${cookies.length} 个 Cookie。`
      : `⚠️ 已切换到「${account}」，请用 dy_login 登录。`
  };
}

// ═══ Cookie 注入（对标美团 MEITUAN_COOKIE）═══
function dyCookie(cookieString) {
  if (!cookieString || cookieString.length < 20) {
    return { ok: false, hint: "请粘贴完整的浏览器 Cookie 字符串" };
  }
  const pairs = cookieString.split(";").map(c => c.trim()).filter(Boolean);
  const cookies = pairs.map(p => {
    const eq = p.indexOf("=");
    if (eq <= 0) return null;
    return { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim(), domain: ".douyin.com" };
  }).filter(Boolean);
  if (cookies.length < 3) return { ok: false, hint: "Cookie 无效，请从浏览器 douyin.com 登录后复制" };
  saveCookies(activeAccount, cookies);
  console.error(`[dy:cookie] saved ${cookies.length} cookies`);
  return { ok: true, count: cookies.length, hint: `✅ ${cookies.length} 个 Cookie 已保存，所有 dy_* 工具立即可用。` };
}

module.exports = { startBrowser, newSession, ensureDouyin, dyTrending, dySearch, dyVideo, dyUser, dyNotifications, dyMessages, dyComment, dyReply: dyComment, dyCookie, dyLogin, dySwitch };
