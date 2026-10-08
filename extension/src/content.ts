import {meetingFor} from './core';
import {observeDocument} from './adapters';
declare const chrome: any;
// This script is a one-way observer. It never receives endpoint settings, tokens or capture audio.
const marker = '__echoMuteObserverV2';
{
  const previous = (globalThis as any)[marker];
  previous?.dispose?.();
  let seq = Number.isSafeInteger(previous?.nextSequence) ? previous.nextSequence : 0;
  const transmit = (message: any) => {try {chrome.runtime.sendMessage(message).catch(() => {});} catch { /* Extension reload invalidated this observer's runtime. */ }};
  const send = () => {
    const meeting = meetingFor(location.href);
    transmit({type:'MUTE_OBSERVATION',seq:seq++,observedAt:Date.now(),url:location.href,state:meeting ? observeDocument(meeting.provider,document) : 'unknown'});
  };
  const observer = new MutationObserver(send); observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-label','title','aria-pressed','class','style']});
  const timer = setInterval(send,500);
  const pagehide = (event: PageTransitionEvent) => {
    if(event.isTrusted) transmit({type:'MEETING_PAGEHIDE',seq:seq++,observedAt:Date.now(),url:location.href,state:'unknown'});
  };
  window.addEventListener('pagehide',pagehide);
  (globalThis as any)[marker] = {get nextSequence() {return seq;},dispose() {observer.disconnect(); clearInterval(timer); window.removeEventListener('pagehide',pagehide);}};
  send();
}
