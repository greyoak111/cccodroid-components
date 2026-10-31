'use strict';

const https=require('node:https');
const {validateHeaderValue}=require('node:http');

const REQUEST_TIMEOUT_MS=12000;
const MAX_RESPONSE_BYTES=1024*1024;
const MAX_RESULT_BYTES=128*1024;
const MAX_MODELS=500;
const COMPLETIONS_SUFFIX='/chat/completions';
const CODES=new Set([
  'INVALID_INPUT','KEY_REQUIRED','KEY_HOST_CHANGED','RUNTIME_CONFLICT',
  'MODELS_AUTH','MODELS_FORBIDDEN','MODELS_NOT_FOUND','MODELS_RATE_LIMIT',
  'MODELS_TIMEOUT','MODELS_NETWORK','MODELS_INVALID_RESPONSE','MODELS_TOO_LARGE',
  'MODELS_REDIRECT','MODELS_FAILED'
]);
const SAVED_KEY_CODES=new Set(['KEY_REQUIRED','KEY_HOST_CHANGED','RUNTIME_CONFLICT']);

// Only a static code crosses this module's error boundary, never a remote error/cause.
function guiError(code){const error=new Error(code);error.guiCode=code;return error;}
function errorCode(error,allowed,fallback){
  try{const code=error?.guiCode;if(typeof code==='string'&&allowed.has(code))return code;}catch{}
  return fallback;
}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function normalizeEndpoint(input){
  if(typeof input!=='string'||input.length>2048||/[\s\u0000-\u001f\u007f-\u009f\\?#]/u.test(input)||/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(input))throw guiError('INVALID_INPUT');
  // Check the raw authority too: URL silently discards empty userinfo, '?' and '#'.
  const authority=/^https:\/\/([^/]+)(?:\/|$)/i.exec(input);
  if(!authority||authority[1].includes('@'))throw guiError('INVALID_INPUT');
  let url;try{url=new URL(input);}catch{throw guiError('INVALID_INPUT');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw guiError('INVALID_INPUT');
  const pathname=url.pathname.replace(/\/+$/,'');
  if(!pathname||pathname==='/v1')url.pathname='/v1/chat/completions';
  else if(pathname.endsWith(COMPLETIONS_SUFFIX))url.pathname=pathname;
  else throw guiError('INVALID_INPUT');
  return url.href;
}
function validKey(key){
  if(typeof key!=='string'||!key||key.length>1024||/[\s\u0000-\u001f\u007f-\u009f]/u.test(key))return false;
  try{validateHeaderValue('Authorization','Bearer '+key);return true;}catch{return false;}
}
function normalizeInput(input){
  try{
    if(!object(input)||Reflect.ownKeys(input).some(key=>key!=='endpoint'&&key!=='apiKey'))throw guiError('INVALID_INPUT');
    const fields=Object.getOwnPropertyDescriptors(input);
    if(!fields.endpoint||!('value' in fields.endpoint)||fields.apiKey&&!('value' in fields.apiKey))throw guiError('INVALID_INPUT');
    const endpoint=normalizeEndpoint(fields.endpoint.value);
    const apiKey=fields.apiKey?.value===undefined?'':fields.apiKey.value;
    if(typeof apiKey!=='string'||apiKey!==''&&!validKey(apiKey))throw guiError('INVALID_INPUT');
    return {endpoint,apiKey};
  }catch{throw guiError('INVALID_INPUT');}
}
function modelsResult(body,apiKey){
  let payload;
  try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}
  catch{throw guiError('MODELS_INVALID_RESPONSE');}
  if(!object(payload)||!Array.isArray(payload.data))throw guiError('MODELS_INVALID_RESPONSE');
  const result={schema:1,id:'openai-bridge',models:[],truncated:false};
  const seen=new Set();
  let bytes=Buffer.byteLength(JSON.stringify(result));
  for(const entry of payload.data){
    if(!object(entry)||typeof entry.id!=='string'||/[,\u0000-\u001f\u007f-\u009f]/u.test(entry.id))continue;
    const id=entry.id.trim();
    // A hostile upstream may echo the credential as an id, including a reused key
    // the GUI must never receive. Filter it before counting or returning models.
    if(!id||id.length>200||id.includes(apiKey)||seen.has(id))continue;
    const model={id},extra=Buffer.byteLength(JSON.stringify(model))+(result.models.length?1:0);
    if(result.models.length===MAX_MODELS||bytes+extra>MAX_RESULT_BYTES){result.truncated=true;break;}
    seen.add(id);result.models.push(model);bytes+=extra;
  }
  return result;
}
function statusError(status){
  if(status>=300&&status<400)return 'MODELS_REDIRECT';
  if(status===401)return 'MODELS_AUTH';
  if(status===403)return 'MODELS_FORBIDDEN';
  if(status===404)return 'MODELS_NOT_FOUND';
  if(status===429)return 'MODELS_RATE_LIMIT';
  return status>=200&&status<300?null:'MODELS_FAILED';
}
function networkCode(error){
  return error?.code==='ETIMEDOUT'||error?.code==='ESOCKETTIMEDOUT'||error?.code==='ERR_HTTP_REQUEST_TIMEOUT'?'MODELS_TIMEOUT':'MODELS_NETWORK';
}
function requestModels(url,apiKey){
  return new Promise((resolve,reject)=>{
    let request,response,socket,timer,settled=false,bytes=0;
    const chunks=[];
    const cleanup=()=>{
      clearTimeout(timer);chunks.length=0;
      // agent:false gives this GET a single-use, direct socket, including on newer Node
      // versions whose globalAgent may honor environment proxy settings.
      for(const stream of [response,request,socket])try{stream?.destroy();}catch{}
    };
    const finish=(code,result)=>{
      if(settled)return;
      settled=true;cleanup();
      if(code)reject(guiError(code));else resolve(result);
    };
    // An absolute deadline covers DNS, TLS, headers and a slow/trickling response.
    timer=setTimeout(()=>finish('MODELS_TIMEOUT'),REQUEST_TIMEOUT_MS);
    try{
      request=https.get(url,{
        agent:false,rejectUnauthorized:true,
        headers:{Authorization:'Bearer '+apiKey,Accept:'application/json','Accept-Encoding':'identity'}
      },res=>{
        response=res;
        res.on('error',error=>finish(networkCode(error)));
        res.on('aborted',()=>finish('MODELS_NETWORK'));
        res.on('close',()=>{if(!settled)finish('MODELS_NETWORK');});
        if(settled){try{res.destroy();}catch{}return;}
        const code=statusError(res.statusCode);
        if(code){finish(code);return;}
        if(Number(res.headers?.['content-length'])>MAX_RESPONSE_BYTES){finish('MODELS_TOO_LARGE');return;}
        res.on('data',chunk=>{
          if(settled)return;
          try{
            const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
            bytes+=data.length;
            if(bytes>MAX_RESPONSE_BYTES){finish('MODELS_TOO_LARGE');return;}
            chunks.push(data);
          }catch{finish('MODELS_INVALID_RESPONSE');}
        });
        res.on('end',()=>{
          if(settled)return;
          if(res.complete===false){finish('MODELS_NETWORK');return;}
          try{finish(null,modelsResult(Buffer.concat(chunks,bytes),apiKey));}
          catch(error){finish(errorCode(error,CODES,'MODELS_INVALID_RESPONSE'));}
        });
      });
      request.on('error',error=>finish(networkCode(error)));
      request.on('timeout',()=>finish('MODELS_TIMEOUT'));
      request.on('close',()=>{if(!response&&!settled)finish('MODELS_NETWORK');});
      request.on('socket',stream=>{
        socket=stream;
        stream.on('error',error=>finish(networkCode(error)));
        if(settled)try{stream.destroy();}catch{}
      });
      request.on('upgrade',(res,stream)=>{
        response=res;socket=stream;
        res.on('error',()=>{});stream.on('error',()=>{});
        finish('MODELS_FAILED');
      });
      if(settled)cleanup();
    }catch{finish('MODELS_NETWORK');}
  });
}

// The installer owns all filesystem/instance/origin checks for reusing an old key.
// This module never reads credentials, writes configuration or starts the bridge.
exports.listModels=async function listModels(input,options={}){
  try{
    const normalized=normalizeInput(input);
    if(!object(options)||options.resolveSavedKey!==undefined&&typeof options.resolveSavedKey!=='function')throw guiError('INVALID_INPUT');
    let apiKey=normalized.apiKey;
    if(!apiKey){
      if(typeof options.resolveSavedKey!=='function')throw guiError('KEY_REQUIRED');
      try{apiKey=await options.resolveSavedKey(normalized.endpoint);}
      catch(error){throw guiError(errorCode(error,SAVED_KEY_CODES,'RUNTIME_CONFLICT'));}
      if(apiKey===undefined||apiKey===null||apiKey==='')throw guiError('KEY_REQUIRED');
      if(!validKey(apiKey))throw guiError('RUNTIME_CONFLICT');
    }
    const url=normalized.endpoint.slice(0,-COMPLETIONS_SUFFIX.length)+'/models';
    return await requestModels(url,apiKey);
  }catch(error){throw guiError(errorCode(error,CODES,'MODELS_FAILED'));}
};
