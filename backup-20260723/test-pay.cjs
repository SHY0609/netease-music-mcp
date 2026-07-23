// 点立即支付 → 抓付款链接
const http=require("http"),WebSocket=require("ws"),sleep=ms=>new Promise(r=>setTimeout(r,ms));

function httpGet(url){return new Promise(r=>{http.get(url,res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{r(JSON.parse(d))}catch{r([])}});}).on("error",()=>r([]));});}

(async()=>{
// 1. 连接 order-detail 页
const tabs=await httpGet("http://127.0.0.1:9222/json");
const orderTab=tabs.find(t=>t.url&&t.url.includes("order-detail"));
if(!orderTab){console.log("❌ 没有order-detail页");return;}
console.log("订单页:",orderTab.url.slice(0,80));

const ws=new WebSocket(orderTab.webSocketDebuggerUrl);
await new Promise(r=>ws.on("open",r));
const pm=new Map();let c=0;
ws.on("message",d=>{try{const m=JSON.parse(d.toString());if(m.id&&pm.has(m.id)){const r=pm.get(m.id);pm.delete(m.id);m.error?r.reject(new Error(m.error.message)):r.resolve(m.result);}}catch{}});
const send=(m,p)=>new Promise((resolve,reject)=>{const id=++c;pm.set(id,{resolve,reject});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pm.has(id)){pm.delete(id);reject(new Error("timeout"));}},15000);});
await send("Runtime.enable");
const E=async(expr)=>{const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true});return r?.result?.value||"";};

// 2. 点"立即支付"
const btn=JSON.parse(await E(`(function(){
  var all=document.querySelectorAll("*");
  for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;
    if((all[i].textContent||"").trim()==="立即支付"&&all[i].children.length===0){
      var p=all[i].parentElement;var r=p.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
    }
  }return"{}";
})()`));
console.log("立即支付:",btn.x,btn.y);

// 记录点之前的 tab 列表
const beforeTabs=new Set((await httpGet("http://127.0.0.1:9222/json")).map(t=>t.id));

// Touch 点击
await send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:btn.x,y:btn.y}]});
await sleep(200);
await send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[{x:btn.x,y:btn.y}]});

// 3. 轮询新 tab（等 mpay 出现）
console.log("等待付款页tab...");
let payUrl=null;
for(let i=0;i<20;i++){
  await sleep(1000);
  const curTabs=await httpGet("http://127.0.0.1:9222/json");
  for(const t of curTabs){
    if(!beforeTabs.has(t.id)&&t.url){
      console.log(`  新tab: ${t.url.slice(0,100)}`);
      if(t.url.includes("mpay")||t.url.includes("icashier")||t.url.includes("pay")){
        payUrl=t.url;
        console.log(`\n💰 付款链接:\n${payUrl}`);
        break;
      }
    }
  }
  if(payUrl)break;
  // 也检查当前页是否跳转了
  const curUrl=await E("location.href");
  if(curUrl.includes("mpay")){payUrl=curUrl;console.log(`\n💰 当前页跳转:\n${payUrl}`);break;}
}

if(!payUrl)console.log("❌ 没抓到付款tab，可能弹窗不是新tab");

ws.close();
})();
