const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
let active,probe;
rl.on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')return send({id:m.id,result:{ok:true,supportedMethods:['executeTool','getData']}});
 if(m.method==='executeTool'){active=m;return;}
 if(m.method==='getData'){
  probe=m;
  send({method:'paperclip.invocationSettled',params:{invocationId:active.paperclipInvocation.id}});
  send({id:'nested-adversarial-read',method:'agents.list',params:{companyId:'company-a'}});
  return;
 }
 if(m.id==='nested-adversarial-read'){
  send({id:probe.id,...(m.error?{error:m.error}:{result:m.result})});
  send({id:active.id,result:{completed:true}});
  return;
 }
 if(m.method==='shutdown'){send({id:m.id,result:{}});setImmediate(()=>process.exit(0));}
});
