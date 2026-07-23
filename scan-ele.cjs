// 点vy=155加另一个奶茶
const h=require("http"),W=require("ws"),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
const tabs=await new Promise(r=>{h.get("http://127.0.0.1:9222/json",res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>r(JSON.parse(d)));});});
const t=tabs.find(t=>t.url&&t.url.includes("takeout"));
if(!t){console.log("no");return;}
const ws=new W(t.webSocketDebuggerUrl);await new Promise(r=>ws.on("open",r));
const pm=new Map();let c=0;
ws.on("message",d=>{try{const m=JSON.parse(d.toString());if(m.id&&pm.has(m.id)){const r=pm.get(m.id);pm.delete(m.id);m.error?r.reject(new Error(m.error.message)):r.resolve(m.result);}}catch{}});
const S=(m,p)=>new Promise((rr,rj)=>{const id=++c;pm.set(id,{resolve:rr,reject:rj});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pm.has(id)){pm.delete(id);rj(new Error("t"));}},20000);});
await S("Runtime.enable");
const E=async(expr)=>{const r=await S("Runtime.evaluate",{expression:expr,returnByValue:true});return r?.result?.value||"";};
const touch=async(x,y)=>{if(!x||!y)return;await S("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y}]});await sleep(150);await S("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[{x,y}]});};

// 点vy=155的btn_select_spec
await E("window.scrollTo(0,1500);var el=document.querySelector('[class*=mor-comp-page-content]');if(el)el.scrollTop=1500;");
await sleep(1000);

const btn=await E(`(function(){var all=document.querySelectorAll("[class*=btn_select_spec]");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;var r=all[i].getBoundingClientRect();if(r.y>100&&r.y<300)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}return"{}";})()`);
console.log("btn:"+btn);
if(btn==="{}"){ws.close();return;}
const bp=JSON.parse(btn);
await touch(bp.x,bp.y);await sleep(4000);

let popup=await E("(document.body?.innerText||'').includes('加入购物车')?'yes':'no'");
console.log("弹窗:"+popup);
if(popup==="yes"){
  // 大杯
  const da=await E(`(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;if((all[i].textContent||"").trim()==="大杯"){var r=all[i].getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return"{}";})()`);
  if(da!=="{}"){const p=JSON.parse(da);await touch(p.x,p.y);await sleep(600);console.log("大杯");}
  // 滚弹窗
  await E('(function(){var el=document.querySelector("[class*=sku--body]");if(el)el.scrollTop=700;})()');
  await sleep(1000);
  // 波霸
  const boba=await E(`(function(){var all=document.querySelectorAll("[class*=sku-option__root]");for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;if((all[i].textContent||"").includes("波霸")){var r=all[i].getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}return"{}";})()`);
  if(boba!=="{}"){const p=JSON.parse(boba);await touch(p.x,p.y);await sleep(400);console.log("波霸");}
  // 加购
  const cart=await E(`(function(){var el=document.querySelector("[class*=sku__button]");if(!el)return"{}";var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`);
  if(cart!=="{}"){const p=JSON.parse(cart);await touch(p.x,p.y);await sleep(3000);console.log("加购OK");}
}
console.log("去结算:"+(await E("document.body?.innerText?.includes('去结算')?'yes':'no'")));

// 去结算
const st=await E("(document.body?.innerText||'').includes('去结算')?'yes':'no'");
if(st==="yes"){
  const settle=await E(`(function(){var el=document.querySelector("[class*=cart__settle]");if(!el)return"{}";var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`);
  if(settle!=="{}"){const p=JSON.parse(settle);await touch(p.x,p.y);await sleep(5000);
    console.log("结算页:"+((await E("location.href")).includes("checkout")?"OK":"FAIL"));
  }
}
ws.close();
})();
