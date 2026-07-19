const cdp = require("./lib/cdp-douyin.cjs");
(async () => {
  const s = await cdp.newSession(false);
  await s.send("Page.navigate", { url: "https://www.douyin.com" });
  await new Promise(r=>setTimeout(r,5000));

  // Click login button
  await s.send("Runtime.evaluate", { expression: `
    (function(){
      var all=document.querySelectorAll("*");
      for(var i=0;i<all.length;i++){
        var t=(all[i].textContent||"").replace(/\\s/g,"");
        if(t==="登录" && all[i].offsetParent){
          all[i].click();
          return "clicked " + all[i].tagName;
        }
      }
      return "not found";
    })()
  `, returnByValue: true });
  await new Promise(r=>setTimeout(r,6000));

  const ev = (expr) => s.send("Runtime.evaluate", { expression: expr, returnByValue: true }).then(r=>r?.result?.value||"");

  console.log("URL:", await ev("window.location.href"));
  console.log("Modals:", await ev(`
    (function(){
      var modals = document.querySelectorAll("[class*=modal],[class*=dialog],[class*=popup],[class*=overlay],[class*=login],[role=dialog]");
      var r = [];
      for(var i=0;i<modals.length;i++){
        if(modals[i].offsetParent) r.push(modals[i].tagName + " " + (modals[i].className||"").slice(0,80));
      }
      return r.join("|") || "none";
    })()
  `));

  console.log("Visible images:");
  console.log(await ev(`
    (function(){
      var imgs = document.querySelectorAll("img");
      var r = [];
      for(var i=0;i<imgs.length;i++){
        var s = imgs[i].src || "";
        var rect = imgs[i].getBoundingClientRect();
        if(rect.width>50 && rect.height>50 && imgs[i].offsetParent){
          r.push("w="+Math.round(rect.width)+" h="+Math.round(rect.height)+" src="+s.slice(0,150));
        }
      }
      return r.join("\\n") || "no visible images";
    })()
  `));

  // Screenshot
  const shot = await s.send("Page.captureScreenshot", { format: "png" });
  require("fs").writeFileSync("/tmp/login-modal.png", Buffer.from(shot.data, "base64"));
  console.log("Screenshot:", shot.data.length, "bytes");

  s.close();
  process.exit(0);
})();
