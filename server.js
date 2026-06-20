import http from "node:http";
import { weapi } from "./lib/netease.js";

const COOKIE = process.env.NETEASE_COOKIE || "";
const PORT = process.env.PORT || 3000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// ─── Netease weapi (WORKS from Singapore!) ──────────────────
async function ncApi(path, data) {
  const body = weapi(data);
  const res = await fetch(`https://music.163.com/weapi${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: COOKIE, referer: "https://music.163.com/", "user-agent": UA },
    body,
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Netease: ${text.slice(0, 200)}`); }
}

async function searchSongs(kw, limit = 8) {
  const r = await ncApi("/cloudsearch/get/web", { s: kw, type: 1, limit, offset: 0 });
  if (r.code !== 200) throw new Error(r.message || "search failed");
  return (r.result?.songs || []).map(s => ({
    id: String(s.id), name: s.name,
    artist: (s.ar || []).map(a => a.name).join(" / "),
    album: (s.al || {}).name || "",
    coverUrl: (s.al || {}).picUrl || "",
    durationMs: s.dt || 0,
  }));
}

async function getSongUrl(id) {
  const r = await ncApi("/song/enhance/player/url/v1", { ids: `[${id}]`, level: "exhigh", encodeType: "mp3" });
  const url = r.data?.[0]?.url;
  if (url) return url.replace(/^http:\/\//, "https://");
  // Fallback: outer URL
  try {
    const r2 = await fetch(`https://music.163.com/song/media/outer/url?id=${id}`, { redirect: "manual", headers: { "user-agent": UA, referer: "https://music.163.com/" } });
    const loc = r2.headers.get("location") || "";
    if (!loc.includes("/404")) return loc.replace(/^http:\/\//, "https://");
  } catch {}
  return "";
}

async function getPlaylists() {
  const r = await ncApi("/user/playlist", { uid: "", limit: 50, offset: 0, includeVideo: true });
  return (r.playlist || []).map(p => ({ id: String(p.id), name: p.name, trackCount: p.trackCount }));
}

async function getPlaylistDetail(id) {
  const r = await ncApi("/v6/playlist/detail", { id: String(id), n: 30, s: 0 });
  const p = r.playlist || {};
  return { name: p.name || "", tracks: (p.tracks || []).map(s => ({ id: String(s.id), name: s.name, artist: (s.ar || []).map(a => a.name).join(" / ") })) };
}

async function addToPlaylist(pid, songId) {
  const r = await ncApi("/playlist/manipulate/tracks", { op: "add", pid: String(pid), trackIds: `[${songId}]` });
  if (r.code !== 200) throw new Error(r.message || r.msg || "add failed");
  return true;
}

async function getLyricsRaw(id) {
  try {
    const r = await ncApi("/song/lyric", { id: String(id), lv: 1, tv: 1 });
    return (r.lrc?.lyric || "") + "\n" + (r.tlyric?.lyric || "");
  } catch { return ""; }
}

// ─── Lyrics parser ─────────────────────────────────────────
function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const matches = [...raw.matchAll(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = raw.replace(/\[[^\]]+]/g, "").trim();
    for (const m of matches) {
      lines.push({ time: Number(m[1]) * 60 + Number(m[2]) + (Number(m[3] || "0") || 0) / 1000, text });
    }
  }
  return lines.filter(l => l.text).sort((a, b) => a.time - b.time);
}
function lyricsAround(lines, time, n = 4) {
  let idx = lines.findIndex(l => l.time >= time);
  if (idx < 0) idx = Math.max(0, lines.length - n);
  return { past: lines.slice(Math.max(0, idx - 1), idx).map(l => l.text), current: lines[idx]?.text || "", upcoming: lines.slice(idx + 1, idx + 1 + n).map(l => l.text) };
}
function fm(s) { const m = Math.floor((s || 0) / 60), sec = Math.floor((s || 0) % 60); return m + ":" + (sec < 10 ? "0" : "") + sec; }

// ─── Player state ──────────────────────────────────────────
const state = { queue: [], current: null, status: "idle", currentTime: 0, lyrics: null };

// ─── MCP ────────────────────────────────────────────────────
const ok = (id, r) => ({ jsonrpc: "2.0", id, result: r });
const txt = (id, text) => ok(id, { content: [{ type: "text", text }] });
const mcpInfo = { protocolVersion: "2024-11-05", serverInfo: { name: "netease-music", version: "2.0.0" }, capabilities: { tools: {} } };
const tools = [
  { name: "play", description: "Search and play a song.",
    inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] } },
  { name: "skip", description: "Skip to next song.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "pause", description: "Toggle pause/resume.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "queue", description: "View current queue.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "playlists", description: "Get your playlists.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "add_to_playlist", description: "Add current song to a playlist.",
    inputSchema: { type: "object", properties: { songId: { type: "string" }, playlistId: { type: "string" } }, required: ["playlistId"] } },
  { name: "playlist_tracks", description: "Get tracks in a playlist.",
    inputSchema: { type: "object", properties: { playlistId: { type: "string" } }, required: ["playlistId"] } },
  { name: "current_song", description: "Get current song info and lyrics context.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "lyrics", description: "Get full lyrics.",
    inputSchema: { type: "object", properties: { songId: { type: "string" } }, required: [] } },
];

