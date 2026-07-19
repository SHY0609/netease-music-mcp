const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const pending = new Map(); let cid = 0;
function cmd(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await cmd('Runtime.enable');

  // Get the HTML of the 4 SVG spans at y=458
  const r = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var all=document.querySelectorAll("span");',
      'var found=[];',
      'for(var i=0;i<all.length;i++){',
      'var br=all[i].getBoundingClientRect();',
      'if(all[i].offsetParent && br.y>450 && br.y<470 && br.width>30 && br.width<50 && br.x>300){',
      'found.push({x:Math.round(br.x),cls:(all[i].className||"").toString().slice(0,40),html:all[i].outerHTML.slice(0,300),parentCls:(all[i].parentElement?.className||"").toString().slice(0,40)});',
      '}',
      '}',
      'return JSON.stringify(found);',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('SVG spans:', (r.result?.value||'').slice(0, 1500));

  // Also: look at the DraftEditor's parent tree to find the send container
  const tree = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector("[class*=DraftEditor-root]");',
      'if(!ed) return "no ed";',
      'var p=ed, path=[];',
      'for(var d=0;d<8;d++){',
      'if(!p) break;',
      'var kids=[];',
      'for(var i=0;i<p.children.length;i++){',
      'var k=p.children[i],kr=k.getBoundingClientRect();',
      'kids.push(k.tagName+(kr.y>300?",y="+Math.round(kr.y):"")+(kr.width<60&&kr.width>10?",w="+Math.round(kr.width):"")+":"+(k.className||"").toString().slice(0,30));',
      '}',
      'path.push("L"+d+":"+p.tagName+"."+(p.className||"").toString().slice(0,30)+" kids["+kids.slice(0,8).join(",")+"]");',
      'p=p.parentElement;',
      '}',
      'return path.join("\\\\n");',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Editor parent tree:', tree.result?.value);

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 20000);
