// 监控用户 VNC 操作
const http=require("http"),WebSocket=require("ws"),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
const tabs=await new Promise(r=>{http.get("http://127.0.0.1:9222/json",res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>r(JSON.parse(d)));});});
const mt=tabs.find(t=>t.url.includes("meituan")&&!t.url.includes("163"));
if(!mt){console.log("no tab");return;}
console.log("监控:",mt.url.slice(0,80));

const ws=new WebSocket(mt.webSocketDebuggerUrl);
await new Promise(r=>ws.on("open",r));
const pm=new Map();let c=0;
ws.on("message",d=>{try{const m=JSON.parse(d.toString());if(m.id&&pm.has(m.id)){const r=pm.get(m.id);pm.delete(m.id);m.error?r.reject(new Error(m.error.message)):r.resolve(m.result);}}catch{}});
const send=(m,p)=>new Promise((resolve,reject)=>{const id=++c;pm.set(id,{resolve,reject});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pm.has(id)){pm.delete(id);reject(new Error("timeout"));}},10000);});
await send("Runtime.enable");
const E=async(expr)=>{const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true});return r?.result?.value||"";};

let lastUrl="";
let lastText="";
let lastLen=0;
let round=0;

console.log("开始监控，每1.5s采样，变化时打印...\n");

for(let i=0;i<80;i++){
  await sleep(1500);
  round++;

  const url=await E("location.href");
  const text=await E("document.body?.innerText?.slice(0,600)||''");
  const len=text.length;

  let changed=false;
  if(url!==lastUrl){
    console.log(`\n[${round}] 🔗 URL变化: ${url.slice(0,100)}`);
    lastUrl=url;
    changed=true;
  }

  if(len!==lastLen){
    const diff=len-lastLen;
    console.log(`[${round}] 📏 字数变化: ${lastLen} → ${len} (${diff>0?'+'+diff:diff})`);
    lastLen=len;
    changed=true;
  }

  if(text!==lastText){
    // 只打印变化的部分
    const t=text.replace(/\n/g,"↵");
    console.log(`[${round}] 📝 内容:\n  ${t.slice(0,300)}`);
    lastText=text;
    changed=true;
  }

  if(!changed&&round%5===0) process.stdout.write(".");

  // 找付款链接
  if(url.includes("pay")||url.includes("cashier")||text.includes("支付")){
    const links=await E(`(function(){var as=document.querySelectorAll("a");var r=[];for(var i=0;i<as.length;i++){if(as[i].href)r.push(as[i].href);}return JSON.stringify(r.slice(0,5));})()`);
    console.log(`\n💰 付款链接: ${links}`);
  }

  if(url!==mt.url&&!url.includes("preview")) break;
}

ws.close();
console.log("\n监控结束");
})();