async function execTool(name, args) {
  try {
    switch (name) {
      case "play": {
        const songs = await searchSongs(args.keyword, 8);
        if (!songs.length) return `No results`;
        const checks = await Promise.all(songs.map(async s => { try { return (await getSongUrl(s.id)) ? s : null; } catch { return null; } }));
        const pick = checks.find(Boolean);
        if (!pick) return `No playable songs for "${args.keyword}"`;
        state.current = { id: pick.id, name: pick.name, artist: pick.artist, album: pick.album, coverUrl: pick.coverUrl, durationMs: pick.durationMs, playUrl: "" };
        state.status = "playing";
        if (!state.queue.find(q => q.id === pick.id)) state.queue.unshift(pick);
        return `🎵 ${pick.name} - ${pick.artist}`;
      }
      case "skip":
        if (state.queue.length > 1) { state.queue.shift(); state.current = state.queue[0]; state.current.playUrl = ""; state.status = "playing"; return `⏭ ${state.current.name} - ${state.current.artist}`; }
        if (state.current?.id) { state.status = "playing"; state.current.playUrl = ""; return `🔄 Replaying ${state.current.name}`; }
        state.status = "idle"; return "Queue empty";
      case "pause":
        state.status = state.status === "paused" ? "playing" : "paused";
        return state.status === "paused" ? "⏸ Paused" : "▶ Playing";
      case "queue":
        return JSON.stringify({ current: state.current?.name || null, count: state.queue.length, status: state.status });
      case "playlists":
        return JSON.stringify(await getPlaylists());
      case "add_to_playlist": {
        const sid = args.songId || state.current?.id;
        if (!sid) return "No song to add";
        await addToPlaylist(args.playlistId, sid);
        const pls = await getPlaylists();
        const t = pls.find(pl => pl.id === String(args.playlistId));
        return `✅ Added to「${t?.name || args.playlistId}」`;
      }
      case "playlist_tracks":
        return JSON.stringify(await getPlaylistDetail(args.playlistId));
      case "current_song": {
        if (!state.current) return "No song playing";
        if (!state.lyrics || state.lyrics._id !== state.current.id) {
          state.lyrics = { _id: state.current.id, lines: parseLrc(await getLyricsRaw(state.current.id)) };
        }
        return JSON.stringify({ name: state.current.name, artist: state.current.artist, position: fm(state.currentTime), positionSec: state.currentTime, lyricsContext: lyricsAround(state.lyrics.lines, state.currentTime, 4) });
      }
      case "lyrics": {
        const id = args.songId || state.current?.id;
        if (!id) return "No song specified";
        return (await getLyricsRaw(id)) || "(no lyrics)";
      }
      default: return "Unknown tool";
    }
  } catch (e) { return `❌ ${e.message}`; }
}

async function handleMcpMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;
  if (!method) return null;
  try {
    if (method === "initialize") return ok(id, mcpInfo);
    if (method === "notifications/initialized") return null;
    if (method === "tools/list") return ok(id, { tools });
    if (method === "tools/call") return txt(id, await execTool(params.name, params.arguments || {}));
    if (method === "ping") return ok(id, {});
    return txt(id, `Unknown: ${method}`);
  } catch (e) { return txt(id, `❌ ${e.message}`); }
}

