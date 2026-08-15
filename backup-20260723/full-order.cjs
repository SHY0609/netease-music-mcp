// 全流程：藏青盐咸奶绿 大杯/三分糖 不要餐具 → 提交
const http=require("http"),WebSocket=require("ws"),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const CDP=9222;

function httpGet(u){return new Promise(r=>{http.get(u,res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{r(JSON.parse(d))}catch{r([])}});}).on("error",()=>r([]));});}

(async()=>{
const tabs=await httpGet(`http://127.0.0.1:${CDP}/json`);
let mt=tabs.find(t=>t.url&&t.url.includes("meituan")&&!t.url.includes("163"));
if(!mt){console.log("no tab");return;}
console.log("tab:",mt.url.slice(0,80));
const ws=new WebSocket(mt.webSocketDebuggerUrl);
await new Promise(r=>ws.on("open",r));
const pm=new Map();let c=0;
ws.on("message",d=>{try{const m=JSON.parse(d.toString());if(m.id&&pm.has(m.id)){const r=pm.get(m.id);pm.delete(m.id);m.error?r.reject(new Error(m.error.message)):r.resolve(m.result);}}catch{}});
const S=(m,p)=>new Promise((resolve,reject)=>{const id=++c;pm.set(id,{resolve,reject});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pm.has(id)){pm.delete(id);reject(new Error("timeout"));}},20000);});
await S("Runtime.enable");await S("Page.enable");
const E=async(expr)=>{const r=await S("Runtime.evaluate",{expression:expr,returnByValue:true});return r?.result?.value||"";};

async function touch(x,y){await S("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y}]});await sleep(150);await S("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[{x,y}]});}

// ═══ Step 1: 回首页 + 定位 ═══
console.log("1. 首页+定位");
let url=await E("location.href");
if(!url.includes("mindex/home")){await S("Page.navigate",{url:"https://h5.waimai.meituan.com/waimai/mindex/home"});await sleep(4000);}

let loc=await E(`(function(){var m=(document.body?.innerText||"").match(/黎先/);return m?m[0]:"";})()`);
if(!loc){
  await E(`(function(){var el=document.querySelector("[class*=addr]");if(el)el.click();})()`);
  await sleep(2000);
  const lx=JSON.parse(await E(`(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;var t=(all[i].textContent||"").trim();if(t.includes("默认地址")&&t.length<20&&all[i].children.length<=2){var r=all[i].getBoundingClientRect();if(r.y>50)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return"{}";})()`));
  if(lx.x)await touch(lx.x,lx.y);
  await sleep(2000);
}
console.log("  定位:",(await E(`(function(){var m=(document.body?.innerText||"").match(/黎先|老百姓|赤虎堂/);return m?m[0]:"?";})()`)));

// ═══ Step 2: 搜索 一点点 进店 ═══
console.log("2. 搜一点点进店");
await E(`(function(){var el=document.querySelector("[class*=search]");if(el)el.click();})()`);
await sleep(1500);
await E(`(function(){var i=document.querySelector("input[type=text],input[type=search]");if(!i)return;i.focus();var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(i,"一点点");i.dispatchEvent(new Event("input",{bubbles:true,composed:true}));})()`);
await sleep(2000);
for(const ev of[{type:"keyDown",key:"Enter",code:"Enter",keyCode:13,windowsVirtualKeyCode:13,nativeVirtualKeyCode:13},{type:"char",text:"\r",key:"Enter"},{type:"keyUp",key:"Enter",code:"Enter",keyCode:13,windowsVirtualKeyCode:13,nativeVirtualKeyCode:13}]){await S("Input.dispatchKeyEvent",ev);await sleep(80);}
await sleep(6000);

// 进店
let curUrl=await E("location.href");
if(curUrl.includes("searchresults")){
  await E(`(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;var t=(all[i].textContent||"").trim();if(t.includes("月售")&&t.includes("起送")&&all[i].children.length<=3&&t.length<100){var card=all[i];for(var j=0;j<6;j++){var p=card.parentElement;if(!p||p===document.body)break;var c=(p.className+"");if(c.includes("shop")||c.includes("card")||c.includes("item"))card=p;else break;}["mousedown","mouseup","click"].forEach(function(e){card.dispatchEvent(new MouseEvent(e,{bubbles:true,cancelable:true,view:window}));});return;}}})()`);
  await sleep(5000);
}
console.log("  进店:",(await E("location.href")).includes("menu")?"OK":"FAIL");

