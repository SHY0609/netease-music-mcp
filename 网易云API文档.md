# 网易云音乐 MCP — API 逆向文档

> 基于 NeteaseCloudMusicApi 思路，使用旧版 API（`/api/` 端点）实现。Cookie 认证即可调用，无需 weapi 签名。

## 🔑 认证

**Cookie 获取**：浏览器登录 `music.163.com` → F12 → Application → Cookies → 全选复制为 `NETEASE_COOKIE`。

**请求头**：
```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
Referer: https://music.163.com/
Cookie: <NETEASE_COOKIE>
```

---

## 📡 API 端点

### 1. 搜索歌曲
```
GET /api/search/get?s=<关键词>&type=1&limit=8
```
返回 `result.songs[]`，字段：`id, name, artists[].name, album.name, album.picUrl, duration`

### 2. 获取播放链接（4 级回退）
```
① /api/song/enhance/player/url?ids=[<id>]&br=320000     → data[0].url
② /api/song/enhance/player/url?ids=[<id>]&br=128000     → 低音质兜底
③ /api/song/enhance/player/url/v1?ids=[<id>]&level=standard&encodeType=mp3
④ /song/media/outer/url?id=<id>                          → 外链（免登入）
```
优先 320kbps，逐级退化到外链。

### 3. 获取歌词
```
GET /api/song/lyric?id=<id>&lv=1&tv=1
```
返回 `lrc.lyric`（原文）和 `tlyric.lyric`（翻译）。

### 4. 用户歌单
```
GET /api/user/playlist?uid=0&limit=50&offset=0
```
返回 `playlist[]`，字段：`id, name, trackCount`。

### 5. 歌单详情
```
GET /api/v6/playlist/detail?id=<id>&n=200&s=<offset>
```
返回 `playlist.tracks[]`（完整歌曲对象）或 `playlist.trackIds[]`（仅 ID）。若仅有 trackIds，再用第 6 条接口补全详情。

### 6. 歌曲详情（批量）
```
GET /api/v3/song/detail?c=[{"id":<num>},{"id":<num>}]
```
返回 `songs[]`，字段：`id, name, ar[].name, al.name, al.picUrl, dt`。

### 7. 添加到歌单
```
POST /api/playlist/manipulate/tracks
Content-Type: application/x-www-form-urlencoded

op=add&pid=<歌单ID>&trackIds=[<歌曲ID>]
```
⚠️ `trackIds` 必须是 JSON 数组格式 `[123456]`，不能直接传数字。

---

## 🎨 封面提取逻辑（extractCover）

按优先级尝试 4 种方式：

| 方式 | 来源 | 示例 |
|------|------|------|
| 直接 picUrl | `s.album.picUrl` 或 `s.al.picUrl` | 直接用 |
| picId + picStr 拼接 | `al.pic` + `al.pic_str` | `https://p2.music.126.net/<picStr>/<picId>.jpg` |
| 仅 picId | `al.picId` | `https://p2.music.126.net/<picId>.jpg` |
| 空 | 无 | 播放器用 SVG 占位 |

---

## 🎧 播放器架构

### 前端（浏览器）
- **localQueue**：播放器自己管队列，存在 localStorage
- **render()**：只在 `!currentId` 时自动播放第一首，不覆盖当前歌
- **mcpSwitch**：服务器 `mcpSetAt > local lastMcp` 且歌不同 → 切换
- **轮询**：每 2 秒 `GET /api/state`，每 3 秒 `POST /api/time` 同步状态

### 后端（Vercel）
- `getPlayer()` 从 `/tmp/` 文件恢复状态
- `mcpTouch()` 标记 MCP 写入时间戳
- `mergeFromPlayer()` 6 秒内不覆盖 MCP 设置的歌
- `saveState()` 写入 `/tmp/` 文件

### Vercel 配置
```json
{
  "functions": { "api/index.js": { "regions": ["hkg1"] } },
  "rewrites": [{ "source": "/(.*)", "destination": "/api/index" }]
}
```
香港单区域 → 低流量单实例 → 减少状态不一致。

---

## 🔐 weapi 加密（lib/netease.js）

> ⚠️ Vercel 美国 IP 被封，weapi 不可用。需部署到亚洲服务器。

```
weapi(data):
  1. 生成随机 secKey（16 位 hex）
  2. AES-128-CBC 加密 data（先 PRESET_KEY，再 secKey）
  3. RSA 加密 reversed secKey
  4. 返回 params=<base64> & encSecKey=<hex>
```

端点示例：
- 搜索：`/weapi/cloudsearch/get/web`
- 歌曲 URL：`/weapi/song/enhance/player/url/v1`
- 歌单：`/weapi/user/playlist`

---

## 🛠️ 调试端点

| 端点 | 用途 |
|------|------|
| `GET /api/debug` | 全 API 测试（搜索、歌单、URL、add） |
| `GET /api/debug?addPid=X&addSid=Y` | add_to_playlist 详细诊断 |
| `GET /api/ping` | 版本/部署验证 |
| `GET /api/state` | 当前播放状态 |
| `POST /api/clear` | 清空服务器状态 |

---

## ⚠️ 踩坑记录

1. **add_to_playlist trackIds 格式**：必须是 `[songId]` JSON 数组，直接传数字或逗号分隔都报错
2. **前端 JS 花括号**：渲染函数多一个 `}` 整个播放器白屏
3. **手机 Safari 缓存**：HTTP header 无效，用 `/?v=X.X.X` 版本 URL 绕过
4. **Vercel 多实例**：`/tmp/` 不共享，用香港单区域缓解
5. **封面为空**：搜索 API 有时不返 picUrl，需要 picId+picStr 手动拼接