// ─── Player HTML ───────────────────────────────────────────
function playerHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover"/><meta name="referrer" content="no-referrer"/><title>🎵 Claude Music Koyeb</title><style>*{margin:0;padding:0;box-sizing:border-box}:root{color-scheme:dark;--bg:#0d0d0d;--card:#1a1a1a;--muted:#888;--accent:#e83e3e;--text:#eee}body{background:var(--bg);color:var(--text);font-family:"SF Pro Display","PingFang SC",system-ui,sans-serif;min-height:100dvh;display:flex;flex-direction:column;align-items:center;padding:max(16px,4vw);-webkit-tap-highlight-color:transparent}h1{font-size:clamp(18px,4.5vw,24px);margin-bottom:4px}.sub{color:var(--muted);font-size:13px;margin-bottom:18px}.art{width:min(240px,58vw);aspect-ratio:1;border-radius:16px;object-fit:cover;background:var(--card);margin-bottom:14px;box-shadow:0 20px 40px rgba(0,0,0,.5)}.info{text-align:center;margin-bottom:8px}.info .name{font-size:clamp(15px,3.6vw,19px);font-weight:700}.info .artist{color:var(--muted);font-size:13px;margin-top:3px}.progress-wrap{width:100%;max-width:min(340px,80vw);margin-bottom:6px}.progress-row{display:flex;align-items:center;gap:10px}.time{font-size:11px;color:var(--muted);min-width:36px}.time.end{text-align:right}.bar-wrap{flex:1;height:20px;display:flex;align-items:center;cursor:pointer;position:relative}.bar-bg{width:100%;height:4px;background:rgba(255,255,255,.12);border-radius:2px;position:relative;overflow:visible}.bar-fill{height:100%;background:var(--accent);border-radius:2px;transition:width .15s linear}.bar-fill::after{content:"";position:absolute;right:-5px;top:-3px;width:10px;height:10px;border-radius:50%;background:var(--accent);opacity:0;transition:opacity .15s}.bar-wrap:active .bar-fill::after{opacity:1}.controls{display:flex;gap:18px;align-items:center;justify-content:center;margin-bottom:22px}.btn{border:none;border-radius:50%;display:grid;place-items:center;cursor:pointer;transition:.15s;background:var(--card);color:var(--text)}.btn:active{opacity:.7}.btn.small{width:42px;height:42px}.btn.big{width:58px;height:58px;background:var(--accent);color:#fff}.btn svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.btn.big svg{width:24px;height:24px;stroke-width:2.5;fill:currentColor}.queue{width:100%;max-width:min(360px,85vw);margin-top:4px}.queue h3{font-size:13px;color:var(--muted);margin-bottom:8px}.queue-item{display:flex;gap:10px;align-items:center;padding:9px 10px;border-radius:10px;margin-bottom:5px;background:var(--card)}.queue-item.active{background:#2a1a1a;border:1px solid var(--accent)}.queue-item img{width:38px;height:38px;border-radius:8px;object-fit:cover;background:#222;flex-shrink:0}.queue-item .qi{min-width:0}.queue-item .qname{font-size:13px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.queue-item .qart{font-size:11px;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.empty{color:var(--muted);font-size:13px;text-align:center;padding:20px}.status{font-size:11px;color:var(--muted);margin-top:6px;text-align:center}</style></head><body><h1>🎵 Claude Music</h1><div class="sub">跟 Claude 说"放一首歌"试试<br><button id="testBtn" style="margin-top:8px;padding:8px 16px;border-radius:20px;border:1px solid var(--accent);background:transparent;color:var(--accent);font-size:13px;cursor:pointer">🧪 测试·3首连播</button></div><img class="art" id="art" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><rect fill='%231a1a1a' width='200' height='200'/><text fill='%23888' x='100' y='110' text-anchor='middle' font-size='40'>🎵</text></svg>"><div class="info"><div class="name" id="name">等待播放</div><div class="artist" id="artist">告诉 Claude 你想听什么</div></div><div class="progress-wrap"><div class="progress-row"><span class="time" id="curTime">0:00</span><div class="bar-wrap" id="barWrap"><div class="bar-bg"><div class="bar-fill" id="barFill" style="width:0%"></div></div></div><span class="time end" id="durTime">0:00</span></div></div><div class="controls"><button class="btn small" onclick="prev()"><svg viewBox="0 0 24 24"><polyline points="19 20 9 12 19 4"/><line x1="5" y1="19" x2="5" y2="5"/></svg></button><button class="btn big" id="playBtn" onclick="togglePlay()"><svg id="playIcon" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20"/></svg></button><button class="btn small" onclick="next()"><svg viewBox="0 0 24 24"><polyline points="5 4 15 12 5 20"/><line x1="19" y1="5" x2="19" y2="19"/></svg></button></div><div class="queue"><h3>📋 播放队列</h3><div id="queue"></div></div><div class="status" id="status">已连接</div><audio id="audio" style="display:none" preload="auto"></audio><script>
const a=document.getElementById("audio");let currentId=null,resolvingUrl=null,lastQueueStr="",localQueue=[];
function fm(s){const m=Math.floor(s/60),sec=Math.floor(s%60);return m+":"+(sec<10?"0":"")+sec}
if("mediaSession" in navigator){["play","pause","previoustrack","nexttrack"].forEach(function(a){navigator.mediaSession.setActionHandler(a,function(){if(a==="play")togglePlay();if(a==="pause")togglePlay();if(a==="previoustrack")prev();if(a==="nexttrack")next()})})}
async function poll(){try{const r=await fetch("/api/state");if(!r.ok)return;const d=await r.json();render(d)}catch(e){}}
function resolveUrlFor(songId){if(!songId||resolvingUrl===songId)return;resolvingUrl=songId;document.getElementById("status").textContent="🔊 加载音频...";fetch("/api/url?id="+encodeURIComponent(songId)).then(r=>r.json()).then(j=>{if(j.playUrl&&currentId===songId){a.src=j.playUrl;a.play().catch(function(){});document.getElementById("status").textContent="▶ 播放中"}else if(currentId===songId){document.getElementById("status").textContent="⚠ 无播放链接"}resolvingUrl=null}).catch(function(){resolvingUrl=null;document.getElementById("status").textContent="⚠ 加载失败"})}
function render(d){
  if(d.current&&d.current.id){var ex=localQueue.some(function(t){return t.id===d.current.id});if(!ex)localQueue.push({id:d.current.id,name:d.current.name,artist:d.current.artist,coverUrl:d.current.coverUrl,durationMs:d.current.durationMs})}
  if(d.queue&&d.queue.length>0){for(var i=0;i<d.queue.length;i++){var s=d.queue[i];if(!localQueue.some(function(t){return t.id===s.id}))localQueue.push(s)}}
  if(!currentId&&d.current&&d.current.id){currentId=d.current.id;document.getElementById("art").src=d.current.coverUrl||"";document.getElementById("name").textContent=d.current.name||"";document.getElementById("artist").textContent=d.current.artist||"";if("mediaSession" in navigator){navigator.mediaSession.metadata=new MediaMetadata({title:d.current.name,artist:d.current.artist,album:d.current.album||"",artwork:[{src:d.current.coverUrl||"",sizes:"300x300"}]})}if(d.playUrl){a.src=d.playUrl;a.play().catch(function(){});document.getElementById("status").textContent="▶ 播放中"}else resolveUrlFor(d.current.id)}
  if(a.duration&&!isNaN(a.duration)){document.getElementById("barFill").style.width=(a.currentTime/a.duration*100).toFixed(1)+"%";document.getElementById("curTime").textContent=fm(a.currentTime);document.getElementById("durTime").textContent=fm(a.duration)}
  document.getElementById("playIcon").innerHTML=a.paused?'<polygon points="6 4 20 12 6 20"/>':'<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
  var qStr=localQueue.map(function(t){return t.id}).join(",")+"|"+currentId;
  if(qStr!==lastQueueStr){lastQueueStr=qStr;var el=document.getElementById("queue");if(!localQueue.length)el.innerHTML='<div class="empty">队列空的</div>';else{var h='';for(var i=0;i<localQueue.length;i++){var t=localQueue[i];h+='<div class="queue-item'+(t.id===currentId?' active':'')+'"><img src="'+(t.coverUrl||'')+'" onerror="this.style.display=\\'none\\'"><div class="qi"><div class="qname">'+esc(t.name)+'</div><div class="qart">'+esc(t.artist)+'</div></div></div>'}el.innerHTML=h}}
}
function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function playSong(t){currentId=t.id;document.getElementById("art").src=t.coverUrl||"";document.getElementById("name").textContent=t.name||"";document.getElementById("artist").textContent=t.artist||"";if("mediaSession" in navigator)navigator.mediaSession.metadata=new MediaMetadata({title:t.name,artist:t.artist,artwork:[{src:t.coverUrl||"",sizes:"300x300"}]});resolveUrlFor(t.id)}
function togglePlay(){a.paused?a.play().catch(function(){}):a.pause()}
function next(){a.pause();var idx=localQueue.findIndex(function(t){return t.id===currentId});if(idx>=0&&idx+1<localQueue.length)playSong(localQueue[idx+1]);else document.getElementById("status").textContent="✅ 队列播完"}
function prev(){a.pause();var idx=localQueue.findIndex(function(t){return t.id===currentId});if(idx>0)playSong(localQueue[idx-1]);else if(localQueue.length>0){playSong(localQueue[0]);document.getElementById("status").textContent="🔁 第一首"}}
a.addEventListener("play",function(){document.getElementById("status").textContent="▶ 播放中"});
a.addEventListener("pause",function(){document.getElementById("status").textContent="⏸ 暂停"});
a.addEventListener("ended",function(){document.getElementById("status").textContent="✅ 播放完毕·切歌中";setTimeout(next,500)});
a.addEventListener("error",function(){document.getElementById("status").textContent="⚠ 播放失败·重试中";setTimeout(function(){if(currentId)resolveUrlFor(currentId)},2000)});
a.addEventListener("timeupdate",function(){if(a.duration&&!isNaN(a.duration)){document.getElementById("barFill").style.width=(a.currentTime/a.duration*100).toFixed(1)+"%";document.getElementById("curTime").textContent=fm(a.currentTime);document.getElementById("durTime").textContent=fm(a.duration)}});
document.getElementById("barWrap").addEventListener("click",function(e){if(!a.duration||isNaN(a.duration))return;var r=this.getBoundingClientRect();a.currentTime=Math.max(0,Math.min(a.duration,(e.clientX-r.left)/r.width*a.duration))});
setInterval(poll,2000);poll();
setInterval(function(){if(a.currentTime&&!a.paused)fetch("/api/time",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({time:a.currentTime})}).catch(function(){})},3000);
document.getElementById("testBtn").addEventListener("click",function(){var btn=this,songs=["Justin Bieber Boyfriend","Justin Bieber As Long As You Love Me","Love Story Taylor Swift"],done=0;btn.textContent="加载中...";btn.disabled=true;function addOne(i){if(i>=songs.length){btn.textContent="✅ "+done+"/3";btn.disabled=false;setTimeout(poll,500);return}btn.textContent="加载第"+(i+1)+"首...";fetch("/api/mcp",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:90+i,method:"tools/call",params:{name:"play",arguments:{keyword:songs[i]}}})}).then(function(r){return r.json()}).then(function(j){done++;setTimeout(function(){addOne(i+1)},1000)}).catch(function(){btn.textContent="❌ 失败";btn.disabled=false})}addOne(0)});
</script></body></html>`;
}

// ─── HTTP Server ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = u.pathname.replace(/\/+$/, "") || "/";

  try {
    // Player page
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(playerHtml()); return;
    }
    // Player state
    if (req.method === "GET" && path === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ current: state.current || null, queue: state.queue.slice(0, 20), status: state.status, playUrl: state.current?.playUrl || "" }));
      return;
    }
    // Player URL resolve
    if (req.method === "GET" && path === "/api/url") {
      const id = u.searchParams.get("id");
      if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: "missing id" })); return; }
      let playUrl = "";
      try { playUrl = await getSongUrl(id) || ""; } catch {}
      if (state.current?.id === id) state.current.playUrl = playUrl;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ playUrl })); return;
    }
    // Player next/prev
    if (req.method === "GET" && (path === "/api/next" || path === "/api/prev")) {
      if (path === "/api/next" && state.queue.length > 1) { state.queue.shift(); state.current = state.queue[0]; }
      if (state.current) state.current.playUrl = "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: state.current?.id || "" })); return;
    }
    // Player time report
    if (req.method === "POST" && path === "/api/time") {
      try { const b = await readBody(req); state.currentTime = Number(b.time) || 0; } catch {}
      res.writeHead(200); res.end("ok"); return;
    }
    // Debug
    if (path === "/api/debug") {
      try {
        const pl = await getPlaylists();
        let urlTest = ""; try { urlTest = await getSongUrl("186016") || "(empty)"; } catch (e) { urlTest = "error: " + e.message; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cookieLen: COOKIE.length, playlistCount: pl.length, urlTest: urlTest.slice(0, 100), server: "Koyeb Singapore" }));
      } catch (e) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    // MCP POST
    if (req.method === "POST" && path === "/api/mcp") {
      let body = await readBody(req);
      if (typeof body === "string") body = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (Array.isArray(body)) {
        const results = []; for (const msg of body) { const r = await handleMcpMessage(msg); if (r) results.push(r); }
        res.end(JSON.stringify(results));
      } else {
        const r = await handleMcpMessage(body);
        if (r) res.end(JSON.stringify(r)); else { res.writeHead(202); res.end(""); }
      }
      return;
    }
    // MCP GET
    if (req.method === "GET" && path === "/api/mcp") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true })); return;
    }
    // OAuth
    if (path.includes("oauth") || path.includes("register")) { res.writeHead(404); res.end(); return; }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
    });
  });
}

server.listen(PORT, () => {
  console.log(`netease-music-mcp running on port ${PORT}`);
});
