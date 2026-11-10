import {definePlugin} from '@paperclipai/plugin-sdk';
const version=process.env.LOCAL_SCOPE_SDK??'candidate';
const {runWorker}=await import('./node_modules/@paperclipai/plugin-sdk/dist/worker-rpc-host-'+version+'.js');
const plugin=definePlugin({async setup(ctx){
 await ctx.events.on('fixture.hold',async event=>{
  await ctx.db.query('EVENT_HOLD',[event.payload?.id]);
  if(event.payload?.fail)throw Error('synthetic event failure');
 });
 ctx.data.register('probe',p=>{
  if(p.kind==='company')return ctx.agents.list({companyId:p.target});
  return ctx.db.query(p.sql??'PROBE',[]);
 });
 ctx.jobs.register('fixture-job',async job=>{
  await ctx.db.query('JOB_READ',[]);
  await ctx.db.execute('JOB_WRITE',[]);
  if(job.kind==='companies'){
   const rows=await ctx.companies.list();
   await ctx.db.query('DISCOVERY_RESULT',rows.map(row=>row.id));
  }
  if(job.kind==='state-wildcard')await ctx.state.get({scopeKind:'company',namespace:'fixture',stateKey:'key'});
  if(job.target)await ctx.agents.list({companyId:job.target});
 });
 ctx.tools.register('hold',{displayName:'Hold',description:'Synthetic local gate',parameters:{type:'object',properties:{}}},()=>ctx.db.query('AGENT_HOLD',[]));
}});
runWorker(plugin,import.meta.url);
