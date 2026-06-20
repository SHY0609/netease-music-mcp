const COOKIE = process.env.NETEASE_COOKIE || "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const REF = "https://music.163.com/";
const H = { "User-Agent": UA, "Referer": REF, cookie: COOKIE };

function fm(s) { const m = Math.floor((s||0)/60), sec = Math.floor((s||0)%60); return m+":"+(sec<10?"0":"")+sec; }

// Vercel is US-based; weapi endpoints are blocked for non-CN IPs.

async function apiGet(path) {
  const res = await fetch(`https://music.163.com${path}`, { headers: H });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Netease`);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Netease non-JSON: ${text.slice(0, 200)}`); }
}

// ─── persistent player state (file-backed, survives warm instances) ──
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const STATE_FILE = join(tmpdir(), "netease-player-state.json");

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { queue: [], current: null, status: "idle", currentTime: 0, lyrics: null };
  }
}
async function saveState(s) {
  try { await writeFile(STATE_FILE, JSON.stringify(s), "utf8"); } catch {}
}
// Global cache (warm instance), reloaded from file each request
let _state = null;
async function getPlayer() {
  if (!_state) _state = await loadState();
  return _state;
}
async function persist() {
  if (_state) await saveState(_state);
}

// ─── lyrics parser ─────────────────────────────────────────
function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const matches = [...raw.matchAll(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = raw.replace(/\[[^\]]+]/g, "").trim();
    for (const m of matches) {
      const min = Number(m[1]), sec = Number(m[2]), frac = (Number(m[3] || "0".padEnd(3, "0")) / 1000) || 0;
      lines.push({ time: min * 60 + sec + frac, text });
    }
  }
  return lines.filter(l => l.text).sort((a, b) => a.time - b.time);
}
function lyricsAround(lines, time, n = 4) {
  let idx = lines.findIndex(l => l.time >= time);
  if (idx < 0) idx = Math.max(0, lines.length - n);
  return { past: lines.slice(Math.max(0, idx - 1), idx).map(l => l.text), current: lines[idx]?.text || "", upcoming: lines.slice(idx + 1, idx + 1 + n).map(l => l.text) };
}

// ─── netease helpers (old API, GET) ────────────────────────
async function getLyricsRaw(id) {
  try {
    const r = await apiGet(`/api/song/lyric?id=${id}&lv=1&tv=1`);
    return (r.lrc?.lyric || "") + "\n" + (r.tlyric?.lyric || "");
  } catch { return ""; }
}

async function searchSongs(kw, limit = 5) {
  const r = await apiGet(`/api/search/get?s=${encodeURIComponent(kw)}&type=1&limit=${limit}`);
  return (r.result?.songs || []).map(s => ({
    id: String(s.id), name: s.name,
    artist: (s.artists || s.ar || []).map(a => a.name).join(" / "),
    album: (s.album || s.al || {}).name || "",
    coverUrl: (s.album || s.al || {}).picUrl || "",
    durationMs: s.duration || s.dt || 0,
  }));
}

