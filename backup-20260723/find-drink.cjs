// React fiber 提交订单
const http=require("http"),WebSocket=require("ws"),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
const tabs=await new Promise(r=>{http.get("http://127.0.0.1:9222/json",res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>r(JSON.parse(d)));});});
const mt=tabs.find(t=>t.url.includes("preview")||(t.url.includes("meituan")&&!t.url.includes("menu")));
const ws=new WebSocket(mt.webSocketDebuggerUrl);
await new Promise(r=>ws.on("open",r));
const pm=new Map();let c=0;
ws.on("message",d=>{try{const m=JSON.parse(d.toString());if(m.id&&pm.has(m.id)){const r=pm.get(m.id);pm.delete(m.id);m.error?r.reject(new Error(m.error.message)):r.resolve(m.result);}}catch{}});
const send=(m,p)=>new Promise((resolve,reject)=>{const id=++c;pm.set(id,{resolve,reject});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pm.has(id)){pm.delete(id);reject(new Error("timeout"));}},20000);});
await send("Runtime.enable");
const E=async(expr)=>{const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true});return r?.result?.value||"";};

// 滚到底
await E("window.scrollTo(0,document.body.scrollHeight)");
await sleep(800);

// Fiber onClick 提交
const r=await E(`(function(){
  var btn=document.querySelector("button.submit_QDYt9D");
  if(!btn)return"no_btn";
  var node=btn;
  for(var j=0;j<5;j++){
    var fk=Object.keys(node).find(function(k){return k.includes("Fiber")||k.includes("InternalInstance");});
    if(fk&&node[fk]&&node[fk].memoizedProps){
      var mp=node[fk].memoizedProps;
      var hk=Object.keys(mp).find(function(k){return k.startsWith("on")&&typeof mp[k]==="function";});
      if(hk){mp[hk]({preventDefault:function(){},stopPropagation:function(){}});return"fired:"+hk+"@"+j;}
    }
    node=node.parentElement;if(!node||node===document.body)break;
  }
  // 兜底：click
  btn.click();
  return"fallback_click";
})()`);
console.log("提交:",r);
await sleep(5000);

const url=await E("location.href");
console.log("URL:",url);
if(url.includes("pay")||url.includes("order")||url.includes("success")){
  console.log("✅ 下单成功！找付款链接...");
  const links=await E(`(function(){var as=document.querySelectorAll("a");var r=[];for(var i=0;i<as.length;i++){if(as[i].href&&(as[i].href.includes("pay")||as[i].href.includes("cashier")))r.push(as[i].href);}return JSON.stringify(r);})()`);
  console.log("付款链接:",links);
}

const text=await E("document.body?.innerText?.slice(0,300)||''");
console.log(text.replace(/\n/g,"↵"));

ws.close();
})();
