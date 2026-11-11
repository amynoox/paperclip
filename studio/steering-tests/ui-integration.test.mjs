import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const uiDeps=path.resolve(process.env.STUDIO_UI_DEPS??path.join(here,'../../../steering-ui-deps'));
const require=createRequire(path.join(uiDeps,'package.json'));
const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/',pretendToBeVisual:true});
for(const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','Event','MouseEvent','getComputedStyle']){
  Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:dom.window[key]});
}
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{act}=React,{createRoot}=require('react-dom/client');
const {TaskChatQueuedMessages}=await import('./.generated/queued-messages-ui.mjs');
after(()=>dom.window.close());

const entry=(id='message-1',body='Adjust the current task')=>({comment:{id,body},position:0,canEdit:true,canDiscard:true});
const queue=(extra={})=>({queueId:'queue-1',revision:'revision-1',state:'pending',targetRunId:'run-1',protocol:'adapter_interactive_v1',steeringDisposition:'available',entries:[entry()],...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function mount(props={}){
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  let current={queue:queue(),onEdit(){},onReorder:async()=>{},onDiscard:async()=>{},onSteer:async()=>{},onInterrupt:async()=>{},...props};
  const render=async next=>{current={...current,...next};await act(async()=>root.render(React.createElement(TaskChatQueuedMessages,current)));};
  await render({});
  return {host,get current(){return current;},find:id=>host.querySelector(`[data-testid="${id}"]`),render,
    click:async element=>{assert.ok(element,'Expected a real button');await act(async()=>element.click());},
    close:async()=>{await act(async()=>root.unmount());host.remove();}};
}

test('available adapter steers the exact message/revision and waits for its callback without Interrupt',async()=>{
  const pending=deferred(),calls=[];let interrupts=0;
  const q=queue({entries:[entry(),entry('message-2','A second message remains visible')]});
  const ui=await mount({queue:q,onSteer:(...args)=>{calls.push(args);return pending.promise;},onInterrupt:async()=>{interrupts++;}});
  try{
    const button=ui.find('task-chat-queued-steer-message-1');assert.equal(button.disabled,false);
    assert.equal(ui.find('task-chat-queued-interrupt-message-1'),null);
    await ui.click(button);assert.deepEqual(calls,[['message-1','revision-1']]);assert.equal(interrupts,0);
    assert.equal(ui.find('task-chat-queued-message-message-1'),null,'Presentation optimistically hides the selected row');
    assert.equal(q.entries.length,2,'The component cannot mutate the durable queue snapshot');
    assert.match(ui.host.textContent,/Steering queued message/);
    assert.doesNotMatch(ui.host.textContent,/Message steered into the active turn/);
    assert.equal(ui.find('task-chat-queued-steer-message-2').disabled,true);
    await act(async()=>pending.resolve());
    assert.match(ui.host.textContent,/Message steered into the active turn/);
    assert.equal(ui.find('task-chat-queued-steer-message-2').disabled,false);assert.equal(interrupts,0);
  }finally{await ui.close();}
});

test('steering rejection restores the latest polled queue, shows error, and never falls back to Interrupt',async()=>{
  const pending=deferred();let interrupts=0,steers=0;
  const ui=await mount({onSteer:()=>{steers++;return pending.promise;},onInterrupt:async()=>{interrupts++;}});
  try{
    await ui.click(ui.find('task-chat-queued-steer-message-1'));
    await ui.render({queue:queue({revision:'revision-2',entries:[entry('message-1','Latest saved edit')]})});
    assert.equal(ui.find('task-chat-queued-message-message-1'),null);
    await act(async()=>pending.reject(Object.assign(new Error('No provider acknowledgement'),{body:{code:'adapter_interactive_delivery_uncertain'}})));
    assert.ok(ui.find('task-chat-queued-message-message-1'));assert.match(ui.host.textContent,/Latest saved edit/);
    assert.match(ui.host.textContent,/Couldn’t steer. Message is still queued/);
    assert.equal(ui.find('task-chat-queued-interrupt-message-1'),null);assert.equal(steers,1);assert.equal(interrupts,0);
  }finally{await ui.close();}
});

for(const disposition of ['temporarily_unavailable','unsupported']){
  test(`adapter ${disposition} keeps disabled Steer, with no implicit Interrupt action`,async()=>{
    let calls=0;const ui=await mount({queue:queue({steeringDisposition:disposition}),onSteer:async()=>{calls++;},onInterrupt:async()=>{calls++;}});
    try{
      const button=ui.find('task-chat-queued-steer-message-1');assert.ok(button);assert.equal(button.disabled,true);
      assert.match(button.title,disposition==='unsupported'?/does not support steering/:/temporarily unavailable/);
      assert.equal(ui.find('task-chat-queued-interrupt-message-1'),null);await ui.click(button);assert.equal(calls,0);
    }finally{await ui.close();}
  });
}

test('a capability loss on rerender disables steering without automatically sending or interrupting',async()=>{
  let calls=0;const ui=await mount({onSteer:async()=>{calls++;},onInterrupt:async()=>{calls++;}});
  try{
    assert.equal(ui.find('task-chat-queued-steer-message-1').disabled,false);
    await ui.render({queue:queue({revision:'revision-2',steeringDisposition:'temporarily_unavailable'})});
    assert.equal(ui.find('task-chat-queued-steer-message-1').disabled,true);assert.equal(calls,0);
    await ui.render({queue:queue({revision:'revision-3'})});
    assert.equal(ui.find('task-chat-queued-steer-message-1').disabled,false);assert.equal(calls,0);
  }finally{await ui.close();}
});

test('legacy protocol retains its explicit Interrupt button and calls only that action',async()=>{
  let steers=0,interrupts=0;const ui=await mount({queue:queue({protocol:'legacy',steeringDisposition:'unsupported'}),onSteer:async()=>{steers++;},onInterrupt:async()=>{interrupts++;}});
  try{
    assert.equal(ui.find('task-chat-queued-steer-message-1'),null);
    const button=ui.find('task-chat-queued-interrupt-message-1');assert.equal(button.disabled,false);assert.equal(button.textContent.trim(),'Interrupt');
    assert.equal(interrupts,0);await ui.click(button);assert.equal(interrupts,1);assert.equal(steers,0);
  }finally{await ui.close();}
});

test('missing durable queue disables adapter steering and leaves the message visible',async()=>{
  let calls=0;const ui=await mount({queue:queue({queueId:null}),onSteer:async()=>{calls++;}});
  try{const button=ui.find('task-chat-queued-steer-message-1');assert.equal(button.disabled,true);await ui.click(button);assert.equal(calls,0);assert.ok(ui.find('task-chat-queued-message-message-1'));}
  finally{await ui.close();}
});
