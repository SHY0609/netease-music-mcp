# 美团外卖 H5 API 逆向笔记

## 认证体系

### Cookie（从浏览器 H5 登录获取）
关键字段：
- `w_token` — 网页 token（Ag 开头）
- `mt_c_token` — 移动端 token（= w_token）
- `openh5_uuid` — 设备 ID（32 位 hex）
- `uuid` — 同 openh5_uuid
- `userId` — 用户 ID
- `WEBDFPID` — 浏览器指纹

### mtgsig 签名头
```
mtgsig: {"a1":"1.2","a2":<timestamp_ms>,"a3":"<WEBDFPID>","a5":"<encrypted_sig>","a6":"<encrypted_sig2>","a8":"<hash_32>","a9":"4.2.4,7,49","a10":"db","x0":4,"d1":"<md5?>"}
```

字段解析：
| 字段 | 值 | 说明 |
|------|-----|------|
| a1 | "1.2" | 版本 |
| a2 | 1782063450545 | 毫秒时间戳 |
| a3 | WEBDFPID | 浏览器指纹 |
| a5 | base64 | 加密签名 1 |
| a6 | base64 | 加密签名 2（主要，最长） |
| a8 | 32 hex | 某种 hash |
| a9 | "4.2.4,7,49" | 版本信息 |
| a10 | "db" | ? |
| x0 | 4 | ? |
| d1 | 32 hex | MD5 hash |

## API 端点

### 搜索建议（已验证可用）
```
POST https://i.waimai.meituan.com/openh5/search/suggestv8
Content-Type: application/x-www-form-urlencoded
Headers: mtgsig（必需）, Cookie（必需）, Origin, Referer

Body (urlencoded):
  keyword=黄焖鸡
  wm_latitude=28673167      # 原始坐标 / 1e6
  wm_longitude=115887078
  openh5_uuid=<device_id>
  uuid=<device_id>
  optimus_code=10
  optimus_risk_level=71
  geotype=2
  categorytype=0
  suggestGlobalId=<uuid>
  wm_actual_latitude / wm_actual_longitude
  wmUuidDeregistration / wmUserIdDeregistration

Response:
  { code: 0, msg: "成功", data: { suggests[] } }
```

### 待验证端点
- 搜索店铺：`/openh5/poi/filter`（可能需要不同签名）
- 地址列表：`/openh5/address/list`
- 下单：`/openh5/order/create`

## 下一步

1. 用抓到的 cookie + mtgsig 试调 suggestv8
2. 如果 mtgsig 过期，逆向浏览器 JS 中的签名生成
3. 找到 `poi/filter` 接口替换 suggestv8 用于真正搜店铺
4. 实现 _token（deflate+base64）用于 POST body 签名