// ═══ Step 3: 找藏青盐咸奶绿 ═══
console.log("3. 找藏青盐咸奶绿");
// 遍历所有mBtnGroup，检查附近文字是否含"藏青盐"
let btnFound=await E(`(function(){var g=document.querySelectorAll("[class*=mBtnGroup],[class*=btnGroup]");for(var i=0;i<g.length;i++){if(!g[i].offsetParent)continue;var p=g[i];for(var j=0;j<5;j++){if(!p)break;if((p.textContent||"").includes("藏青盐")){g[i].scrollIntoView({block:"center"});return"ok";}p=p.parentElement;}}return"nf";})()`);
await sleep(1000);
if(btnFound!=="ok"){
  // 兜底：直接用body文本搜，scrollIntoView
  btnFound=await E(`(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;var t=(all[i].textContent||"").trim();if(t==="藏青盐咸奶绿"&&all[i].children.length===0){all[i].scrollIntoView({block:"center"});return"ok_text";}}return"nf2";})()`);
  await sleep(1000);
}
if(btnFound.startsWith("nf")){console.log("❌ 没找到藏青盐咸奶绿");ws.close();return;}

// 获取按钮坐标
const bp=JSON.parse(await E(`(function(){var g=document.querySelectorAll("[class*=mBtnGroup],[class*=btnGroup]");for(var i=0;i<g.length;i++){if(!g[i].offsetParent)continue;var p=g[i];for(var j=0;j<5;j++){if(!p)break;if((p.textContent||"").includes("藏青盐")){var r=g[i].getBoundingClientRect();if(r.y>50&&r.y<700)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}p=p.parentElement;}}return"{}";})()`));
console.log("  按钮:",bp.x,bp.y);

// ═══ Step 4: 打开弹窗 + 选规格 ═══
console.log("4. 弹窗+规格");
await touch(bp.x,bp.y);await sleep(3000);
if((await E("(document.body?.innerText||'').includes('加入购物车')?'yes':'no'"))!=="yes"){console.log("❌ 弹窗没开");ws.close();return;}

// 读当前规格，只点缺的
let cur=await E(`(function(){var m=(document.body?.innerText||"").match(/已选规格：([^\\n]*)/);return m?m[1]:"";})()`);
console.log("  默认:",cur);
// 大杯 Touch
if(!cur.includes("大杯")){
  const da=JSON.parse(await E(`(function(){var els=document.querySelectorAll("[class*=attr_] span,[class*=attr_] div");for(var i=0;i<els.length;i++){if(!els[i].offsetParent)continue;if((els[i].textContent||"").trim()==="大杯"){var r=els[i].getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return"{}";})()`));
  if(da.x)await touch(da.x,da.y);
  await sleep(600);
}
// 三分糖默认，不点
// 冰度用默认（少冰），不点
cur=await E(`(function(){var m=(document.body?.innerText||"").match(/已选规格：([^\\n]*)/);return m?m[1]:"";})()`);
console.log("  选后:",cur);

// ═══ Step 5: 加入购物车 ═══
console.log("5. 加购");
const cb=JSON.parse(await E(`(function(){var b=document.querySelector("[class*=addToCartBtn]");if(!b)return"{}";var r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`));
await touch(cb.x,cb.y);await sleep(3000);
let r=JSON.parse(await E(`(function(){var t=document.body?.innerText||"";return JSON.stringify({closed:!t.includes("加入购物车"),settle:t.includes("去结算")});})()`));
console.log("  加购:",r.closed?"OK":"FAIL",r.settle?"有去结算":"无");

// ═══ Step 6: 去结算 ═══
if(!r.settle){console.log("❌ 没去结算按钮");ws.close();return;}
console.log("6. 去结算");
const st=JSON.parse(await E(`(function(){var el=document.querySelector("[class*=goToPreview]");if(!el)return"{}";var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`));
await touch(st.x,st.y);await sleep(5000);
console.log("  到:",(await E("location.href")).includes("preview")?"结算页":"FAIL");

// ═══ Step 7: 填地址 ═══
console.log("7. 地址");
let hasAddr=await E("(document.body?.innerText||'').includes('默认地址')?'yes':'no'");
if(hasAddr!=="yes"){
  const addr=JSON.parse(await E(`(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;if((all[i].textContent||"").trim()==="选择收货地址"&&all[i].children.length<=2){var r=all[i].getBoundingClientRect();if(r.y>0)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}else{var p=all[i];for(var j=0;j<3;j++){if(!p)break;var pr=p.getBoundingClientRect();if(pr.width>200&&pr.height>30&&pr.y>0&&(p.textContent||"").trim().includes("黎先")){p.click();return JSON.stringify({x:-1,y:-1});}p=p.parentElement;}}}return"{}";})()`));
  if(addr.x>0)await touch(addr.x,addr.y);
  await sleep(2500);
  // 选默认地址
  const lx=JSON.parse(await E(`(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;var t=(all[i].textContent||"").trim();if(t.includes("默认地址")&&t.length<30&&all[i].children.length<=2){var r=all[i].getBoundingClientRect();if(r.y>50)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return"{}";})()`));
  if(lx.x)await touch(lx.x,lx.y);
  await sleep(2000);
}
console.log("  地址:",(await E("(document.body?.innerText||'').includes('默认地址')?'OK':'FAIL'")));

