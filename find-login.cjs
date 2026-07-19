const { spawn } = require("child_process"), http = require("http"), WebSocket = require("ws");
const PORT = 9222;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); }).on("error", reject);
  });
}
function httpPut(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "PUT" }, (res) => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); });
    req.on("error", reject); req.end();
  });
}

(async () => {
  try { await httpGet("http://127.0.0.1:"+PORT+"/json/version"); } catch {
    spawn("/snap/bin/chromium", ["--remote-debugging-port="+PORT,"--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--disable-setuid-sandbox","--user-data-dir=/home/ubuntu/chrome-cdp-profile","--password-store=basic","--window-size=1920,1080","about:blank"], { env: {...process.env, DISPLAY:":99"}, detached: true, stdio: "ignore" }).unref();
    for (let i=0;i<30;i++) { await new Promise(r=>setTimeout(r,500)); try { if ((await httpGet("http://127.0.0.1:"+PORT+"/json/version")).Browser) break; } catch {} }
  }

  const pg = await httpPut("http://127.0.0.1:"+PORT+"/json/new");
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
  const ev = (expr) => send("Runtime.evaluate", { expression: expr, returnByValue: true }).then(r=>r?.result?.value||"");

  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: "https://www.douyin.com" });
  await new Promise(r=>setTimeout(r,5000));

  console.log("URL:", await ev("window.location.href"));
  console.log("Title:", await ev("document.title"));

  // Find login elements
  const btns = await ev('(function(){var all=document.querySelectorAll("a,button,span,div,li");var r=[];for(var i=0;i<all.length;i++){var t=(all[i].textContent||"").trim();if((t==="登录"||t==="Login"||t==="登 录")&&all[i].offsetParent){r.push(t+"|tag="+all[i].tagName+"|href="+(all[i].href||"").slice(0,100)+"|class="+(all[i].className||"").slice(0,50));}}return r.join("\\n")||"NOT_FOUND";})()');
  console.log("Login buttons:\n", btns);

  // Try finding with broader search
  const broader = await ev('(function(){var all=document.querySelectorAll("*");var r=[];for(var i=0;i<Math.min(all.length,500);i++){var t=(all[i].textContent||"").replace(/\\s/g,"");if(t==="登录"&&all[i].offsetParent&&!all[i].querySelector("*")){r.push("tag="+all[i].tagName+" id="+(all[i].id||"")+" class="+(all[i].className||"").slice(0,50));}}return r.join("\\n")||"NOT_FOUND";})()');
  console.log("Broader search:\n", broader);

  // Click the first login element found
  const clicked = await ev('(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){var t=(all[i].textContent||"").replace(/\\s/g,"");if(t==="登录"&&all[i].offsetParent){all[i].click();return all[i].tagName;}}return "NOT_FOUND";})()');
  console.log("Clicked:", clicked);
  await new Promise(r=>setTimeout(r,5000));
  console.log("After URL:", await ev("window.location.href"));
  console.log("After title:", await ev("document.title"));
  console.log("Body:", (await ev('document.body?.innerText?.slice(0,500)||""')));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  require("fs").writeFileSync("/tmp/after-login-click.png", Buffer.from(shot.data, "base64"));
  console.log("Screenshot:", shot.data.length, "bytes");

  ws.close();
  process.exit(0);
})();
