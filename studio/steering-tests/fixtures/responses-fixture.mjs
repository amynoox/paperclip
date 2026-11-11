import http from 'node:http';

// The real local Codex binary talks only to this synthetic Responses endpoint.
// This is not an external model/provider call and contains no credentials.
export async function fakeResponses({hold=false,mcpCall=false}={}){
  const requests=[], pending=[];
  let sequence=0;
  const server=http.createServer((req,res)=>{
    const chunks=[];let bytes=0;
    req.on('data',data=>{bytes+=data.length;if(bytes>2*1024*1024){req.destroy();return;}chunks.push(data);});
    req.on('end',()=>{
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{body=null;}
      requests.push({method:req.method,path:req.url,body});
      if(req.method!=='POST'||req.url!=='/v1/responses'){res.writeHead(404);res.end('{}');return;}
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
      const id='resp_local_'+(++sequence),itemId='msg_local_'+sequence;
      const tools=(body.tools??[]).flatMap(t=>t.type==='namespace'?(t.tools??[]).map(v=>({...v,namespace:t.name})):t);
      const probe=tools.find(t=>/localprobe/.test(t.namespace??t.name??'')&&/ping/.test(t.name??''));
      const call=mcpCall&&probe&&!body.input?.some(x=>x.type==='function_call_output');
      const output=call?{id:itemId,type:'function_call',call_id:'call_local_mcp_1',name:probe.name,...(probe.namespace?{namespace:probe.namespace}:{}),arguments:JSON.stringify({message:'retained-native-mcp'}),status:'completed'}:
        {id:itemId,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'LOCAL STEERING FIXTURE COMPLETE',annotations:[]}]};
      const event=(type,fields)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...fields})+'\n\n');
      event('response.created',{response:{id,object:'response',status:'in_progress',output:[]}});
      const finish=()=>{
        if(res.destroyed)return;
        event('response.output_item.added',{output_index:0,item:{...output,status:'in_progress',content:[]}});
        if(call){
          event('response.function_call_arguments.delta',{item_id:itemId,output_index:0,delta:output.arguments});
          event('response.function_call_arguments.done',{item_id:itemId,output_index:0,arguments:output.arguments});
        }else{
        event('response.content_part.added',{item_id:itemId,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
        event('response.output_text.delta',{item_id:itemId,output_index:0,content_index:0,delta:output.content[0].text});
        event('response.output_text.done',{item_id:itemId,output_index:0,content_index:0,text:output.content[0].text});
        event('response.content_part.done',{item_id:itemId,output_index:0,content_index:0,part:output.content[0]});
        }
        event('response.output_item.done',{output_index:0,item:output});
        event('response.completed',{response:{id,object:'response',status:'completed',output:[output],usage:{input_tokens:40,output_tokens:8,total_tokens:48,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}});
        res.end();
      };
      if(hold)pending.push(finish);else finish();
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}/v1`;
  return {base,requests,release(){for(const fn of pending.splice(0))fn();},async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
}

export function providerArgs(base){
  if(!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(base))throw new Error('Only isolated loopback fixture is allowed');
  return ['-c','model="fixture-local"','-c','model_provider="fixture"',
    '-c','model_providers.fixture.name="Local deterministic fixture"',
    '-c',`model_providers.fixture.base_url=${JSON.stringify(base)}`,
    '-c','model_providers.fixture.wire_api="responses"','-c','model_providers.fixture.requires_openai_auth=false',
    '-c','model_providers.fixture.supports_websockets=false',
    '-c','approval_policy="never"','-c','sandbox_mode="read-only"','-c','web_search="disabled"',
    '-c','check_for_update_on_startup=false'];
}