async function getSongUrl(id) {
  // 1. Try authenticated API first (for VIP songs, needs full cookie)
  try {
    const r = await apiGet(`/api/song/enhance/player/url?ids=[${id}]&br=320000`);
    const url = r.data?.[0]?.url;
    if (url) return url.replace(/^http:\/\//, "https://");
  } catch {}
  // 2. Fallback: outer URL (no auth needed, works for free songs)
  try {
    const r = await fetch(`https://music.163.com/song/media/outer/url?id=${id}`, {
      headers: H, redirect: "manual",
    });
    const loc = r.headers.get("location") || "";
    if (!loc.includes("/404")) return loc.replace(/^http:\/\//, "https://");
  } catch {}
  return "";
}

async function getPlaylists() {
  const r = await apiGet("/api/user/playlist?uid=0&limit=50&offset=0");
  return (r.playlist || []).map(p => ({ id: String(p.id), name: p.name, trackCount: p.trackCount }));
}

async function getPlaylistDetail(id) {
  const r = await apiGet(`/api/v6/playlist/detail?id=${id}&n=30`);
  const p = r.playlist || {};
  const tracks = (p.tracks || p.trackIds || []).map(s => {
    if (typeof s === "object") return { id: String(s.id), name: s.name, artist: (s.artists || s.ar || []).map(a => a.name).join(" / ") };
    return { id: String(s), name: "", artist: "" }; // trackIds format
  });
  return { name: p.name || "(unnamed)", trackCount: p.trackCount || tracks.length, tracks };
}

async function addToPlaylist(pid, songId) {
  // Write operations need POST to old API
  const res = await fetch("https://music.163.com/api/playlist/manipulate/tracks", {
    method: "POST",
    headers: { ...H, "content-type": "application/x-www-form-urlencoded" },
    body: `op=add&pid=${encodeURIComponent(pid)}&trackIds=${encodeURIComponent(songId)}`,
  });
  const r = await res.json();
  if (r.code !== 200) throw new Error(r.message || r.msg || "add failed");
  return true;
}

// ─── MCP (lightweight JSON‑RPC) ────────────────────────────
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const txt = (id, text) => ok(id, { content: [{ type: "text", text }] });

const mcpInfo = {
  protocolVersion: "2024-11-05",
  serverInfo: { name: "netease-music", version: "1.1.0" },
  capabilities: { tools: {} },
};

const tools = [
  { name: "play", description: "Search and play a song. AI constructs the keyword freely.",
    inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] } },
  { name: "skip", description: "Skip to next song.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "pause", description: "Toggle pause/resume.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "queue", description: "View current queue.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "playlists", description: "Get your NetEase playlists.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "add_to_playlist", description: "Add current song to a playlist.",
    inputSchema: { type: "object", properties: { songId: { type: "string" }, playlistId: { type: "string" } }, required: ["playlistId"] } },
  { name: "playlist_tracks", description: "Get tracks in a playlist.",
    inputSchema: { type: "object", properties: { playlistId: { type: "string" } }, required: ["playlistId"] } },
  { name: "current_song", description: "Get current song info, playback position, and lyrics around current position. AI can see what you're hearing right now.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "lyrics", description: "Get full lyrics for the current or specified song.",
    inputSchema: { type: "object", properties: { songId: { type: "string" } }, required: [] } },
];

async function execTool(name, args) {
  const p = await getPlayer();
  try {
    switch (name) {
      case "play": {
        const songs = await searchSongs(args.keyword, 8);
        if (!songs.length) return `No results for "${args.keyword}"`;
        // Check availability in parallel (outer URL), pick first playable
        const checks = await Promise.all(songs.map(async s => {
          try { const u = await getSongUrl(s.id); return u ? s : null; } catch { return null; }
        }));
        const pick = checks.find(Boolean);
        if (!pick) return `"${args.keyword}" 的搜索结果无可播放歌曲`;
        p.current = { id: pick.id, name: pick.name, artist: pick.artist, album: pick.album, coverUrl: pick.coverUrl, durationMs: pick.durationMs, playUrl: "" };
        p.status = "playing";
        if (!p.queue.find(q => q.id === pick.id)) p.queue.unshift(pick);
        await persist();
        return `🎵 ${pick.name} - ${pick.artist}`;
      }
      case "skip":
        if (p.queue.length > 1) {
          p.queue.shift(); p.current = p.queue[0]; p.current.playUrl = "";
          p.status = "playing";
          await persist();
          return `⏭ ${p.current.name} - ${p.current.artist}`;
        }
        if (p.current?.id) {
          // Replay current from start
          p.status = "playing";
          p.current.playUrl = "";
          await persist();
          return `🔄 Replaying ${p.current.name} - ${p.current.artist}`;
        }
        p.status = "idle";
        await persist();
        return "Queue empty";
      case "pause":
        p.status = p.status === "paused" ? "playing" : "paused";
        await persist();
        return p.status === "paused" ? "⏸ Paused" : "▶ Playing";
      case "queue":
        return JSON.stringify({ current: p.current?.name || null, count: p.queue.length, status: p.status });
      case "playlists": {
        const pl = await getPlaylists();
        return JSON.stringify(pl);
      }
      case "add_to_playlist": {
        const sid = args.songId || p.current?.id;
        if (!sid) return "No song to add";
        await addToPlaylist(args.playlistId, sid);
        const pls = await getPlaylists();
        const t = pls.find(pl => pl.id === String(args.playlistId));
        return `✅ Added to「${t?.name || args.playlistId}」`;
      }
      case "playlist_tracks": {
        const d = await getPlaylistDetail(args.playlistId);
        return JSON.stringify(d);
      }
      case "current_song": {
        if (!p.current) return "No song playing";
        // Fetch lyrics if not cached
        if (!p.lyrics || p.lyrics._id !== p.current.id) {
          const lrc = await getLyricsRaw(p.current.id);
          p.lyrics = { _id: p.current.id, lines: parseLrc(lrc) };
        }
        const around = lyricsAround(p.lyrics.lines, p.currentTime || 0, 4);
        return JSON.stringify({
          name: p.current.name, artist: p.current.artist,
          position: fm(p.currentTime || 0),
          positionSec: p.currentTime || 0,
          lyricsContext: around,
        });
      }
      case "lyrics": {
        const id = args.songId || p.current?.id;
        if (!id) return "No song specified";
        const lrc = await getLyricsRaw(id);
        return lrc || "(no lyrics available)";
      }
      default: return "Unknown tool";
    }
  } catch (e) {
    return `❌ ${e.message}`;
  }
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
    return txt(id, `Unknown method: ${method}`);
  } catch (e) {
    return txt(id, `❌ ${e.message}`);
  }
}

