/**
 * mt-signer-v2.js — 美团 mtgsig v1.2 签名生成器
 *
 * 原理：jsdom 模拟浏览器 → 加载 webpack runtime → 加载 H5guard.js
 * → window.H5guard.sign() 生成 v1.2 格式 mtgsig
 *
 * 用法：
 *   const { getMtgsig } = require("./lib/mt-signer-v2.js");
 *   const mtgsig = await getMtgsig(url, bodyData, cookieStr);
 */

const jsdom = require("jsdom");
const { JSDOM, ResourceLoader, CookieJar } = jsdom;
const Cookie = require("cookie");
const { readFileSync } = require("fs");
const { join } = require("path");

// 兼容不同 jsdom 版本的 ScreenConfig
let ScreenConfig;
try {
  ScreenConfig = require("jsdom-browser.screen").ScreenConfig;
} catch {
  // fallback: ScreenConfig 不是必需的
}

// ── 预加载 JS 文件 ──
const RUNTIME_SRC = readFileSync(join(__dirname, "runtime.js"), "utf8");
const H5GUARD_V2_SRC = readFileSync(join(__dirname, "h5guard-v2.js"), "utf8");

// ── 单例状态 ──
let _dom = null;
let _h5guard = null;
let _initialized = false;
let _initLock = null;

/**
 * 初始化 jsdom 环境、加载 runtime + h5guard，仅执行一次
 */
async function init(cookieStr) {
  if (_initialized && _dom && _h5guard) return;
  if (_initLock) { await _initLock; if (_initialized && _dom && _h5guard) return; }
  let _rl;
  _initLock = new Promise(function(r) { _rl = r; });
  try {

  const baseUrl = "https://market.waimai.meituan.com";
  const cookieJar = new CookieJar(undefined, { allowSpecialUseDomain: true });

  // 设置 Cookie
  if (cookieStr) {
    const cks = Cookie.parse(cookieStr);
    for (const k in cks) {
      try { cookieJar.setCookie(`${k}=${cks[k]}`, baseUrl); } catch {}
    }
  }

  // 创建 jsdom
  _dom = new JSDOM("", {
    pretendToBeVisual: true,
    url: baseUrl + "/gd2/wm/4Hbymy?el_biz=waimai&",
    referrer: "https://passport.meituan.com/",
    contentType: "text/html",
    runScripts: "dangerously",
    cookieJar: cookieJar,
    resources: new ResourceLoader({
      userAgent: "Mozilla/5.0 (Linux; Android 6.0) AppleWebKit/537.36 Chrome/114.0.0.0 Mobile Safari/537.36",
    }),
  });

  const { window } = _dom;
  const { document, navigator } = window;

  // ── 环境补丁（和 mt-gh.cjs / test-runtime.js 一致） ──
  if (ScreenConfig) {
    try {
      new ScreenConfig({
        availHeight: 640, availLeft: 0, availTop: 0, availWidth: 360,
        colorDepth: 24, height: 640, pixelDepth: 24, width: 360,
        orientation: { angle: 0, type: "portrait-primary" },
      }).configure(window.screen);
    } catch {}
  }

  // 同步 setTimeout/setInterval
  try { Object.defineProperty(window, "setTimeout", { value: function() { arguments[0](); } }); } catch {}
  try { Object.defineProperty(window, "setInterval", { value: function() { arguments[0](); } }); } catch {}

  // DOM 属性
  try { Object.defineProperty(window.HTMLHtmlElement.prototype, "clientWidth", { value: 720 }); } catch {}
  try { Object.defineProperty(window.HTMLHtmlElement.prototype, "clientHeight", { value: 1056 }); } catch {}
  try { Object.defineProperty(window, "innerWidth", { value: 720 }); } catch {}
  try { Object.defineProperty(window, "innerHeight", { value: 1056 }); } catch {}
  try { Object.defineProperty(window, "devicePixelRatio", { value: 3 }); } catch {}

  // Navigator 属性
  try { Object.defineProperty(navigator, "languages", { value: ["zh-CN", "zh"] }); } catch {}
  try { Object.defineProperty(navigator, "language", { value: "zh-CN" }); } catch {}
  try { Object.defineProperty(navigator, "deviceMemory", { value: 4 }); } catch {}
  try { Object.defineProperty(navigator, "hardwareConcurrency", { value: 8 }); } catch {}
  try { Object.defineProperty(navigator, "platform", { value: "Linux aarch64" }); } catch {}
  try { Object.defineProperty(navigator, "maxTouchPoints", { value: 5 }); } catch {}
  try { Object.defineProperty(navigator, "vendor", { value: "Google Inc." }); } catch {}

  // Canvas mock（避免 getContext 崩溃）
  try {
    const HTMLCanvasElement = window.HTMLCanvasElement;
    if (HTMLCanvasElement && !HTMLCanvasElement.prototype._patched) {
      HTMLCanvasElement.prototype._patched = true;
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type) {
        if (type === "2d" || type === "webgl" || type === "experimental-webgl") {
          return mockCanvasContext();
        }
        try { return origGetContext.call(this, type); } catch { return mockCanvasContext(); }
      };
    }
  } catch {}

  // ── 加载 runtime.js（webpack chunk loader） ──
  const s1 = document.createElement("script");
  s1.textContent = RUNTIME_SRC;
  document.body.appendChild(s1);

  await sleep(100);

  // ── 加载 H5guard.js v1.2 ──
  try {
    const s2 = document.createElement("script");
    s2.textContent = H5GUARD_V2_SRC;
    document.body.appendChild(s2);
  } catch (e) {
    // H5guard.js 内部的 canvas 错误会被 catch，不影响功能
  }

  await sleep(500);

  // ── 获取 H5guard 实例 ──
  _h5guard = window.H5guard;
  if (_h5guard && typeof _h5guard.init === "function") {
    _h5guard.init({ xhrHook: false, fetchHook: false, domains: [] });
  }

  _initialized = true;
}

