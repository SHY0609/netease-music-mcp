// 从order-detail挖付款链接
const http=require("http"),WebSocket=require("ws");
(async()=>{
const tabs=await new Promise(r=>{http.get("http://127.0.0.1:9222/json",res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>r(JSON.parse(d)));});});
const mt=tabs.find(t=>t.url&&t.url.includes("order-detail"));
if(!mt){console.log("no order tab");return;}
const ws=new WebSocket(mt.webSocketDebuggerUrl);
await new Promise(r=>ws.on("open",r));
const pm=new Map();let c=0;
ws.on("message",d=>{try{const m=JSON.parse(d.toString());if(m.id&&pm.has(m.id)){const r=pm.get(m.id);pm.delete(m.id);m.error?r.reject(new Error(m.error.message)):r.resolve(m.result);}}catch{}});
const send=(m,p)=>new Promise((resolve,reject)=>{const id=++c;pm.set(id,{resolve,reject});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pm.has(id)){pm.delete(id);reject(new Error("timeout"));}},10000);});
await send("Runtime.enable");
const E=async(expr)=>{const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true});return r?.result?.value||"";};

// 搜页面HTML里的mpay链接
const html=await E("document.body.innerHTML.slice(0,5000)");
const mpayMatch=html.match(/mpay[^"'\s]{0,300}/g);
console.log("mpay片段:",mpayMatch?mpayMatch.join("\n---\n"):"无");

// 搜所有包含tradeno的文本
const scripts=await E(`(function(){
  var ss=document.querySelectorAll("script");var r=[];
  for(var i=0;i<ss.length;i++){var t=ss[i].textContent||"";if(t.includes("tradeno"))r.push(t.slice(0,500));}
  return r.join("\\n---\\n").slice(0,3000)||"无";
})()`);
console.log("scripts含tradeno:",scripts.slice(0,500));

// 搜window.__INITIAL_STATE__ 等
const state=await E(`(function(){
  var keys=Object.keys(window).filter(function(k){return k.includes("state")||k.includes("pay")||k.includes("order");});
  return JSON.stringify(keys.slice(0,20));
})()`);
console.log("window keys:",state);

ws.close();
})();