// ─── player HTML ───────────────────────────────────────────
function playerHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover"/><meta name="referrer" content="no-referrer"/><title>🎵 v2.0 Claude 音乐</title><style>*{margin:0;padding:0;box-sizing:border-box}:root{color-scheme:dark;--bg:#0d0d0d;--card:#1a1a1a;--muted:#888;--accent:#e83e3e;--text:#eee}body{background:var(--bg);color:var(--text);font-family:"SF Pro Display","PingFang SC",system-ui,sans-serif;min-height:100dvh;display:flex;flex-direction:column;align-items:center;padding:max(16px,4vw);-webkit-tap-highlight-color:transparent}h1{font-size:clamp(18px,4.5vw,24px);margin-bottom:4px}.sub{color:var(--muted);font-size:13px;margin-bottom:18px}.art{width:min(240px,58vw);aspect-ratio:1;border-radius:16px;object-fit:cover;background:var(--card);margin-bottom:14px;box-shadow:0 20px 40px rgba(0,0,0,.5)}.info{text-align:center;margin-bottom:8px}.info .name{font-size:clamp(15px,3.6vw,19px);font-weight:700}.info .artist{color:var(--muted);font-size:13px;margin-top:3px}
/* progress */
.progress-wrap{width:100%;max-width:min(340px,80vw);margin-bottom:6px}.progress-row{display:flex;align-items:center;gap:10px}.time{font-size:11px;color:var(--muted);min-width:36px;font-variant-numeric:tabular-nums}.time.end{text-align:right}.bar-wrap{flex:1;height:20px;display:flex;align-items:center;cursor:pointer;position:relative;-webkit-tap-highlight-color:transparent}.bar-bg{width:100%;height:4px;background:rgba(255,255,255,.12);border-radius:2px;position:relative;overflow:visible}.bar-fill{height:100%;background:var(--accent);border-radius:2px;transition:width .15s linear;position:relative}.bar-fill::after{content:"";position:absolute;right:-5px;top:-3px;width:10px;height:10px;border-radius:50%;background:var(--accent);opacity:0;transition:opacity .15s}.bar-wrap:active .bar-fill::after{opacity:1}
.controls{display:flex;gap:18px;align-items:center;justify-content:center;margin-bottom:22px}.btn{border:none;border-radius:50%;display:grid;place-items:center;cursor:pointer;transition:.15s;background:var(--card);color:var(--text)}.btn:active{opacity:.7}.btn.small{width:42px;height:42px}.btn.big{width:58px;height:58px;background:var(--accent);color:#fff}.btn svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.btn.big svg{width:24px;height:24px;stroke-width:2.5;fill:currentColor}.queue{width:100%;max-width:min(360px,85vw);margin-top:4px}.queue h3{font-size:13px;color:var(--muted);margin-bottom:8px}.queue-item{display:flex;gap:10px;align-items:center;padding:9px 10px;border-radius:10px;margin-bottom:5px;background:var(--card)}.queue-item.active{background:#2a1a1a;border:1px solid var(--accent)}.queue-item img{width:38px;height:38px;border-radius:8px;object-fit:cover;background:#222;flex-shrink:0}.queue-item .qi{min-width:0}.queue-item .qname{font-size:13px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.queue-item .qart{font-size:11px;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.empty{color:var(--muted);font-size:13px;text-align:center;padding:20px}.status{font-size:11px;color:var(--muted);margin-top:6px;text-align:center}</style></head><body><h1>🎵 Claude 音乐</h1><div class="sub">跟 Claude 说"放一首歌"试试<br><button id="testBtn" style="margin-top:8px;padding:8px 16px;border-radius:20px;border:1px solid var(--accent);background:transparent;color:var(--accent);font-size:13px;cursor:pointer">🧪 测试·3首连播</button></div><img class="art" id="art" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><rect fill='%231a1a1a' width='200' height='200'/><text fill='%23888' x='100' y='110' text-anchor='middle' font-size='40'>🎵</text></svg>"><div class="info"><div class="name" id="name">等待播放</div><div class="artist" id="artist">告诉 Claude 你想听什么</div></div><div class="progress-wrap"><div class="progress-row"><span class="time" id="curTime">0:00</span><div class="bar-wrap" id="barWrap"><div class="bar-bg"><div class="bar-fill" id="barFill" style="width:0%"></div></div></div><span class="time end" id="durTime">0:00</span></div></div><div class="controls"><button class="btn small" onclick="prev()"><svg viewBox="0 0 24 24"><polyline points="19 20 9 12 19 4"/><line x1="5" y1="19" x2="5" y2="5"/></svg></button><button class="btn big" id="playBtn" onclick="togglePlay()"><svg id="playIcon" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20"/></svg></button><button class="btn small" onclick="next()"><svg viewBox="0 0 24 24"><polyline points="5 4 15 12 5 20"/><line x1="19" y1="5" x2="19" y2="19"/></svg></button></div><div class="queue"><h3>📋 播放队列</h3><div id="queue"></div></div><div class="status" id="status">已连接</div><audio id="audio" style="display:none" preload="auto"></audio><script>
const a=document.getElementById("audio");let currentId=null,resolvingUrl=null,lastQueueStr="",localQueue=[],playerActive=false;
function fm(s){const m=Math.floor(s/60),sec=Math.floor(s%60);return m+":"+(sec<10?"0":"")+sec}
// Media Session
if("mediaSession" in navigator){navigator.mediaSession.setActionHandler("play",()=>a.play());navigator.mediaSession.setActionHandler("pause",()=>a.pause());navigator.mediaSession.setActionHandler("previoustrack",()=>prev());navigator.mediaSession.setActionHandler("nexttrack",()=>next());}
// Poll state
async function poll(){try{const r=await fetch("/api/state");if(!r.ok)return;const d=await r.json();render(d)}catch(e){}}
// Resolve URL (player-initiated, retries on next poll)
function resolveUrlFor(songId){if(!songId||resolvingUrl===songId)return;resolvingUrl=songId;document.getElementById("status").textContent="🔊 加载音频...";fetch("/api/url?id="+encodeURIComponent(songId)).then(r=>r.json()).then(j=>{if(j.playUrl&&currentId===songId){a.src=j.playUrl;a.play().catch(()=>{});document.getElementById("status").textContent="▶ 播放中"}else if(currentId===songId){document.getElementById("status").textContent="⚠ 无播放链接";}resolvingUrl=null;}).catch(()=>{resolvingUrl=null;document.getElementById("status").textContent="⚠ 加载失败·稍后重试"});}
function render(d){
  // Merge new songs from server into local queue (don't overwrite, don't switch)
  if(d.current&&d.current.id){
    var exists=localQueue.some(function(t){return t.id===d.current.id});
    if(!exists){localQueue.push({id:d.current.id,name:d.current.name,artist:d.current.artist,coverUrl:d.current.coverUrl,durationMs:d.current.durationMs});}
  }
  if(d.queue&&d.queue.length>0){
    for(var i=0;i<d.queue.length;i++){var s=d.queue[i];if(!localQueue.some(function(t){return t.id===s.id})){localQueue.push(s);}}
  }
  // Only auto-switch to new song if nothing is playing yet
  if(!currentId&&d.current&&d.current.id){
    currentId=d.current.id;playerActive=true;
    document.getElementById("art").src=d.current.coverUrl||"";document.getElementById("name").textContent=d.current.name||"";document.getElementById("artist").textContent=d.current.artist||"";
    if("mediaSession" in navigator){navigator.mediaSession.metadata=new MediaMetadata({title:d.current.name,artist:d.current.artist,album:d.current.album||"",artwork:[{src:d.current.coverUrl||"",sizes:"300x300"}]});}
    if(d.playUrl){a.src=d.playUrl;a.play().catch(function(){});document.getElementById("status").textContent="▶ 播放中"}else{resolveUrlFor(d.current.id)}
  }
  // Progress bar
  if(a.duration&&!isNaN(a.duration)){var pct=(a.currentTime/a.duration*100).toFixed(1);document.getElementById("barFill").style.width=pct+"%";document.getElementById("curTime").textContent=fm(a.currentTime);document.getElementById("durTime").textContent=fm(a.duration)}
  // Play icon
  var pi=document.getElementById("playIcon");
  pi.innerHTML=a.paused?'<polygon points="6 4 20 12 6 20"/>':'<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
  // Queue display — only rebuild if changed
  var qStr=localQueue.map(function(t){return t.id}).join(",")+"|"+currentId;
  if(qStr!==lastQueueStr){lastQueueStr=qStr;var el=document.getElementById("queue");
    if(!localQueue.length)el.innerHTML='<div class="empty">队列空的</div>';
    else{var h='';for(var i=0;i<localQueue.length;i++){var t=localQueue[i];h+='<div class="queue-item'+(t.id===currentId?' active':'')+'"><img src="'+(t.coverUrl||'')+'" onerror="this.style.display=\\'none\\'"><div class="qi"><div class="qname">'+esc(t.name)+'</div><div class="qart">'+esc(t.artist)+'</div></div></div>';}el.innerHTML=h;}
  }}
function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
// Controls
function togglePlay(){a.paused?a.play().catch(()=>{}):a.pause();}
function playSong(t){currentId=t.id;document.getElementById("art").src=t.coverUrl||"";document.getElementById("name").textContent=t.name||"";document.getElementById("artist").textContent=t.artist||"";if("mediaSession" in navigator){navigator.mediaSession.metadata=new MediaMetadata({title:t.name,artist:t.artist,artwork:[{src:t.coverUrl||"",sizes:"300x300"}]});}playerActive=true;resolveUrlFor(t.id);document.getElementById("status").textContent="⏭ 切歌中..."}
function next(){a.pause();var idx=localQueue.findIndex(function(t){return t.id===currentId});if(idx>=0&&idx+1<localQueue.length){playSong(localQueue[idx+1])}else{document.getElementById("status").textContent="✅ 队列播完"}}
function prev(){a.pause();var idx=localQueue.findIndex(function(t){return t.id===currentId});if(idx>0){playSong(localQueue[idx-1])}else if(localQueue.length>0){playSong(localQueue[0]);document.getElementById("status").textContent="🔁 第一首"}}
// Progress bar click to seek
document.getElementById("barWrap").addEventListener("click",function(e){if(!a.duration||isNaN(a.duration))return;const rect=this.getBoundingClientRect();const pct=(e.clientX-rect.left)/rect.width;a.currentTime=Math.max(0,Math.min(a.duration,pct*a.duration))});
// Audio events
a.addEventListener("play",()=>{document.getElementById("playIcon").innerHTML='<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';document.getElementById("status").textContent="▶ 播放中"});
a.addEventListener("pause",()=>{document.getElementById("playIcon").innerHTML='<polygon points="6 4 20 12 6 20"/>';if(!a.ended)document.getElementById("status").textContent="⏸ 暂停"});
a.addEventListener("ended",()=>{document.getElementById("status").textContent="✅ 播放完毕·切歌中";setTimeout(next,500)});
a.addEventListener("error",()=>{document.getElementById("status").textContent="⚠ 播放失败·2秒后重试";setTimeout(()=>{if(currentId)resolveUrlFor(currentId)},2000)});
a.addEventListener("timeupdate",function(){if(a.duration&&!isNaN(a.duration)){const pct=(a.currentTime/a.duration*100).toFixed(1);document.getElementById("barFill").style.width=pct+"%";document.getElementById("curTime").textContent=fm(a.currentTime);document.getElementById("durTime").textContent=fm(a.duration)}});
setInterval(poll,2000);poll();
// Report playback time to server every 3s (so AI knows where you are)
setInterval(()=>{if(a.currentTime&&!a.paused)fetch("/api/time",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({time:a.currentTime})}).catch(()=>{})},3000);
// Quick test button — simulates Claude calling "play"
document.getElementById("testBtn").addEventListener("click",function(){var btn=this;btn.textContent="加载第1首...";btn.disabled=true;var songs=["林俊杰 修炼爱情","林俊杰 不为谁而作的歌","林俊杰 可惜没如果"];var done=0;function addOne(i){if(i>=songs.length){btn.textContent="✅ 3首已加入·刷新页面";btn.disabled=false;setTimeout(poll,500);return;}btn.textContent="加载第"+(i+1)+"首...";fetch("/api/mcp",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:90+i,method:"tools/call",params:{name:"play",arguments:{keyword:songs[i]}}})}).then(function(r){return r.json()}).then(function(j){done++;btn.textContent="✅ "+done+"/3";setTimeout(function(){addOne(i+1)},1000)}).catch(function(){btn.textContent="❌ 失败·重试";btn.disabled=false})}addOne(0)});

