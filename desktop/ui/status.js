const invoke=window.__TAURI__.core.invoke;
const $=id=>document.getElementById(id);
let browserIds='';
async function refresh(){
  try{
    const state=await invoke('status');$('status').textContent=state.detail;$('library-path').textContent=state.libraryPath||'';
    const ids=state.browsers.map(b=>b.id).join(',');
    if(ids!==browserIds){browserIds=ids;$('browser').replaceChildren(new Option('Choose Brave or Chrome',''),...state.browsers.map(b=>new Option(b.name,b.id)));if(state.browsers.some(b=>b.id===state.choice))$('browser').value=state.choice;}
    $('open').disabled=!state.running||!$('browser').value;$('no-browser').hidden=state.browsers.length>0;
    if(state.quitRequested)await requestQuit(false);
  }catch(e){$('status').textContent=String(e);}
}
async function action(name,args){try{const result=await invoke(name,args);$('feedback').textContent=typeof result==='string'?result:'';await refresh();return{ok:true,value:result};}catch(e){$('feedback').textContent=String(e);return{ok:false,error:String(e)};}}
async function requestQuit(force){
  $('force').disabled=true;
  try{
    const result=await invoke('quit',{force});
    $('feedback').textContent=result.message;
    $('busy').hidden=result.kind==='stopped';
    $('force').hidden=!result.canForce;
  }catch(e){
    // Lost acknowledgements must not hide the deliberate force action.
    $('feedback').textContent=String(e);$('busy').hidden=false;$('force').hidden=false;
  }finally{$('force').disabled=false;}
}
$('browser').addEventListener('change',refresh);
$('open').onclick=()=>action('open_echo',{browserId:$('browser').value});
$('retry').onclick=()=>action('retry');
$('updates').onclick=async()=>{
  $('updates').disabled=true;$('install-update').hidden=true;
  try{const result=await invoke('check_updates');$('feedback').textContent=result.message;$('install-update').hidden=!result.canInstall;}
  catch(error){$('feedback').textContent=String(error);}
  finally{$('updates').disabled=false;}
};
$('install-update').onclick=async()=>{
  $('install-update').disabled=true;$('feedback').textContent='Downloading and verifying the signed update…';
  const result=await action('install_update');if(!result.ok)$('install-update').disabled=false;
};
$('quit').onclick=()=>requestQuit(false);
$('force').onclick=()=>requestQuit(true);
$('wait').onclick=()=>{$('busy').hidden=true;$('feedback').textContent='Echo will keep running. Quit again when your work is finished.';};
for(const link of $('no-browser').querySelectorAll('a'))link.onclick=event=>{event.preventDefault();action('browser_download',{browserId:link.href.includes('brave.com')?'brave':'chrome'});};
refresh();setInterval(refresh,2000);
let maintaining=false;
function maintenanceControls(busy){maintaining=busy;for(const id of ['choose-library','recover','retry','updates','install-update'])$(id).disabled=busy;}
$('choose-library').onclick=async()=>{
  if(maintaining)return;maintenanceControls(true);$('feedback').textContent='Choose the Echo data folder to copy and verify…';
  try{await action('choose_library');}finally{maintenanceControls(false);}
};
$('show-recovery').onclick=()=>{$('recovery-form').hidden=false;$('recovery-phrase').focus();};
$('cancel-recovery').onclick=()=>{$('recovery-phrase').value='';$('recovery-form').hidden=true;};
$('recovery-form').onsubmit=async event=>{
  event.preventDefault();if(maintaining)return;
  let phrase=$('recovery-phrase').value;$('recovery-phrase').value='';
  if(phrase.trim().split(/\s+/).length!==24){$('feedback').textContent='Enter all 24 words from your recovery phrase.';phrase='';return;}
  maintenanceControls(true);$('feedback').textContent='Recovering the library key…';
  try{const request=action('recover_library',{phrase,otherLibrary:$('other-library').checked});phrase='';const result=await request;if(result.ok)$('recovery-form').hidden=true;}
  finally{phrase='';$('recovery-phrase').value='';maintenanceControls(false);}
};