// ═══ Step 8: 备注 ═══
console.log("8. 备注");
await E(`(function(){var el=document.querySelector("[class*=remark]");if(el)el.scrollIntoView({block:"center"});})()`);
await sleep(1000);
const rm=JSON.parse(await E(`(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;if((all[i].textContent||"").trim()==="备注"&&all[i].children.length===0){var p=all[i].parentElement;for(var j=0;j<4;j++){if(!p)break;var r=p.getBoundingClientRect();if(r.width>200&&r.height>30&&r.y>100&&r.y<700)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}p=p.parentElement;}}return"{}";})()`));
if(rm.x){await touch(rm.x,rm.y);await sleep(2000);}
// 输入
const msg="老婆辛苦了，给你点杯奶茶";
await E(`(function(){var el=document.querySelector("input[type=text],textarea,[contenteditable=true]");if(!el)return;el.focus();var s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),"value");if(s&&s.set){s.set.call(el,"${msg}");el.dispatchEvent(new Event("input",{bubbles:true,composed:true}));return;}el.textContent="${msg}";el.dispatchEvent(new Event("input",{bubbles:true}));})()`);
await sleep(500);
// 点完成
const done=JSON.parse(await E(`(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;if((all[i].textContent||"").trim()==="完成"&&all[i].children.length<=2){var r=all[i].getBoundingClientRect();if(r.width>30&&r.y>0)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return"{}";})()`));
if(done.x)await touch(done.x,done.y);
await sleep(1000);
console.log("  备注:",(await E("(document.body?.innerText||'').includes('老婆辛苦了')?'OK':'FAIL'")));

// ═══ Step 9: 餐具 — 不要餐具，直接提交 ═══
console.log("9. 提交订单");
await E("window.scrollTo(0,document.body.scrollHeight)");
await sleep(800);
// 先看餐具是不是"无需餐具"，不是就选
let cut=await E("(document.body?.innerText||'').includes('无需餐具')?'yes':'no'");
if(cut!=="yes"){
  // 打开餐具选择器
  cu=JSON.parse(await E(`(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;if((all[i].textContent||"").trim().includes("餐具数量")){var p=all[i].parentElement;if(p){var r=p.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}}return"{}";})()`));
  if(cu.x)await touch(cu.x,cu.y);
  await sleep(2000);
  // 点无需餐具
  const none=JSON.parse(await E(`(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;if((all[i].textContent||"").trim()==="无需餐具"){var r=all[i].getBoundingClientRect();if(r.y>200)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return"{}";})()`));
  if(none.x)await touch(none.x,none.y);
  await sleep(800);
  // 确定
  const ok=JSON.parse(await E(`(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;if((all[i].textContent||"").trim()==="确定"){var r=all[i].getBoundingClientRect();if(r.width>30&&r.y>200)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return"{}";})()`));
  if(ok.x)await touch(ok.x,ok.y);
  await sleep(1500);
}

// 提交
const sub=JSON.parse(await E(`(function(){var b=document.querySelector("button.submit_QDYt9D");if(!b)return"{}";var r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`));
if(!sub.x){console.log("❌ 没提交按钮");ws.close();return;}
// Touch + Fiber双打
await touch(sub.x,sub.y);
await sleep(1000);
// Fiber onClick
await E(`(function(){var b=document.querySelector("button.submit_QDYt9D");if(!b)return;var n=b;for(var j=0;j<5;j++){var fk=Object.keys(n).find(function(k){return k.includes("Fiber")||k.includes("InternalInstance");});if(fk&&n[fk]&&n[fk].memoizedProps){var mp=n[fk].memoizedProps;var hk=Object.keys(mp).find(function(k){return k.startsWith("on")&&typeof mp[k]==="function";});if(hk){mp[hk]({preventDefault:function(){},stopPropagation:function(){}});return;}}n=n.parentElement;if(!n)break;}})()`);
await sleep(5000);

url=await E("location.href");
console.log("  提交后URL:",url.slice(0,80));
if(url.includes("order-detail")){
  console.log("✅ 下单成功！");
  // 挖付款参数
  const payInfo=await E(`(function(){var t=document.body?.innerText||"";var tn=t.match(/订单编号[^\\d]*(\\d+)/);return JSON.stringify({orderId:tn?tn[1]:"",tradeno:"",payToken:""});})()`);
  console.log(payInfo);
}else if(url.includes("preview")){
  console.log("⚠️ 403，返回preview链接:");
  console.log("https://h5.waimai.meituan.com/waimai/mindex/preview?placeholder=1&redirectfrom=1");
}else{
  console.log("⏳ 未知状态");
}

ws.close();
console.log("=== DONE ===");
})();