</script></body></html>`;
}

// ─── Vercel handler ─────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    // Player page
    if (req.method === "GET" && path === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.statusCode = 200; res.end(playerHtml()); return;
    }

    // Player state
    if (req.method === "GET" && path === "/api/state") {
      const p = await getPlayer();
      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ current: p.current || null, queue: p.queue.slice(0, 20), status: p.status, playUrl: p.current?.playUrl || "" }));
      return;
    }

    // Player requests URL for a song (called from browser JS directly)
    if (req.method === "GET" && path === "/api/url") {
      const id = url.searchParams.get("id");
      if (!id) { res.statusCode = 400; res.end(JSON.stringify({ error: "missing id" })); return; }
      let playUrl = "";
      try { playUrl = await getSongUrl(id) || ""; } catch {}
      // Cache it on the current song
      const p = await getPlayer();
      if (p.current?.id === id) p.current.playUrl = playUrl;
      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ playUrl }));
      return;
    }

    // Player next/prev — no blocking URL resolve
    if (req.method === "GET" && (path === "/api/next" || path === "/api/prev")) {
      const p = await getPlayer();
      if (path === "/api/next" && p.queue.length > 1) { p.queue.shift(); p.current = p.queue[0]; }
      p.current && (p.current.playUrl = "");
      await persist();
      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: p.current?.id || "", playUrl: p.queue.length > 1 ? "" : "" }));
      return;
    }

    // Player reports current playback time
    if (req.method === "POST" && path === "/api/time") {
      const p = await getPlayer();
      try {
        const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
        p.currentTime = Number(b.time) || 0;
      } catch {}
      res.statusCode = 200; res.end("ok");
      return;
    }

    // Debug: test cookie validity with Netease
    if (path === "/api/debug") {
      try {
        // Test 1: check cookie existence
        const cookieLen = COOKIE.length;
        // Test 2: try to get user playlists (needs auth)
        const pl = await getPlaylists();
        // Test 3: try to get a song URL
        let urlTest = "";
        try { urlTest = await getSongUrl("2652820720") || "(empty)"; } catch(e) { urlTest = "error: "+e.message; }
        res.statusCode = 200; res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ cookieLen, playlistCount: pl.length, urlTest: urlTest.slice(0, 100) }));
      } catch(e) {
        res.statusCode = 200; res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Health
    if (path === "/api/health") {
      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true })); return;
    }

    // MCP POST
    if (req.method === "POST" && path === "/api/mcp") {
      let body = req.body;
      if (body === undefined || body === null) {
        const chunks = []; for await (const c of req) chunks.push(c);
        body = JSON.parse(Buffer.concat(chunks).toString("utf8").trim() || "{}");
      } else if (typeof body === "string") {
        body = body.trim() ? JSON.parse(body) : {};
      }
      res.setHeader("Content-Type", "application/json");
      if (Array.isArray(body)) {
        const results = []; for (const msg of body) { const r = await handleMcpMessage(msg); if (r) results.push(r); }
        res.statusCode = 200; res.end(JSON.stringify(results));
      } else {
        const r = await handleMcpMessage(body);
        if (r) { res.statusCode = 200; res.end(JSON.stringify(r)); }
        else { res.statusCode = 202; res.end(""); }
      }
      return;
    }

    // MCP GET
    if (req.method === "GET" && path === "/api/mcp") {
      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true })); return;
    }

    // OAuth — 404
    if (path.includes("oauth") || path.includes("register")) {
      res.statusCode = 404; res.end(""); return;
    }

    res.statusCode = 404; res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (e) {
    res.statusCode = 500; res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message || "Internal error" }));
  }
}
