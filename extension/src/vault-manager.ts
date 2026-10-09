import {createVault,importPrivateIdentity,recoverIdentity,VaultDescriptor} from './vault-crypto';
import {readMeta,writeMeta,storageLock} from './vault-db';
import {settings} from './settings';
import {endpointURL} from './core';
declare const chrome:any;
const sessionKey='recordingVaultIdentity';
const generationKey='recordingVaultGeneration';
type Identity={vaultId:string;privateMaterial:string;source:'setup'|'recovery'|'echo';libraryId?:string};
type Pending={descriptor:VaultDescriptor;privateMaterial:string;checks:string[]};
const checkIndices=[2,11,20];
export class VaultLockedError extends Error {constructor(){super('Open Echo to unlock saved recordings, or enter your recovery phrase in Setup. New recordings can still be saved securely offline.');}}
async function session<T>(key:string):Promise<T|undefined>{
  // Chromium offscreen documents expose runtime only. Identity transport is
  // restricted by the worker to its exact own offscreen URL and extension ID.
  if(!chrome.storage?.session){if(key!==sessionKey)throw new VaultLockedError();const response=await chrome.runtime.sendMessage({target:'background',type:'TRUSTED_VAULT_IDENTITY'});if(!response?.ok)throw new VaultLockedError();return response.value;}
  await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});return (await chrome.storage.session.get(key))[key];
}
// Shared across trusted extension contexts and retained across service-worker
// restarts. Publication and invalidation use the same lock, including the final
// asynchronous chrome.storage write, so a late response cannot undo a lock.
async function generation():Promise<number>{return await session<number>(generationKey)??0;}
async function publishIdentity(identity:Identity,expectedGeneration:number,authorized?:()=>Promise<boolean>):Promise<boolean>{
  return storageLock('vault-identity',async()=>{
    if(authorized && !await authorized())return false;
    if(await generation()!==expectedGeneration)return false;
    await chrome.storage.session.set({[sessionKey]:identity});return true;
  });
}
async function invalidateIdentity(onlyEcho:boolean):Promise<void>{
  await storageLock('vault-identity',async()=>{
    const next=(await generation())+1;
    const saved=await session<Identity>(sessionKey);
    // Commit invalidation and removal together: termination after this write
    // must never leave a new generation alongside the old Echo identity.
    await chrome.storage.session.set({[generationKey]:next,[sessionKey]:onlyEcho&&saved?.source!=='echo'?saved??null:null});
  });
  lastSync=0;uploaded=undefined;
}
export function trustedVaultIdentity():Promise<Identity|undefined>{return session<Identity>(sessionKey);}
export function vaultDescriptor():Promise<VaultDescriptor|undefined>{return readMeta<VaultDescriptor>('recording-vault');}
export async function privateIdentity(descriptor:VaultDescriptor):Promise<CryptoKey>{const saved=await session<Identity>(sessionKey);if(!saved || saved.vaultId!==descriptor.vaultId)throw new VaultLockedError();return importPrivateIdentity(descriptor,saved.privateMaterial);}
export async function beginVaultSetup():Promise<{phrase:string;positions:number[]}>{
  return storageLock('vault-setup',async()=>{
    if(await vaultDescriptor())throw new Error('Recording protection is already set up. Use your saved recovery phrase to unlock it.');
    const made=await createVault();const words=made.phrase.split(' ');
    await chrome.storage.session.set({pendingRecordingVault:{descriptor:made.descriptor,privateMaterial:made.privateMaterial,checks:checkIndices.map(i=>words[i])}});
    return {phrase:made.phrase,positions:checkIndices.map(i=>i+1)};
  });
}
export async function confirmVaultSetup(words:unknown):Promise<void>{
  await storageLock('vault-setup',async()=>{
    if(await vaultDescriptor())return;
    const epoch=await generation();const pending=await session<Pending>('pendingRecordingVault');
    if(!pending || !Array.isArray(words) || words.length!==checkIndices.length || words.some((word,i)=>typeof word!=='string'||word.trim().toLowerCase()!==pending.checks[i]))throw new Error('Check those recovery words before continuing.');
    // Save session first. A failed descriptor commit can be retried without ever
    // committing recordings under an identity that has no recovery envelope.
    if(!await publishIdentity({vaultId:pending.descriptor.vaultId,privateMaterial:pending.privateMaterial,source:'setup'},epoch))throw new Error('Recording protection was locked while setup was running. Retry confirmation.');
    await writeMeta('recording-vault',pending.descriptor);
    await chrome.storage.session.remove('pendingRecordingVault');
  });
  await syncVaultWithEcho(true);
}
export async function recoverVault(phrase:unknown):Promise<void>{
  const epoch=await generation();const descriptor=await vaultDescriptor();if(!descriptor)throw new Error('Set up recording protection first.');
  if(typeof phrase!=='string')throw new Error('Enter your saved 24-word recovery phrase.');
  const identity=await recoverIdentity(descriptor,phrase);
  if(!await publishIdentity({vaultId:descriptor.vaultId,privateMaterial:identity.privateMaterial,source:'recovery'},epoch))throw new Error('The vault was locked during recovery. Enter your phrase again to unlock.');
  await syncVaultWithEcho(true);
}
export function lockEchoIdentity():Promise<void>{return invalidateIdentity(true);}
export function lockVault():Promise<void>{return invalidateIdentity(false);}
let lastSync=0;let syncing:Promise<void>|undefined;let syncError:string|undefined;
let uploaded:string|undefined;
export function syncVaultWithEcho(force=false):Promise<void>{
  if(syncing)return syncing;
  if(!force && Date.now()-lastSync<5000)return Promise.resolve();
  syncing=(async()=>{
    lastSync=Date.now();const epoch=await generation();const descriptor=await vaultDescriptor();if(!descriptor)return;
    const prefs=await settings();const pair=prefs.pairs[prefs.activeLibraryId??''];if(!pair)return;
    const identity=await session<Identity>(sessionKey);const matching=identity?.vaultId===descriptor.vaultId ? identity:undefined;
    const binding=JSON.stringify([pair.libraryId,pair.endpoint,pair.credential,descriptor.vaultId]);
    // Verify authority even when the private identity is already in session.
    const headers=new Headers({Authorization:`Bearer ${pair.credential}`,Origin:chrome.runtime.getURL('').replace(/\/$/,'')});
    const options:RequestInit={method:'GET',headers,redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(3000)};
    if(matching && uploaded!==binding){options.method='PUT';headers.set('Content-Type','application/json');options.body=JSON.stringify({vaultId:descriptor.vaultId,privateMaterial:matching.privateMaterial,descriptor});}
    let response:Response;try{response=await fetch(endpointURL(pair.endpoint)+`/extension/v1/vault?vaultId=${encodeURIComponent(descriptor.vaultId)}`,options);}catch{syncError='Echo is unavailable. Your saved recovery phrase can unlock history.';return;}
    const authorized=async()=>{const current=await settings();const currentPair=current.pairs[current.activeLibraryId??''];return !!currentPair && currentPair.credential===pair.credential && currentPair.endpoint===pair.endpoint && currentPair.libraryId===pair.libraryId;};
    if(!await authorized() || await generation()!==epoch)return;
    if(response.status===401){await lockEchoIdentity();syncError='This browser connection was revoked. Use your recovery phrase to open local history.';return;}
    if(!response.ok){syncError=response.status===404?'Unlock once with your recovery phrase to enable automatic unlock in Echo.':'Echo could not unlock this recording vault. Use your saved recovery phrase.';return;}
    const body=await response.json();if(body.protocolVersion!==1 || body.vaultId!==descriptor.vaultId || body.libraryId!==pair.libraryId)throw new Error('Echo returned an invalid recording vault.');
    if(options.method==='PUT'){if(body.registered!==true)throw new Error('Echo did not confirm recording protection.');if(await generation()!==epoch||!await authorized())return;uploaded=binding;syncError=undefined;return;}
    if(typeof body.privateMaterial!=='string')throw new Error('Echo returned an invalid recording vault.');
    await importPrivateIdentity(descriptor,body.privateMaterial);
    if(!matching){if(!await publishIdentity({vaultId:descriptor.vaultId,privateMaterial:body.privateMaterial,source:'echo',libraryId:pair.libraryId},epoch,authorized))return;}
    else if(await generation()!==epoch||!await authorized())return;
    uploaded=binding;syncError=undefined;
  })().catch(()=>{syncError='Echo could not unlock this recording vault. Your local audio is retained.';}).finally(()=>{syncing=undefined;});return syncing;
}
export async function vaultStatus():Promise<{ready:boolean;unlocked:boolean;error?:string}>{
  const descriptor=await vaultDescriptor();if(!descriptor)return {ready:false,unlocked:false};
  const identity=await session<Identity>(sessionKey);return {ready:true,unlocked:identity?.vaultId===descriptor.vaultId,error:syncError};
}
