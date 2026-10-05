// Packages only version-controlled source and explicitly selected release assets.
import { execFileSync } from 'node:child_process';
import { mkdir, cp, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
if(process.platform!=='linux'||process.arch!=='x64')throw new Error('Prebuilt packaging requires a Linux x64 build host.');
const root=process.cwd(),stage=path.join(root,'tmp','release-stage');
await mkdir(path.join(root,'artifacts'),{recursive:true});
await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
// Keep the portable optional runner executable from both source and app bundles.
for(const required of ['compose.runner.yaml','runner/Dockerfile','runner/.dockerignore','runner/container-entrypoint.sh','runner/audio_smoke.py','runner/capture.py','runner/meet_ui.py','runner/README.md']){
  if(!files.includes(required))throw new Error(`Release is missing tracked Docker runner file: ${required}`);
}
for(const file of files){if(file.startsWith('artifacts/')&&!/\.(png|json)$/.test(file))continue;await mkdir(path.dirname(path.join(stage,'echo-voice-web',file)),{recursive:true});await cp(file,path.join(stage,'echo-voice-web',file));}
execFileSync('tar',['-czf',path.join(root,'artifacts','echo-voice-source.tar.gz'),'-C',stage,'echo-voice-web']);
for(const directory of ['public/assets','public/js','public/wasm'])await cp(directory,path.join(stage,'echo-voice-web',directory),{recursive:true});
await mkdir(path.join(stage,'echo-voice-web/target/release'),{recursive:true});await cp('target/release/echo-server',path.join(stage,'echo-voice-web/target/release/echo-server'));
const helper='node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
let bundledCodex=false;
try{await access(helper);bundledCodex=true;}catch{}
if(bundledCodex){await mkdir(path.join(stage,'echo-voice-web/tools/codex'),{recursive:true});await cp(helper,path.join(stage,'echo-voice-web/tools/codex/codex'));await cp('third_party/codex-LICENSE',path.join(stage,'echo-voice-web/tools/codex/LICENSE'));}
await writeFile(path.join(stage,'echo-voice-web/RUN-ME.txt'),`Echo Voice · Linux x64\nRun ./scripts/start.sh and open http://localhost:3000\nNo Rust or Node runtime is required for this prebuilt bundle.\n${bundledCodex?'Includes OpenAI Codex 0.160.0 for optional ChatGPT sign-in.':'ChatGPT sign-in requires the optional Codex 0.160.0 helper.'}\nSee README.md for models, ChatGPT, calendar, the optional meeting runner, and qualification limits.\n`);
execFileSync('tar',['-czf',path.join(root,'artifacts','echo-voice-linux-x64.tar.gz'),'-C',stage,'echo-voice-web']);
await rm(stage,{recursive:true,force:true});
console.log('Packaged source and prebuilt Linux x64 artifacts without meeting data, credentials, or model downloads.');
