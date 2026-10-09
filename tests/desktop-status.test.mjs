import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const script=await readFile(new URL('../desktop/ui/status.js',import.meta.url),'utf8');
function fixture(quit,update=async()=>({kind:'disabled',message:'Signed updates are not configured.',canInstall:false})){
  const nodes=new Map();const calls=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:id==='busy',textContent:'',value:'',disabled:false,addEventListener(){},querySelectorAll(){return[]},replaceChildren(){},focus(){}});return nodes.get(id);};
  const invoke=async(name,args)=>{calls.push({name,args});if(name==='status')return{detail:'Running',running:true,browsers:[],choice:null,quitRequested:false};if(name==='quit')return quit(args);if(name==='check_updates')return update();if(name==='install_update')throw new Error('Echo is processing. Retry after it finishes.');if(name==='recover_library')throw new Error('Recovery did not unlock this library.');if(name==='choose_library')return 'Library selection cancelled.';};
  vm.runInNewContext(script,{window:{__TAURI__:{core:{invoke}}},document:{getElementById:node},setInterval(){},Option:class{} });
  return{node,calls};
}
test('lost quit acknowledgement keeps explicit force action reachable',async()=>{
  const {node,calls}=fixture(async({force})=>{if(!force)throw new Error('Echo is finishing shutdown. Choose Quit anyway.');return{kind:'stopped',message:'',canForce:false};});
  await node('quit').onclick();
  assert.equal(node('busy').hidden,false);assert.match(node('feedback').textContent,/finishing shutdown/);
  assert.equal(node('force').hidden,false);
  await node('force').onclick();
  assert.ok(calls.some(call=>call.name==='quit'&&call.args.force===true));
});
test('updates require a verified available release and interrupted installation stays recoverable',async()=>{
  const disabled=fixture(async()=>({kind:'stopped',message:'',canForce:false}));
  await disabled.node('updates').onclick();assert.equal(disabled.node('install-update').hidden,true);assert.match(disabled.node('feedback').textContent,/not configured/);
  const available=fixture(async()=>({kind:'stopped',message:'',canForce:false}),async()=>({kind:'available',message:'Verified release available.',canInstall:true}));
  await available.node('updates').onclick();assert.equal(available.node('install-update').hidden,false);
  await available.node('install-update').onclick();assert.equal(available.node('install-update').disabled,false);assert.match(available.node('feedback').textContent,/processing/);
});
test('busy and recoverable shutdown outcomes preserve their message and force choice',async()=>{
  for(const kind of ['busy','retry']){
    const {node}=fixture(async()=>({kind,message:'Saved work is still active.',canForce:true}));
    await node('quit').onclick();assert.equal(node('feedback').textContent,'Saved work is still active.');assert.equal(node('busy').hidden,false);assert.equal(node('force').hidden,false);
  }
});

test('recovery clears the phrase before native IPC and remains retryable after failure',async()=>{
  const {node,calls}=fixture(async()=>({kind:'stopped',message:'',canForce:false}));
  node('show-recovery').onclick();assert.equal(node('recovery-form').hidden,false);
  node('recovery-phrase').value='test '.repeat(24).trim();node('other-library').checked=true;
  const promise=node('recovery-form').onsubmit({preventDefault(){}});
  assert.equal(node('recovery-phrase').value,'');
  await promise;
  const call=calls.find(call=>call.name==='recover_library');assert.equal(call.args.otherLibrary,true);assert.equal(call.args.phrase.split(' ').length,24);
  assert.equal(node('recover').disabled,false);assert.match(node('feedback').textContent,/did not unlock/);assert.equal(node('recovery-form').hidden,false);
  node('recovery-phrase').value='too short';await node('recovery-form').onsubmit({preventDefault(){}});
  assert.match(node('feedback').textContent,/24 words/);assert.equal(node('recovery-phrase').value,'');
});
test('library picker cancels without disabling maintenance controls',async()=>{
  const {node,calls}=fixture(async()=>({kind:'stopped',message:'',canForce:false}));
  await node('choose-library').onclick();assert.ok(calls.some(call=>call.name==='choose_library'));assert.equal(node('choose-library').disabled,false);assert.equal(node('retry').disabled,false);
});