/**
 * 生成 mtgsig 签名
 * @param {string} url - 完整的 API URL
 * @param {string} bodyData - URL-encoded POST body
 * @param {string} cookieStr - Cookie 字符串
 * @returns {Promise<string>} mtgsig JSON 字符串（可直接用作 HTTP header）
 */
async function getMtgsig(url, bodyData, cookieStr) {
  if (!_initialized) {
    await init(cookieStr);
  }

  if (!_h5guard || typeof _h5guard.sign !== "function") {
    throw new Error("H5guard.sign not available — init may have failed");
  }

  const result = await _h5guard.sign({
    url: url,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "content-type": "application/x-www-form-urlencoded",
    },
    data: bodyData,
  });

  return result.headers?.mtgsig || "";
}

/**
 * 检查签名器是否就绪
 */
function isReady() {
  return _initialized && !!_h5guard && typeof _h5guard.sign === "function";
}

// ── 工具函数 ──

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function mockCanvasContext() {
  return {
    fillRect: () => {}, fillText: () => {}, clearRect: () => {},
    save: () => {}, restore: () => {}, scale: () => {},
    rotate: () => {}, translate: () => {}, transform: () => {},
    beginPath: () => {}, closePath: () => {}, stroke: () => {},
    fill: () => {}, clip: () => {},
    moveTo: () => {}, lineTo: () => {}, arc: () => {},
    getImageData: (x, y, w, h) => ({ data: new Uint8Array(w * h * 4) }),
    putImageData: () => {}, drawImage: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    measureText: () => ({ width: 50 }),
    // WebGL mock
    getExtension: () => null,
    createShader: () => ({}), createProgram: () => ({}),
    shaderSource: () => {}, compileShader: () => {},
    attachShader: () => {}, linkProgram: () => {},
    getShaderParameter: () => true, getProgramParameter: () => true,
    useProgram: () => {}, getAttribLocation: () => 0,
    getUniformLocation: () => ({}), enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {}, uniformMatrix4fv: () => {},
    viewport: () => {}, bindBuffer: () => {}, bufferData: () => {},
    createBuffer: () => ({}), getShaderInfoLog: () => "",
    getProgramInfoLog: () => "", getParameter: () => "WebGL",
    VERSION: "WebGL 1.0",
  };
}

module.exports = { getMtgsig, init, isReady };
