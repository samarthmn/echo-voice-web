import {meetingFor} from './core';
import {observeDocument} from './adapters';
declare const chrome: any;
// This script is a one-way observer. It never receives endpoint settings, tokens or capture audio.
const marker = '__echoMuteObserverV1';
if(!(globalThis as any)[marker]) {
  (globalThis as any)[marker] = true; let seq = 0;
  const send = () => {
    const meeting = meetingFor(location.href);
    chrome.runtime.sendMessage({type:'MUTE_OBSERVATION',seq:seq++,observedAt:Date.now(),url:location.href,state:meeting ? observeDocument(meeting.provider,document) : 'unknown'}).catch(() => {});
  };
  const observer = new MutationObserver(send); observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-label','title','aria-pressed','class','style']});
  setInterval(send,500); window.addEventListener('pagehide',() => chrome.runtime.sendMessage({type:'MUTE_OBSERVATION',seq:seq++,observedAt:Date.now(),url:location.href,state:'unknown'}).catch(() => {})); send();
}
