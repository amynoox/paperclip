const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const events=new Map(),pending=new Map();let sequence=0;
rl.on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')return send({id:m.id,result:{ok:true,supportedMethods:['getData']}});
 if(m.method==='onEvent'){events.set(m.params.event.payload.key,m.paperclipInvocation.id);return;}
 if(m.method==='getData'){
  const p=m.params.params??{};
  if(p.count)return send({id:m.id,result:events.size});
  if(p.settle)send({method:'paperclip.invocationSettled',params:{invocationId:events.get(p.settle)??p.settle}});
  const id='nested-'+(++sequence);pending.set(id,m.id);
  send({id,method:'db.query',params:{sql:'PROBE',params:[]},...(p.echo?{paperclipInvocationId:events.get(p.echo)??p.echo}:{})});
  return;
 }
 if(pending.has(m.id)){send({id:pending.get(m.id),...(m.error?{error:m.error}:{result:m.result})});pending.delete(m.id);return;}
 if(m.method==='shutdown'){send({id:m.id,result:{}});setImmediate(()=>process.exit(0));}
});
