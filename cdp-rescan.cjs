const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const pending = new Map(); let cid = 0;
function cmd(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await cmd('Runtime.enable');

  // Full scan: editor state + right container + all small icons near comment area
  const r = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var result={};',
      // Editor text
      'var ed=document.querySelector("[class*=DraftEditor-root]");',
      'result.edTxt=ed?ed.textContent.slice(0,30):"no ed";',
      'result.edY=ed?Math.round(ed.getBoundingClientRect().y):-1;',
      // Right container (commentInput-right-ct)
      'var ct=document.querySelector("[class*=commentInput][class*=right]");',
      'if(!ct) ct=document.querySelector("[class*=commentInput-right]");',
      'if(!ct && ed) ct=ed.parentElement?.parentElement?.querySelector("[class*=right]");',
      'if(ct){',
      'result.ctHTML=ct.outerHTML.slice(0,600);',
      'result.ctY=Math.round(ct.getBoundingClientRect().y);',
      'result.ctKids=ct.children.length;',
      '} else { result.ct="no right container"; }',
      // All small elements in the comment area (ed.parentElement up 3 levels)
      'if(ed){',
      'var parent3=ed.parentElement?.parentElement?.parentElement;',
      'if(parent3){',
      'var all=parent3.querySelectorAll("*");',
      'var near=[];',
      'for(var i=0;i<all.length;i++){',
      'var br=all[i].getBoundingClientRect();',
      'if(all[i].offsetParent && br.width>10 && br.width<60 && br.height>10 && br.height<60 && br.y>ed.getBoundingClientRect().y-30){',
      'near.push({tag:all[i].tagName,w:Math.round(br.width),h:Math.round(br.height),y:Math.round(br.y),x:Math.round(br.x),cls:(all[i].className||"").toString().slice(0,35)});',
      '}',
      '}',
      'result.nearBtns=near.slice(0,10);',
      '}',
      '}',
      // Also find ALL small clickable elements y>440 y<520 x>300
      'var rightSide=[];',
      'var everything=document.querySelectorAll("*");',
      'for(var j=0;j<everything.length;j++){',
      'var br=everything[j].getBoundingClientRect();',
      'if(everything[j].offsetParent && br.y>440 && br.y<520 && br.x>300 && br.width>10 && br.width<80 && br.height>10 && br.height<80){',
      'rightSide.push({tag:everything[j].tagName,x:Math.round(br.x),y:Math.round(br.y),w:Math.round(br.width),h:Math.round(br.height),cls:(everything[j].className||"").toString().slice(0,35)});',
      '}',
      '}',
      'result.rightSide=rightSide.slice(0,10);',
      'return JSON.stringify(result);',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log((r.result?.value||'').slice(0, 2000));

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 20000);
