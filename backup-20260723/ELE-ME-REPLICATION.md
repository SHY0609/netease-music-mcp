# Ele.me 复现手册（基于美团 CDP 经验）

## 差异速查

| 维度 | 美团 | 饿了么 |
|------|------|--------|
| 框架 | React (div+css) | TIGA-VIEW (Web Components) |
| 地址选择 | Touch/MouseEvent 均可 | **CDP 不可操作 → VNC 手动** |
| 搜索触发 | CDP Enter 键 | MouseEvent 点搜索按钮 |
| 进店 | MouseEvent+view:window | **CDP Touch** |
| 加购按钮 | `btnGroup`(+) 或 `mBtnGroup`(规格) | **"选规格" 文字按钮** |
| 事件偏好 | Touch / Fiber onClick | **CDP Touch 为主** |
| 页面滚动 | window.scrollTo 正常 | **有滚动劫持，需 scrollBy 渐进** |

## 已验证步骤

### 1. 连接 Tab
```js
const tabs = await httpGet("http://127.0.0.1:9222/json");
const t = tabs.find(t => t.url.includes("ele.me") && !t.url.includes("address"));
const session = await cdpConnect(t.webSocketDebuggerUrl);
```

### 2. 地址 ← VNC 手动
CDP Touch/MouseEvent/Fiber 全试过，饿了么 amd-swipe-action 手势库拦截所有 CDP 点击。
**用户需在 VNC 中手动点击地址卡片。**

### 3. 搜索
```js
// 输入
await E(`(function(){var el=document.querySelector("input[type=text],input[type=search]");
  el.focus();el.click();var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
  s.call(el,"一点点");el.dispatchEvent(new Event("input",{bubbles:true}));})()`);
// 点搜索按钮 ← MouseEvent
await E(`(function(){var el=document.querySelector("[class*=index-search-btn]");
  ["mousedown","mouseup","click"].forEach(e=>el.dispatchEvent(new MouseEvent(e,{bubbles:true,cancelable:true,view:window})));
  el.click();})()`);
```

### 4. 进店 ← CDP Touch
```js
// 找店名元素坐标
const pos = scanForElement("1点点(萍乡润达国际店)");
// CDP Touch
await session.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:pos.x,y:pos.y}]});
await session.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[{x:pos.x,y:pos.y}]});
```

### 5. 菜单扫描 ← 一次全扫（美团同款）
```js
// 滚到顶部
await E("window.scrollTo(0,0)");
// 一次扫全页所有含 ¥ 的行 → [{text, y}]
const items = await E(`(function(){
  var all=document.querySelectorAll("*");var r=[];
  for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;
    var t=(all[i].textContent||"").trim();var rect=all[i].getBoundingClientRect();
    if(/¥\d/.test(t)&&t.length>5&&t.length<60)r.push({text:t.slice(0,50),y:Math.round(rect.y)});
  }return JSON.stringify(r);
})()`);
// 找目标
const target = items.find(i => i.text.includes("藏青盐"));
// 渐进滚动到位（非 scrollTo，避免触发回弹）
for(let step=0; step<(target.y-300)/60; step++){
  await E("window.scrollBy(0,60)"); await sleep(150);
}
```

### 6. 点"选规格" ← CDP Touch
```js
// 在目标商品附近找"选规格"按钮
const btn = await E(`(function(){
  var all=document.querySelectorAll("*");
  for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;
    var t=(all[i].textContent||"").trim();var rect=all[i].getBoundingClientRect();
    if(t==="选规格"&&rect.y>100&&rect.y<800){
      var p=all[i];for(var j=0;j<6;j++){if(!p)break;
        if((p.textContent||"").includes("TARGET_NAME"))return JSON.stringify({x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)});
      }p=p.parentElement;}
  }return"{}";
})()`);
// CDP Touch
await touch(btn.x, btn.y);
```

### 7. 规格弹窗 ← 待验证
弹窗打开后：
- 扫弹窗内选项
- Touch 选规格
- Touch "加入购物车" 或确认按钮

### 8. 结算流程 ← 待验证
同美团：去结算 → 填备注 → 选红包 → 提交

## 待验证项
- [ ] 规格弹窗的交互（TIGA-VIEW 组件，猜测 Touch 可用）
- [ ] 加购按钮的位置和 class
- [ ] 结算页的地址/备注/红包
- [ ] 饿了么是否有 403（可能不同）
