import {meetingFor} from './core';
import {observeDocument} from './adapters';
declare const chrome: any;
// This script is a one-way observer. It never receives endpoint settings, tokens or capture audio.
const marker = '__echoMuteObserverV2';
{
  const previous = (globalThis as any)[marker];
  previous?.dispose?.();
  let seq = Number.isSafeInteger(previous?.nextSequence) ? previous.nextSequence : 0;
  let disposed = false; let lastSentAt = -Infinity; let pending: ReturnType<typeof setTimeout> | undefined;
  const transmit = (message: any) => {try {chrome.runtime.sendMessage(message).catch(dispose);} catch {dispose(); /* Extension reload invalidated this observer's runtime. */ }};
  const send = () => {
    if(disposed) return;
    if(pending !== undefined) {clearTimeout(pending); pending = undefined;}
    lastSentAt = Date.now();
    const meeting = meetingFor(location.href);
    transmit({type:'MUTE_OBSERVATION',seq:seq++,observedAt:lastSentAt,url:location.href,state:meeting ? observeDocument(meeting.provider,document) : 'unknown'});
  };
  const schedule = () => {
    if(disposed) return;
    const remaining = 100 - (Date.now() - lastSentAt);
    if(remaining <= 0) send();
    else if(pending === undefined) pending = setTimeout(send,remaining);
  };
  // Provider animation/layout mutations can arrive in bursts. Read the latest
  // controls at most once per 100 ms; a separate heartbeat also runs without DOM changes.
  const observer = new MutationObserver(schedule); observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-label','title','aria-pressed','class','style']});
  const timer = setInterval(schedule,500);
  const pagehide = (event: PageTransitionEvent) => {
    if(event.isTrusted && !disposed) {transmit({type:'MEETING_PAGEHIDE',seq:seq++,observedAt:Date.now(),url:location.href,state:'unknown'}); dispose();}
  };
  function dispose() {
    if(disposed) return; disposed = true;
    observer.disconnect(); clearInterval(timer); if(pending !== undefined) clearTimeout(pending);
    pending = undefined; window.removeEventListener('pagehide',pagehide);
  }
  window.addEventListener('pagehide',pagehide);
  (globalThis as any)[marker] = {get nextSequence() {return seq;},dispose};
  send();
}
