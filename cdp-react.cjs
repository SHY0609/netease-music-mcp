const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const pending = new Map(); let cid = 0;
function cmd(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await cmd('Runtime.enable');

  // Use React fiber to find Editor component and call onChange with text content
  const result = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector("[class*=DraftEditor-root]");',
      'if(!ed) return "no editor";',
      // Find React fiber key
      'var key=Object.keys(ed).find(k=>k.startsWith("__reactFiber")||k.startsWith("__reactInternalInstance"));',
      'if(!key) return "no fiber";',
      'var fiber=ed[key];',
      // Navigate fiber tree to find component with setState or EditorState
      'var depth=0; var found=[];',
      'while(fiber && depth < 30) {',
      'var sn=fiber.stateNode;',
      'if(sn && sn.props && sn.props.onChange) {',
      'found.push("L"+depth+": onChange found on "+sn.constructor?.name);',
      // Try to get current state
      'if(sn.state && sn.state.editorState) {',
      'var es=sn.state.editorState;',
      'var content=es.getCurrentContent();',
      'found.push("has EditorState, text:"+content.getPlainText().slice(0,30));',
      // Create new EditorState with our text using Modifier
      'var EditorState=es.constructor;',
      'var Modifier=es.getCurrentContent().constructor.constructor.Modifier;',
      'var SelectionState=es.getSelection().constructor;',
      'var newContent=Modifier.insertText(content, content.getSelectionAfter(), "来自CDP!");',
      'var newES=EditorState.push(es, newContent, "insert-characters");',
      'var onChange=sn.props.onChange||sn.onChange;',
      'if(onChange) { onChange(newES); found.push("onChange called!"); }',
      '}',
      'break;',
      '}',
      'fiber=fiber.child||fiber.sibling||fiber.return;',
      'if(!fiber) break;',
      'depth++;',
      '}',
      'return JSON.stringify(found);',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('React fiber:', result.result?.value);

  await new Promise(r=>setTimeout(r,2000));

  // Check if send button appeared in commentInput-right-ct
  const check = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ct=document.querySelector(".commentInput-right-ct");',
      'if(!ct) return "no right-ct";',
      'var svgs=ct.querySelectorAll("svg");',
      'var btns=[];',
      'for(var i=0;i<svgs.length;i++){',
      'var br=svgs[i].getBoundingClientRect();',
      'btns.push("SVG:"+Math.round(br.width)+"x"+Math.round(br.height)+":vis="+!!svgs[i].offsetParent);',
      '}',
      'return "right-ct SVGs:"+btns.join(",")+" html:"+ct.innerHTML.slice(0,200);',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Send container:', check.result?.value?.slice(0, 500));

  // Also check editor text
  const txt = await cmd('Runtime.evaluate', {
    expression: 'document.querySelector("[class*=DraftEditor-root]")?.textContent||"none"',
    returnByValue: true
  });
  console.log('Editor text:', txt.result?.value);

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 25000);
