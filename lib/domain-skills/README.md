# Domain Skills — 对标 Browser-Use domain-skills/

每个 JSON 文件记录一个网站/功能的已知交互模式。
当抖音/美团改版时，只需更新对应文件，不用在全量源码里找位置。

## 文件索引

| 文件 | 领域 | 说明 |
|------|------|------|
| `cdp-infra.json` | 共享基础设施 | Chromium启动、CDP连接、Crash Watchdog、DOM等待 |
| `douyin-search.json` | 抖音搜索 | SPA搜索框输入→结果解析→轻量序列化fallback |
| `douyin-comment.json` | 抖音评论 | VNC+CDP hybrid、Draft.js编辑器、发送按钮定位 |
| `douyin-user.json` | 抖音用户 | '我的'/关注列表/CDP鼠标导航 |
| `meituan-order.json` | 美团外卖 | Cookie注入、地址选择、搜索/菜单/下单全流程 |

## 使用方式

1. **改版时**：先看对应 JSON 的 `steps` → 对照实际页面DOM → 更新 selector
2. **加新平台**：复制 `meituan-order.json` 为模板 → 填自己的步骤
3. **调试**：每个 JSON 的 `pitfalls` 记录了历史踩坑，省得重踩
