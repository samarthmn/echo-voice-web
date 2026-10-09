// Browser-profile storage. Keys here protect accidental storage disclosure; the
// browser profile and OS account remain trusted. Recording identities live only
// in session storage and are recovered from Echo or the saved recovery phrase.
let opening: Promise<IDBDatabase> | undefined;
export function database(): Promise<IDBDatabase> {
  return opening ??= new Promise((resolve,reject) => {
    const request = indexedDB.open('echo-meeting-journal',2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if(!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings',{keyPath:'recordingId'});
      if(!db.objectStoreNames.contains('chunks')) {const chunks=db.createObjectStore('chunks',{keyPath:['recordingId','sequence']});chunks.createIndex('recording','recordingId');}
      if(!db.objectStoreNames.contains('meta')) db.createObjectStore('meta',{keyPath:'key'});
    };
    request.onsuccess = () => {request.result.onversionchange=()=>{request.result.close();opening=undefined;};resolve(request.result);};
    request.onerror=()=>{opening=undefined;reject(request.error);};request.onblocked=()=>{opening=undefined;reject(new Error('Close other Echo extension pages and try again.'));};
  });
}
export function result<T>(request:IDBRequest<T>):Promise<T> {return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
export function committed(tx:IDBTransaction):Promise<void> {return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error??new Error('Local storage did not commit.'));});}
export async function readMeta<T>(key:string):Promise<T|undefined> {const db=await database();return (await result<any>(db.transaction('meta').objectStore('meta').get(key)))?.value;}
export async function writeMeta(key:string,value:unknown):Promise<void> {const db=await database();const tx=db.transaction('meta','readwrite',{durability:'strict'});const done=committed(tx);tx.objectStore('meta').put({key,value});await done;}
export function storageLock<T>(id:string,work:()=>Promise<T>):Promise<T> {
  if(!globalThis.navigator?.locks) throw new Error('This browser cannot safely coordinate encrypted recording storage.');
  return navigator.locks.request(`echo-encrypted-storage:${id}`,{mode:'exclusive'},work);
}
