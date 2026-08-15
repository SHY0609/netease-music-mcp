// 仅修备注
const http=require("http"),WebSocket=require("ws"),sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
const tabs=await new Promise(r=>{http.get("http://127.0.0.1:9222/json",res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>r(JSON.parse(d)));});});
const mt=tabs.find(t=>t.url.includes("preview"));
if(!mt){console.log("no tab");return;}
const ws=new WebSocket(mt.webSocketDebuggerUrl);await new Promise(r=>ws.on("open",r));
const pm=new Map();let c=0;
ws.on("message",d=>{try{const m=JSON.parse(d.toString());if(m.id&&pm.has(m.id)){const r=pm.get(m.id);pm.delete(m.id);m.error?r.reject(new Error(m.error.message)):r.resolve(m.result);}}catch{}});
const S=(m,p)=>new Promise((resolve,reject)=>{const id=++c;pm.set(id,{resolve,reject});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pm.has(id)){pm.delete(id);reject(new Error("timeout"));}},20000);});
await S("Runtime.enable");
const E=async(expr)=>{const r=await S("Runtime.evaluate",{expression:expr,returnByValue:true});return r?.result?.value||"";};
const touch=async(x,y)=>{await S("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y}]});await sleep(150);await S("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[{x,y}]});};

// 先看当前备注状态
console.log("当前备注:",(await E("(document.body?.innerText||'').match(/备注[^\\n]*/)?.[0]||'未找到'")));

// 找备注行 — 放宽条件
console.log("找备注行...");
// 先滚到备注区域
await E(`(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){if((all[i].textContent||"").trim()==="备注"){all[i].scrollIntoView({block:"center"});return;}}})()`);
await sleep(1000);

// 扫描附近元素
const near=await E(`(function(){
  var all=document.querySelectorAll("*");var r=[];
  for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;
    var t=(all[i].textContent||"").trim();var rect=all[i].getBoundingClientRect();
    if(rect.y>100&&rect.y<700&&(t.includes("备注")||t.includes("老婆")||t.includes("口味"))&&t.length<50)
      r.push({text:t.slice(0,40),x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2),w:Math.round(rect.width),h:Math.round(rect.height),tag:all[i].tagName,cls:(all[i].className+"").slice(0,30)});
  }
  return JSON.stringify(r,null,2);
})()`);
console.log(near);

// 点备注行（不限y>100）
const rm=JSON.parse(await E(`(function(){
  var all=document.querySelectorAll("*");
  for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;
    if((all[i].textContent||"").trim()==="备注"&&all[i].children.length===0){
      var p=all[i].parentElement;
      for(var j=0;j<4;j++){if(!p)break;
        var r=p.getBoundingClientRect();
        if(r.width>200&&r.height>25)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height),level:j});
        p=p.parentElement;
      }
    }
  }return"{}";
})()`));
console.log("备注行:",rm.x,rm.y,rm.w+"x"+rm.h,"level="+rm.level);
if(rm.x)await touch(rm.x,rm.y);await sleep(2000);

// 找输入框
let inp=await E("!!document.querySelector('input[type=text],textarea,[contenteditable=true]')?'yes':'no'");
console.log("输入框:",inp);

if(inp==="yes"){
  await E(`(function(){var el=document.querySelector("input[type=text],textarea,[contenteditable=true]");if(!el)return;el.focus();var s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),"value");if(s&&s.set){s.set.call(el,"老婆辛苦了，给你点杯奶茶");el.dispatchEvent(new Event("input",{bubbles:true,composed:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return;}el.textContent="老婆辛苦了，给你点杯奶茶";el.dispatchEvent(new Event("input",{bubbles:true}));})()`);
  await sleep(500);
  console.log("输入结果:",(await E(`(function(){var el=document.querySelector("input[type=text],textarea,[contenteditable=true]");return el?(el.value||el.textContent||"null")+"":'no_el';})()`)).slice(0,30));

  // 找完成
  const done=JSON.parse(await E(`(function(){
    var all=document.querySelectorAll("*");
    for(var i=0;i<all.length;i++){if(!all[i].offsetParent)continue;
      if((all[i].textContent||"").trim()==="完成"){var r=all[i].getBoundingClientRect();if(r.width>30)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}
    }return"{}";
  })()`));
  console.log("完成:",done.x,done.y);
  if(done.x)await touch(done.x,done.y);await sleep(1000);
}

console.log("最终:",(await E("(document.body?.innerText||'').includes('老婆辛苦了')?'OK':'FAIL'")));
ws.close();
})();
