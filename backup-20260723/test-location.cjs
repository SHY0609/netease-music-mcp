// 改定位到默认地址
const http=require("http"),WebSocket=require("ws"),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
const tabs=await new Promise(r=>{http.get("http://127.0.0.1:9222/json",res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>r(JSON.parse(d)));});});
let mt=tabs.find(t=>t.url&&t.url.includes("mindex/home"))||tabs.find(t=>t.url&&t.url.includes("meituan")&&!t.url.includes("163"));
if(!mt){console.log("no tab");return;}
console.log("tab:",mt.url.slice(0,80));

const ws=new WebSocket(mt.webSocketDebuggerUrl);
await new Promise(r=>ws.on("open",r));
const pm=new Map();let c=0;
ws.on("message",d=>{try{const m=JSON.parse(d.toString());if(m.id&&pm.has(m.id)){const r=pm.get(m.id);pm.delete(m.id);m.error?r.reject(new Error(m.error.message)):r.resolve(m.result);}}catch{}});
const send=(m,p)=>new Promise((resolve,reject)=>{const id=++c;pm.set(id,{resolve,reject});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pm.has(id)){pm.delete(id);reject(new Error("timeout"));}},20000);});
await send("Runtime.enable");await send("Page.enable");
const E=async(expr)=>{const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true});return r?.result?.value||"";};

// 回首页
let url=await E("location.href");
if(!url.includes("mindex/home")){await send("Page.navigate",{url:"https://h5.waimai.meituan.com/waimai/mindex/home"});await sleep(4000);}

// 读当前定位
let cur=await E(`(function(){var t=document.body?.innerText||"";var m=t.match(/黎先|老百姓|赤虎堂|钱小匠/);return m?m[0]:"?";})()`);
console.log("当前定位:",cur);

// 如果不是黎先，点地址 → 直接点默认地址
if(!cur.includes("黎先")){
  console.log("切换...");
  // 点地址栏
  await E(`(function(){var el=document.querySelector("[class*=addr]");if(el)el.click();})()`);
  await sleep(2000);

  // 直接点列表里的默认地址
  const lx=JSON.parse(await E(`(function(){
    var all=document.querySelectorAll("*");
    for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;
      var t=(all[i].textContent||"").trim();
      if(t.includes("默认地址")&&t.length<20&&all[i].children.length<=2){
        var r=all[i].getBoundingClientRect();if(r.y>50)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
      }
    }return"{}";
  })()`));
  if(lx.x){
    await send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:lx.x,y:lx.y}]});
    await sleep(200);await send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[{x:lx.x,y:lx.y}]});
    await sleep(2000);
    cur=await E(`(function(){var m=(document.body?.innerText||"").match(/黎先/);return m?m[0]:"?";})()`);
    console.log("切换后:",cur);
  }
}

ws.close();
console.log("=== DONE ===");
})();
