/**
 * lib/screentime.js — iPhone 屏幕使用时间追踪
 *
 * iPhone Shortcuts 每次打开/关闭 APP 时发 GET 请求到
 * /api/screentime/toggle/APPNAME，本模块负责存取和查询。
 *
 * 设计思路（来自蛋壳的教程）：
 * - toggle 而非分 open/close，自动取反上一个状态
 * - 只保留 24 小时数据，自动清理
 * - 文件持久化，重启不丢
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DATA_FILE = join(tmpdir(), "screentime-data.json");
const MAX_HOURS = 24;

// 内存状态
let events = [];   // [{ app, type:"open"|"close", time: ISO string }]
let lastState = {}; // { appName: "open"|"close" }

// ─── 加载持久化数据 ───
async function load() {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const data = JSON.parse(raw);
    events = data.events || [];
    lastState = data.lastState || {};
    cleanup();
  } catch {
    events = [];
    lastState = {};
  }
}

// ─── 保存到文件 ───
async function save() {
  try {
    await writeFile(DATA_FILE, JSON.stringify({ events, lastState }), "utf8");
  } catch {}
}

// ─── 清理超过 24 小时的数据 ───
function cleanup() {
  const cutoff = new Date(Date.now() - MAX_HOURS * 3600 * 1000).toISOString();
  events = events.filter(e => e.time > cutoff);
}

// ─── Toggle：iPhone 快捷指令调用此函数 ───
// 每次调用自动在 open/close 之间切换
async function toggle(appName) {
  if (!appName || typeof appName !== "string") return { error: "missing appName" };

  const prev = lastState[appName];
  const now = new Date().toISOString();

  if (prev === "open") {
    // 上次是打开 → 现在关闭
    events.push({ app: appName, type: "close", time: now });
    lastState[appName] = "close";
  } else {
    // 上次是关闭（或首次）→ 现在打开
    events.push({ app: appName, type: "open", time: now });
    lastState[appName] = "open";
  }

  cleanup();
  await save();
  return { app: appName, action: lastState[appName], time: now };
}

// ─── 获取今日报告 ───
function getReport() {
  cleanup();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  // 过滤今天的事件
  const todayEvents = events.filter(e => e.time >= todayStart);

  // 按 APP 聚合
  const appMap = {};
  for (const e of todayEvents) {
    if (!appMap[e.app]) appMap[e.app] = { app: e.app, sessions: [], openCount: 0, totalSeconds: 0 };
    appMap[e.app].openCount++;
  }

  // 计算使用时长：配对 open → close
  for (const appName of Object.keys(appMap)) {
    const appEvents = todayEvents.filter(e => e.app === appName);
    let openTime = null;
    let totalMs = 0;

    for (const e of appEvents) {
      if (e.type === "open") {
        openTime = new Date(e.time);
        appMap[appName].sessions.push({ start: e.time, end: null, durationMin: 0 });
      } else if (e.type === "close" && openTime) {
        const closeTime = new Date(e.time);
        const durationMs = closeTime - openTime;
        totalMs += durationMs;
        const lastSession = appMap[appName].sessions[appMap[appName].sessions.length - 1];
        if (lastSession && !lastSession.end) {
          lastSession.end = e.time;
          lastSession.durationMin = Math.round(durationMs / 60000 * 10) / 10;
        }
        openTime = null;
      }
    }

    // 如果当前还开着，算到 now
    if (openTime && lastState[appName] === "open") {
      const durationMs = now - openTime;
      totalMs += durationMs;
      const lastSession = appMap[appName].sessions[appMap[appName].sessions.length - 1];
      if (lastSession && !lastSession.end) {
        lastSession.end = "now";
        lastSession.durationMin = Math.round(durationMs / 60000 * 10) / 10;
      }
    }

    appMap[appName].totalSeconds = Math.round(totalMs / 1000);
    appMap[appName].totalMinutes = Math.round(totalMs / 60000 * 10) / 10;
    appMap[appName].sessionCount = appMap[appName].sessions.length;
  }

  // 按使用时长排序
  const apps = Object.values(appMap).sort((a, b) => b.totalSeconds - a.totalSeconds);

  const totalSeconds = apps.reduce((sum, a) => sum + a.totalSeconds, 0);
  const totalMinutes = Math.round(totalSeconds / 60 * 10) / 10;

  return {
    date: now.toISOString().slice(0, 10),
    totalMinutes,
    totalSeconds,
    appCount: apps.length,
    apps,
  };
}

// ─── 精简摘要（省 Token）───
// 返回自然语言格式，Claude 直接读懂，不浪费 token 在 JSON 结构上
function getSummary() {
  const report = getReport();
  if (report.appCount === 0) return "📱 今天还没有记录任何 APP 使用数据。";

  const lines = [`📱 **今日屏幕时间** (${report.date})`];
  lines.push(`总使用时长: ${report.totalMinutes} 分钟，共 ${report.appCount} 个 APP`);
  lines.push("");

  for (const app of report.apps) {
    const mins = app.totalMinutes;
    const times = app.sessionCount;
    const icon = mins > 60 ? "🔴" : mins > 30 ? "🟡" : "🟢";
    lines.push(`${icon} **${app.app}**: ${mins}分钟 / ${times}次`);
  }
  return lines.join("\n");
}

// ─── 查询特定 APP ───
function queryApp(appName) {
  const report = getReport();
  const app = report.apps.find(a => a.app === appName);
  if (!app) return { app: appName, found: false, message: `今天还没用过 ${appName}` };
  return {
    app: appName,
    found: true,
    sessions: app.sessionCount,
    totalMinutes: app.totalMinutes,
    details: app.sessions,
  };
}

// ─── 启动时加载数据 ───
await load();

export { toggle, getReport, queryApp, cleanup, getSummary };
