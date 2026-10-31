#!/usr/bin/env node
// 无第三方依赖的安装器；不读取打包者的配置，不把密钥放进命令行或日志。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const readline = require('node:readline/promises');
const {Writable} = require('node:stream');

const VERSION = '1.0.5';
const CCR_VERSION = '1.0.73';
const MARKER = '.ccr-bridge-kit.json';
const SOURCE = __dirname;
const RUNTIME_FILES = ['bridge-common.sh','start-bridge.sh','watchdog.sh','patch-ccr.js','health.cjs','service-registration.cjs'];
const registration = require(exists(path.join(SOURCE,'service-registration.cjs'))?'./service-registration.cjs':'./runtime/service-registration.cjs');
const COMMANDS = new Set(['install','status','start','ensure','stop','uninstall','connection']);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function atomic(file, content, mode=0o600) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp = path.join(path.dirname(file),'.kit-'+crypto.randomUUID()+'.tmp');
  try {
    fs.writeFileSync(temp,content,{flag:'wx',mode});
    fs.renameSync(temp,file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function json(file) { return JSON.parse(fs.readFileSync(file,'utf8')); }
function object(value) { return value !== null && typeof value==='object' && !Array.isArray(value); }
function same(a,b) { return JSON.stringify(a)===JSON.stringify(b); }
function exists(file) { try { fs.lstatSync(file); return true; } catch(e) { if(e.code==='ENOENT')return false; throw e; } }
function backup(file) {
  const dest = file+'.bridge-kit-backup-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex');
  fs.copyFileSync(file,dest,fs.constants.COPYFILE_EXCL);
  fs.chmodSync(dest,0o600);
  return dest;
}
function run(command,args,options={}) {
  const r=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,...options});
  if(r.error)throw new Error(`${command} 执行失败：${r.error.message}`);
  return r;
}
function checkTools(bundled) {
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('需要 Node.js 22 或更新版本。');
  const tools=['flock','setsid','timeout','readlink','tee','base64'];
  if(!bundled)tools.push('npm');
  const r=run('bash',['-c','for x in "$@"; do command -v "$x" >/dev/null || { printf "missing: %s\\n" "$x"; exit 1; }; done; [[ ${BASH_VERSINFO[0]} -ge 4 ]]','bridge-tools',...tools]);
  if(r.status!==0)throw new Error('缺少运行依赖（Bash 4+、flock、setsid、timeout 等）：'+r.stdout+r.stderr);
  if(!fs.existsSync('/proc/self/cmdline'))throw new Error('当前安装包只支持具有 /proc 的 Android/Linux，不支持 Windows/macOS。');
}
function safeTarget(input,settings) {
  const target=path.resolve(input);
  const home=path.resolve(os.homedir());
  if(target==='/'||target===home||path.basename(target)==='.claude')throw new Error('安装目录必须是专用子目录，不能是根目录、HOME 或 .claude。');
  if(settings===target || settings.startsWith(target+path.sep))throw new Error('Claude 设置不能放进安装目录，避免卸载误删。');
  let p=target;
  while(!exists(p))p=path.dirname(p);
  const resolved=path.join(fs.realpathSync(p),path.relative(p,target));
  if(/^\/(sdcard|storage|mnt\/media_rw)(\/|$)/.test(resolved))throw new Error('不能安装到共享存储。请使用应用私有目录；ZIP 可以保存在共享目录。');
  if(exists(target)&&fs.lstatSync(target).isSymbolicLink())throw new Error('安装目标不能是符号链接。');
  return target;
}
function readSettings(file,allowDisabled=false) {
  if(!exists(file))return {};
  if(fs.lstatSync(file).isSymbolicLink())throw new Error('设置文件是符号链接，拒绝自动修改。');
  const value=json(file);
  if(!object(value)||value.hooks!==undefined&&!object(value.hooks))throw new Error('Claude 设置必须是 JSON 对象，hooks 也必须是对象。');
  if(value.disableAllHooks===true&&!allowDisabled)throw new Error('Claude 已禁用所有 hooks，请先由使用者自行启用。');
  if(value.hooks?.SessionStart!==undefined&&!Array.isArray(value.hooks.SessionStart))throw new Error('已有 SessionStart 不是数组，未修改任何设置。');
  return value;
}
function hookEntry(target) {
  return {matcher:'startup|resume',hooks:[{type:'command',command:'bash '+quote(path.join(target,'start-bridge.sh'))+' --hook',timeout:20}]};
}
function legacyHookEntry(target) {
  return {hooks:[{type:'command',command:'bash '+quote(path.join(target,'start-bridge.sh')),timeout:120}]};
}
function mergeHook(settings,target) {
  const result=structuredClone(settings);
  result.hooks??={};
  result.hooks.SessionStart??=[];
  const entry=hookEntry(target), expected=entry.hooks[0], legacy=legacyHookEntry(target).hooks[0];
  let current=false, old=false;
  for(const group of result.hooks.SessionStart){
    for(const hook of Array.isArray(group?.hooks)?group.hooks:[]){
      if(hook?.command===expected.command){
        if(!same(hook,expected)||group?.matcher!==entry.matcher)throw new Error('已有同路径 hook 被定制，拒绝覆盖。');
        current=true;
      }else if(hook?.command===legacy.command){
        if(!same(hook,legacy))throw new Error('已有同路径 hook 被定制，拒绝覆盖。');
        old=true;
      }
    }
  }
  if(old || current){
    result.hooks.SessionStart=result.hooks.SessionStart.flatMap(g=>{
      if(!Array.isArray(g?.hooks))return [g];
      const hooks=g.hooks.filter(h=>h?.command!==legacy.command&&h?.command!==expected.command);
      if(hooks.length===g.hooks.length)return [g];
      return hooks.length?[{...g,hooks}]:[];
    });
  }
  result.hooks.SessionStart.push(entry);
  return result;
}
function removeHook(settings,target) {
  const result=structuredClone(settings);
  if(!result.hooks?.SessionStart)return result;
  const expected=hookEntry(target).hooks[0], legacy=legacyHookEntry(target).hooks[0];
  result.hooks.SessionStart=result.hooks.SessionStart.flatMap(g=>{
    if(!Array.isArray(g?.hooks))return [g];
    const hooks=g.hooks.filter(h=>!same(h,expected)&&!same(h,legacy));
    if(hooks.length===g.hooks.length)return [g];
    return hooks.length?[{...g,hooks}]:[];
  });
  if(!result.hooks.SessionStart.length)delete result.hooks.SessionStart;
  if(!Object.keys(result.hooks).length)delete result.hooks;
  return result;
}
function copyBundledRuntime(source,dest) {
  const modules=path.join(source,'node_modules');
  const pkg=json(path.join(modules,'@musistudio/claude-code-router/package.json'));
  if(pkg.version!==CCR_VERSION)throw new Error('预装 CCR 版本不匹配。');
  function check(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink()){
        const link=fs.readlinkSync(file),resolved=path.resolve(path.dirname(file),link);
        if(path.isAbsolute(link)||!resolved.startsWith(modules+path.sep))throw new Error('预装依赖链接越界。');
      }else if(entry.isDirectory())check(file);
    }
  }
  check(modules);
  fs.cpSync(modules,path.join(dest,'node_modules'),{recursive:true,verbatimSymlinks:true});
}
function validateConfig(value,port) {
  if(!object(value))throw new Error('配置输入必须是 JSON 对象。');
  const endpoint=String(value.endpoint||'').trim();
  let url;
  try{url=new URL(endpoint);}catch{throw new Error('endpoint 不是有效 URL。');}
  if(url.protocol!=='https:' && !(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('上游必须使用 HTTPS（仅本机测试允许 HTTP）。');
  if(url.username||url.password||url.search||url.hash)throw new Error('上游 URL 不能含认证信息、查询参数或片段；密钥应填写在 apiKey。');
  const apiKey=String(value.apiKey||'').trim();
  if(!apiKey||/[\r\n\0]/.test(apiKey))throw new Error('apiKey 不能为空或含换行。');
  const model=String(value.model||'').trim();
  if(!model||/[,\r\n\0]/.test(model))throw new Error('model 不能为空或包含逗号/换行。');
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('端口须为 1024–65535 的整数。');
  return {endpoint:url.href,apiKey,model};
}
function routerConfig(c,port,key) {
  const route='relay,'+c.model;
  return {HOST:'127.0.0.1',PORT:port,APIKEY:key,LOG:true,LOG_LEVEL:'info',API_TIMEOUT_MS:600000,NON_INTERACTIVE_MODE:true,
    Providers:[{name:'relay',api_base_url:c.endpoint,api_key:c.apiKey,models:[c.model]}],
    Router:{default:route,background:route,think:route,longContext:route,longContextThreshold:60000,webSearch:route}};
}
function portFree(port) {
  return new Promise(resolve=>{
    const server=net.createServer();
    server.once('error',()=>resolve(false));
    server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));
  });
}
async function choosePort() {
  for(let p=3459;p<3490;p++)if(await portFree(p))return p;
  throw new Error('3459–3489 端口均占用，请用 --port 指定空闲端口。');
}
async function ask(label,def='') {
  const r=readline.createInterface({input:process.stdin,output:process.stdout});
  try{return (await r.question(label+(def?' ['+def+']':'')+'：')).trim()||def;}finally{r.close();}
}
async function askSecret() {
  let hidden=false;
  const output=new Writable({write(chunk,enc,cb){if(!hidden)process.stdout.write(chunk);cb();}});
  const r=readline.createInterface({input:process.stdin,output,terminal:true});
  try{
    process.stdout.write('上游 API Key（不回显）：');
    hidden=true;
    const key=await r.question('');
    hidden=false;
    process.stdout.write('\n');
    return key.trim();
  }finally{r.close();}
}
function cleanEnv() {
  const env={...process.env};
  for(const k of ['CCAPP_RUN','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT'])delete env[k];
  return env;
}
function wrapper(target,command) {
  return '#!/bin/bash\nHERE=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}\")" && pwd -P) || exit 1\nexec node "$HERE/manage.cjs" '+command+' --dir "$HERE" "$@"\n';
}
function loadManifest(target) {
  const p=path.join(target,MARKER);
  if(!exists(p))throw new Error('该目录不是由本安装器管理的安装：'+target);
  const m=JSON.parse(instanceFile(p,65536).data);
  if(!object(m)||m.id!=='ccr-bridge-kit'||m.version!==VERSION||typeof m.target!=='string'||path.resolve(m.target)!==target)throw new Error('安装标记不匹配，拒绝操作。');
  return m;
}
function managedIntact(target,m) {
  for(const [name,hash] of Object.entries(m.files)){
    const p=path.join(target,name);
    if(!exists(p)||fs.lstatSync(p).isSymbolicLink()||sha(fs.readFileSync(p))!==hash)throw new Error('安装文件被修改，拒绝静默覆盖：'+p);
  }
}
function instanceOptions(command,options) {
  const endpoint=options.endpoint!==undefined, instance=options.instance!==undefined;
  if(endpoint!==instance)throw new Error('--endpoint 和 --instance 必须同时提供。');
  if(endpoint&&!['ensure','uninstall'].includes(command))throw new Error('--endpoint/--instance 只适用于 ensure 或 uninstall。');
  if(command==='ensure'&&!endpoint)throw new Error('ensure 必须提供 --endpoint 和 --instance。');
  if(endpoint&&(typeof options.endpoint!=='string'||typeof options.instance!=='string'||!/^[0-9a-f]{32}$/.test(options.instance)))throw new Error('本地桥实例参数不合法。');
  return endpoint;
}
function regularFile(file) {
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink())throw new Error('实例元数据必须是普通文件：'+file);
  return st;
}
function sameFile(a,b) { return a.dev===b.dev&&a.ino===b.ino; }
function instanceDirectory(dir) {
  const st=fs.lstatSync(dir);
  if(!st.isDirectory()||fs.realpathSync(dir)!==dir)throw new Error('实例目录或父路径不规范，拒绝操作。');
  return st;
}
function openInstanceDirectory(dir) {
  const st=instanceDirectory(dir),fd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  const check=()=>{
    if(!sameFile(st,fs.fstatSync(fd))||!sameFile(st,instanceDirectory(dir)))throw new Error('操作期间实例目录已变更。');
  };
  try{check();return {fd,stat:st,at:name=>'/proc/self/fd/'+fd+'/'+name,check};}
  catch(error){fs.closeSync(fd);throw error;}
}
function instanceFile(file,limit=1024*1024) {
  // 有界读取且拒绝 FIFO、链接和读取期间的替换；目录 FD 防止中间父路径被换成链接。
  const dir=openInstanceDirectory(path.dirname(file));let fd;
  try{
    const at=dir.at(path.basename(file)),original=regularFile(at);
    if(original.nlink!==1||original.size>limit)throw new Error('实例元数据过大或存在硬链接。');
    fd=fs.openSync(at,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const st=fs.fstatSync(fd);
    if(!st.isFile()||st.nlink!==1||!sameFile(st,original)||st.size>limit)throw new Error('实例元数据已变更。');
    const buffer=Buffer.alloc(limit+1);let size=0,n;
    while(size<buffer.length&&(n=fs.readSync(fd,buffer,size,buffer.length-size,null))>0)size+=n;
    const after=fs.fstatSync(fd);
    dir.check();
    if(size>limit||!sameFile(st,regularFile(at))||st.size!==after.size||st.mtimeMs!==after.mtimeMs||st.ctimeMs!==after.ctimeMs)throw new Error('实例元数据过大或读取期间已变更。');
    return {data:buffer.subarray(0,size),stat:st};
  }finally{if(fd!==undefined)fs.closeSync(fd);fs.closeSync(dir.fd);}
}
function instancePort(target) {
  const text=instanceFile(path.join(target,'port'),6).data.toString('utf8'),port=Number(text);
  if(!Number.isInteger(port)||port<1024||port>65535||(text!==String(port)&&text!==String(port)+'\n'))throw new Error('实例端口不是规范整数。');
  return port;
}
function instancePid(file) {
  if(!exists(file))return null;
  const text=instanceFile(file,16).data.toString('utf8'),pid=Number(text);
  if(!/^[1-9][0-9]*\n?$/.test(text)||!Number.isSafeInteger(pid)||pid<=1||pid>2147483647)throw new Error('实例 PID 元数据不合法。');
  return pid;
}
function stopMetadata(target) {
  const dirs=[target,path.join(target,'runtime-home'),path.join(target,'runtime-home/.claude-code-router')];
  const stats=dirs.map(instanceDirectory),state=dirs[2];
  for(const name of ['start.lock','service.lock','watchdog.lock'])if(exists(path.join(state,name))){
    const st=regularFile(path.join(state,name));
    if(st.nlink!==1)throw new Error('实例锁存在硬链接，拒绝操作。');
  }
  for(const name of ['watchdog.pid','.claude-code-router.pid'])instancePid(path.join(state,name));
  if(exists(path.join(target,'disabled')))instanceFile(path.join(target,'disabled'),32);
  return {state,stats};
}
function checkInstance(target,options,previous=null,registered=true) {
  // 私有 manifest 不是信任根：组件源、私有文件的实际 hash、manifest 三方必须相符。
  // 固定文件白名单也避免恶意清单引导读取 connection/config 或任意用户文件。
  const targetStat=instanceDirectory(target),m=JSON.parse(instanceFile(path.join(target,MARKER),65536).data),home=path.resolve(os.homedir());
  const service=m?.service;
  if(m?.id!=='ccr-bridge-kit'||m.version!==VERSION||m.target!==target||!object(service)||service.schema!==1||service.home!==home||fs.realpathSync(home)!==home||service.instanceId!==options.instance)throw new Error('本地桥实例注册不匹配。');
  const port=instancePort(target);
  if(options.endpoint!=='http://127.0.0.1:'+port)throw new Error('本地桥 endpoint 与实例端口不匹配。');
  if(typeof m.settings!=='string'||!path.isAbsolute(m.settings)||path.resolve(m.settings)!==m.settings)throw new Error('实例设置路径不规范。');
  safeTarget(target,m.settings);
  const registryFile=registration.fileOf(home),registryDir=path.dirname(registryFile);
  instanceDirectory(registryDir);
  const current=exists(registryFile)?JSON.parse(instanceFile(registryFile,4096).data):null;
  const expected=registration.value(target,port,service.instanceId);
  if(registered?(!object(current)||Object.keys(current).length!==5||!Object.keys(expected).every(k=>current[k]===expected[k])):current!==null)throw new Error('本地桥服务注册已变更，拒绝操作。');
  const allowed=new Set([...RUNTIME_FILES,'manage.cjs','stop.sh','uninstall.sh','status.sh','package.json','package-lock.json','port']);
  if(!object(m.files)||[...RUNTIME_FILES,'port'].some(name=>!Object.hasOwn(m.files,name)))throw new Error('实例缺少受管理的运行文件。');
  const sources={};
  for(const name of Object.keys(m.files).sort()){
    const hash=m.files[name];
    if(!allowed.has(name)||typeof hash!=='string'||!/^[0-9a-f]{64}$/.test(hash))throw new Error('实例运行文件清单不合法。');
    const actual=instanceFile(path.join(target,name));
    if(sha(actual.data)!==hash)throw new Error('实例运行文件被修改，拒绝操作。');
    if(RUNTIME_FILES.includes(name)){
      const source=instanceFile(path.join(SOURCE,'runtime',name));
      if(sha(source.data)!==hash)throw new Error('实例运行文件与固定组件不匹配；未执行私有代码。');
      sources[name]={hash,dev:source.stat.dev,ino:source.stat.ino,privateDev:actual.stat.dev,privateIno:actual.stat.ino};
    }
  }
  const runtime=stopMetadata(target);
  if(previous&&(!sameFile(previous.targetStat,targetStat)||!same(previous.manifest,m)||previous.port!==port||!same(previous.sources,sources)||runtime.stats.some((st,i)=>!sameFile(st,previous.runtime.stats[i]))))throw new Error('操作期间实例元数据已变更。');
  return {target,home,port,manifest:m,targetStat,sources,runtime};
}
function openInstanceLock(file,create=false,guard=()=>{}) {
  const dir=openInstanceDirectory(path.dirname(file));let fd;
  try{
    guard();const at=dir.at(path.basename(file)),original=exists(at)?regularFile(at):null;
    if(original&&original.nlink!==1)throw new Error('实例锁存在硬链接，拒绝操作。');
    const flags=fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK;
    // 不使用 shell 重定向、append 或 O_TRUNC；不存在时只允许排他创建。
    if(!original&&!create)throw new Error('实例锁不存在，拒绝操作。');
    guard();dir.check();
    fd=fs.openSync(at,flags|(original?0:fs.constants.O_CREAT|fs.constants.O_EXCL),0o600);
    const st=fs.fstatSync(fd);
    const check=()=>{
      dir.check();const now=regularFile(file);
      if(!st.isFile()||st.nlink!==1||(original&&!sameFile(original,st))||!sameFile(st,fs.fstatSync(fd))||!sameFile(st,now)||now.nlink!==1)throw new Error('操作期间实例锁已变更。');
    };
    check();guard();
    return {fd,check,close(){fs.closeSync(fd);fs.closeSync(dir.fd);}};
  }catch(error){if(fd!==undefined)fs.closeSync(fd);fs.closeSync(dir.fd);throw error;}
}
function withInstanceLock(instance,fn) {
  // 与 register/unregister 同一把锁；无效实例不创建锁或目录，锁一直保留到异步副作用结束。
  const file=path.join(path.dirname(registration.fileOf(instance.home)),'openai-bridge.lock'),lock=openInstanceLock(file);
  let closed=false;const close=()=>{if(!closed){closed=true;lock.close();}};
  try{
    const r=run('flock',['-w','5','3'],{stdio:['ignore','ignore','pipe',lock.fd],timeout:6000});
    if(r.status!==0)throw new Error('服务注册正在使用，未修改。');
    lock.check();const result=fn(lock.check);
    if(result&&typeof result.then==='function')return result.finally(close);
    close();return result;
  }catch(error){close();throw error;}
}
function showConnection(target,showKey=false) {
  const m=loadManifest(target);
  const keyfile=path.join(target,'connection.json');
  const c=json(keyfile);
  console.log('本机服务地址：'+c.baseUrl);
  console.log('模型：'+c.model);
  console.log('本地桥密钥文件（请勿转发）：'+keyfile);
  if(showKey)console.log('本地桥 API Key：'+c.apiKey);
  console.log('Claude 设置：'+m.settings);
}
async function health(target) {
  const c=json(path.join(target,'connection.json'));
  return await new Promise(resolve=>{
    const req=http.get(c.baseUrl+'/health',{timeout:2500},res=>{
      let body='';res.on('data',c=>body+=c);res.on('end',()=>{
        try{resolve(res.statusCode===200&&JSON.parse(body).status==='ok');}catch{resolve(false);}
      });
    });
    req.on('timeout',()=>{req.destroy();resolve(false);});req.on('error',()=>resolve(false));
  });
}
async function install(options) {
  const bundled=options['bundled-runtime']?path.resolve(options['bundled-runtime']):null;
  checkTools(bundled);
  const settings=path.resolve(options.settings||path.join(os.homedir(),'.claude','settings.json'));
  const target=safeTarget(options.dir||path.join(os.homedir(),'.local','share','ccr-bridge-kit'),settings);
  if(exists(target)){
    if(options.guiConfig)throw guiError('RUNTIME_CONFLICT');
    const m=loadManifest(target);
    managedIntact(target,m);
    if(m.settings!==settings)throw new Error('重复安装不能更换 settings 路径。');
    if(options.config||options.port)throw new Error('重复安装不会覆盖现有密钥/端口；如需重配，请先卸载并备份自己的配置。');
    const original=readSettings(settings),merged=mergeHook(original,target);
    if(m.service){registration.register(m.service.home,target,Number(fs.readFileSync(path.join(target,'port'),'utf8').trim()),m.service.instanceId);}
    fs.rmSync(path.join(target,'disabled'),{force:true});
    if(!same(original,merged)){if(exists(settings))backup(settings);atomic(settings,JSON.stringify(merged,null,2)+'\n');}
    console.log('已安装，文件与配置均未覆盖。');
    showConnection(target);
    if(options.start){const r=run('bash',[path.join(target,'start-bridge.sh')],{env:cleanEnv(),timeout:110000,stdio:'inherit'});if(r.status!==0)throw new Error('启动失败，请查看安装目录中的日志。');}
    return;
  }
  const original=readSettings(settings);
  mergeHook(original,target); // 提前验证已有 hook，不要装到一半才发现冲突。
  const service=bundled?{schema:1,home:path.resolve(os.homedir()),instanceId:crypto.randomBytes(16).toString('hex')}:null;
  if(service&&registration.read(service.home))throw new Error('已有本地桥服务注册，未覆盖；请先处理原安装。');
  let port=options.port===undefined?undefined:Number(options.port);
  let config;
  if(options.guiConfig){
    config=options.guiConfig;
  }else if(options.config){
    const p=path.resolve(options.config);
    config=json(p);
    if(port===undefined&&config.port!==undefined)port=Number(config.port);
  }else{
    if(!process.stdin.isTTY)throw new Error('非交互安装需要 --config 指向私有 JSON 配置；不要把 API Key 写进命令行。');
    config={endpoint:await ask('上游完整 OpenAI Chat Completions URL（含路径）'),apiKey:await askSecret(),model:await ask('模型名')};
  }
  port??=await choosePort();
  config=validateConfig(config,port);
  if(!await portFree(port))throw new Error('端口已占用：'+port+'；请改用 --port。');
  if(!options.quiet){
    console.log('安装目录：'+target);
    console.log(bundled?'将复制组件内固定版本 CCR 1.0.73 到专用运行目录；不联网安装、不测试远端模型。':'将联网从 npm 下载固定版本 CCR 1.0.73；不向模型服务发送测试请求。');
  }
  if(!options.yes){
    if(!process.stdin.isTTY)throw new Error('非交互安装还需要 --yes。');
    if((await ask('继续安装？输入 yes'))!=='yes')throw new Error('已取消，未修改设置。');
  }
  fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  const stage=fs.mkdtempSync(path.join(path.dirname(target),'.ccr-kit-stage-'));
  let deployed=false;
  try{
    for(const name of RUNTIME_FILES)fs.copyFileSync(path.join(SOURCE,'runtime',name),path.join(stage,name));
    for(const name of ['package.json','package-lock.json'])fs.copyFileSync(path.join(SOURCE,name),path.join(stage,name));
    fs.copyFileSync(__filename,path.join(stage,'manage.cjs'));
    for(const [file,cmd] of [['stop.sh','stop'],['uninstall.sh','uninstall'],['status.sh','status']])atomic(path.join(stage,file),wrapper(target,cmd),0o700);
    for(const name of ['LICENSE-CCR.txt','LICENSE','README.md'])if(exists(path.join(SOURCE,name)))fs.copyFileSync(path.join(SOURCE,name),path.join(stage,name));
    if(bundled){
      copyBundledRuntime(bundled,stage);
    }else{
      const npm=run('npm',['ci','--ignore-scripts','--omit=dev','--no-audit','--no-fund','--loglevel=error'],{cwd:stage,timeout:300000,stdio:'inherit',env:cleanEnv()});
      if(npm.status!==0)throw new Error('npm 依赖安装失败，未修改 Claude 设置。');
    }
    const pkg=json(path.join(stage,'node_modules/@musistudio/claude-code-router/package.json'));
    if(pkg.version!==CCR_VERSION)throw new Error('CCR 版本不匹配。');
    const patch=run(process.execPath,[path.join(stage,'patch-ccr.js')],{timeout:20000});
    if(![0,2].includes(patch.status))throw new Error('补丁应用失败，未修改 Claude 设置：'+patch.stderr);
    const state=path.join(stage,'runtime-home','.claude-code-router');
    const localKey=crypto.randomBytes(24).toString('hex');
    atomic(path.join(stage,'port'),String(port)+'\n');
    atomic(path.join(state,'config.json'),JSON.stringify(routerConfig(config,port,localKey),null,2)+'\n');
    atomic(path.join(stage,'connection.json'),JSON.stringify({baseUrl:'http://127.0.0.1:'+port,apiKey:localKey,model:config.model},null,2)+'\n');
    const files={};
    for(const name of [...RUNTIME_FILES,'manage.cjs','stop.sh','uninstall.sh','status.sh','package.json','package-lock.json','port']){
      const p=path.join(stage,name);fs.chmodSync(p,name.endsWith('.sh')?0o700:0o600);files[name]=sha(fs.readFileSync(p));
    }
    const current=readSettings(settings);
    if(!same(current,original))throw new Error('安装期间 Claude 设置被其他程序修改，已停止，未覆盖。');
    const merged=mergeHook(current,target);
    if(options.guiBeforeDeploy)options.guiBeforeDeploy();
    const saved=exists(settings)?backup(settings):null;
    atomic(path.join(stage,MARKER),JSON.stringify({id:'ccr-bridge-kit',version:VERSION,target,settings,settingsBackup:saved,componentEntry:path.join(SOURCE,'component.cjs'),hook:hookEntry(target),service,files,...(options.guiConfig?{guiManaged:true}:{})},null,2)+'\n');
    if(options.guiBeforeDeploy)options.guiBeforeDeploy();
    fs.renameSync(stage,target);deployed=true;
    if(service){
      if(options.guiRegister)options.guiRegister(service,target,port);
      else registration.register(service.home,target,port,service.instanceId);
    }
    try{atomic(settings,JSON.stringify(merged,null,2)+'\n');}
    catch(e){throw new Error('安装文件已保留，但钩子写入失败；修正权限后重新执行安装器即可。'+e.message);}
    if(!options.quiet){
      console.log('安装完成；已合并 SessionStart 钩子，未修改客户端全局认证。');
      showConnection(target);
      console.log('先在 App/客户端中填写上述本机服务地址、自己的模型和本地桥密钥，再开始新会话。');
    }
    if(options.start){
      const r=run('bash',[path.join(target,'start-bridge.sh')],{env:cleanEnv(),timeout:110000,stdio:'inherit'});
      if(r.status!==0)throw new Error('文件已安装，但启动失败；请查看 '+path.join(target,'runtime-home','.claude-code-router','bridge.out'));
      console.log('本地桥健康检查通过。');
    }else if(!options.quiet)console.log('下次会话自动启动；也可运行 bash '+quote(path.join(target,'start-bridge.sh')));
  }finally{
    if(!deployed&&exists(stage))fs.rmSync(stage,{recursive:true,force:true});
  }
}
const GUI_MESSAGES={INVALID_INPUT:'请检查 API 地址、API Key 和模型名称。',KEY_REQUIRED:'首次配置需要 API Key。',KEY_HOST_CHANGED:'更换服务地址来源后必须重新输入 API Key。',RUNTIME_CONFLICT:'已有安装不符合图形配置安全约定；未覆盖，请先处理原安装。',BUSY:'桥配置正在使用，请稍后重试。',MODELS_AUTH:'API Key 未通过验证，可检查后重试或手填模型。',MODELS_FORBIDDEN:'服务拒绝读取模型清单，可手填模型。',MODELS_NOT_FOUND:'服务未提供兼容的模型清单，可手填模型。',MODELS_RATE_LIMIT:'读取模型清单过于频繁，请稍后重试或手填模型。',MODELS_TIMEOUT:'读取模型清单超时，可重试或手填模型。',MODELS_NETWORK:'无法安全连接模型清单服务，可重试或手填模型。',MODELS_INVALID_RESPONSE:'模型清单格式不兼容，可手填模型。',MODELS_TOO_LARGE:'模型清单响应过大，可手填模型。',MODELS_REDIRECT:'为保护 API Key，未跟随模型清单重定向；请检查 API 地址。',MODELS_FAILED:'读取模型清单失败，可重试或手填模型。'};
function guiError(code){const error=new Error(GUI_MESSAGES[code]||GUI_MESSAGES.RUNTIME_CONFLICT);error.guiCode=code;return error;}
function guiPaths(){
  const home=path.resolve(os.homedir()),target=path.join(home,'.local/share/ccr-bridge-kit'),settings=path.join(home,'.claude/settings.json');
  if(fs.realpathSync(home)!==home)throw guiError('RUNTIME_CONFLICT');
  const canonical=file=>{let parent=file;while(!exists(parent))parent=path.dirname(parent);if(fs.realpathSync(parent)!==parent)throw guiError('RUNTIME_CONFLICT');};
  canonical(target);canonical(settings);canonical(path.dirname(registration.fileOf(home)));
  safeTarget(target,settings);
  return {home,target,settings};
}
function scrubGuiEnv(){
  // 配置/启动不继承会话代理和外部桥调参，防止状态探测或子进程走到非本机目标。
  for(const name of Object.keys(process.env))if(/^(ANTHROPIC_|CLAUDE_|CCAPP_|CCR_BRIDGE_)/.test(name)||/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SERVICE_PORT)$/.test(name))delete process.env[name];
}
function normalizeGuiEndpoint(input){
  if(typeof input!=='string'||input.length>2048||/[\u0000- \u007f\\]/.test(input))throw guiError('INVALID_INPUT');
  let url;try{url=new URL(input);}catch{throw guiError('INVALID_INPUT');}
  if(url.username||url.password||url.search||url.hash||url.protocol!=='https:')throw guiError('INVALID_INPUT');
  const pathname=url.pathname.replace(/\/+$/,'');
  if(!pathname||pathname==='/v1')url.pathname='/v1/chat/completions';
  else if(pathname.endsWith('/chat/completions'))url.pathname=pathname;
  else throw guiError('INVALID_INPUT');
  return url.href;
}
async function guiInput(command){
  let size=0;const chunks=[],models=command==='gui-models';
  try{
    for await(const chunk of process.stdin){size+=chunk.length;if(size>16384)throw guiError('INVALID_INPUT');chunks.push(chunk);}
    const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!object(input)||Object.keys(input).some(k=>!(models?['endpoint','apiKey']:['endpoint','apiKey','model']).includes(k))||typeof input.endpoint!=='string'||!models&&typeof input.model!=='string'||input.apiKey!==undefined&&typeof input.apiKey!=='string')throw guiError('INVALID_INPUT');
    const apiKey=(input.apiKey||'').trim();
    if((input.apiKey||'').length>1024||/[\u0000- \u007f]/.test(input.apiKey||''))throw guiError('INVALID_INPUT');
    const endpoint=normalizeGuiEndpoint(input.endpoint);
    if(models)return {endpoint,apiKey};
    const model=input.model.trim();
    if(!model||input.model.length>200||/[,\u0000-\u001f\u007f]/.test(input.model))throw guiError('INVALID_INPUT');
    return {endpoint,apiKey,model};
  }catch(error){if(error.guiCode)throw error;throw guiError('INVALID_INPUT');}
}
function checkGuiRuntime(paths,previous=null,allowConfiguring=false){
  const {home,target,settings}=paths;
  if(!exists(target)){
    if(registration.read(home))throw guiError('RUNTIME_CONFLICT');
    return null;
  }
  if(regularFile(path.join(target,MARKER)).size>65536)throw guiError('RUNTIME_CONFLICT');
  const portStat=regularFile(path.join(target,'port'));
  if(portStat.size>6)throw guiError('RUNTIME_CONFLICT');
  const m=loadManifest(target),portText=fs.readFileSync(path.join(target,'port'),'utf8');
  const options={endpoint:'http://127.0.0.1:'+Number(portText),instance:m.service?.instanceId};
  instanceOptions('ensure',options);
  const instance=checkInstance(target,options,previous?.instance);
  const disabled=path.join(target,'disabled');
  if(m.guiManaged!==true||m.settings!==settings||m.componentEntry!==path.join(SOURCE,'component.cjs'))throw guiError('RUNTIME_CONFLICT');
  if(exists(disabled)){
    regularFile(disabled);
    if(!allowConfiguring||fs.readFileSync(disabled,'utf8')!=='configuring\n')throw guiError('RUNTIME_CONFLICT');
  }
  for(const name of RUNTIME_FILES){
    regularFile(path.join(SOURCE,'runtime',name));
    if(m.files[name]!==sha(fs.readFileSync(path.join(SOURCE,'runtime',name))))throw guiError('RUNTIME_CONFLICT');
  }
  // GUI 仅接管本组件完整且当前兼容的 bundled 运行副本，绝不覆盖手工/旧版本脚本。
  const configPath=path.join(target,'runtime-home/.claude-code-router/config.json'),connectionPath=path.join(target,'connection.json');
  for(const dir of [path.dirname(configPath),path.join(target,'runtime-home')])if(fs.realpathSync(dir)!==dir)throw guiError('RUNTIME_CONFLICT');
  for(const file of [configPath,connectionPath]){
    const stat=regularFile(file);
    if((stat.mode&0o077)!==0||stat.size>16384)throw guiError('RUNTIME_CONFLICT');
  }
  const configText=fs.readFileSync(configPath,'utf8'),connectionText=fs.readFileSync(connectionPath,'utf8');
  const config=JSON.parse(configText),connection=JSON.parse(connectionText);
  if(!object(config)||!object(connection)||!Array.isArray(config.Providers)||config.Providers.length!==1)throw guiError('RUNTIME_CONFLICT');
  const provider=config.Providers[0],model=connection.model;
  if(typeof model!=='string'||!model||model.length>200||/[,\u0000-\u001f\u007f]/.test(model)||typeof provider?.api_key!=='string'||provider.api_key.length>1024||/[\u0000- \u007f]/.test(provider.api_key))throw guiError('RUNTIME_CONFLICT');
  let endpoint;try{endpoint=normalizeGuiEndpoint(provider?.api_base_url);}catch{throw guiError('RUNTIME_CONFLICT');}
  const validated=validateConfig({endpoint,apiKey:provider.api_key,model},instance.port);
  if(endpoint!==provider.api_base_url||connection.baseUrl!==options.endpoint||typeof connection.apiKey!=='string'||!/^[0-9a-f]{48}$/.test(connection.apiKey)||!same(config,routerConfig(validated,instance.port,connection.apiKey)))throw guiError('RUNTIME_CONFLICT');
  if(previous&&(previous.configText!==configText||previous.connectionText!==connectionText))throw guiError('RUNTIME_CONFLICT');
  return {instance,options,configPath,connectionPath,configText,connectionText,endpoint,model,apiKey:validated.apiKey,localKey:connection.apiKey};
}
async function guiLocalReady(target,port){
  // 不再读取可变 connection.baseUrl；只探测已验证端口的字面量回环 /health。
  const r=run('bash',['-c','source "$1/bridge-common.sh" || exit 1; bridge_pid >/dev/null','bridge-gui-health',target],{env:cleanEnv(),timeout:3000});
  if(r.status!==0)return false;
  return await new Promise(resolve=>{
    const req=http.get({hostname:'127.0.0.1',port,path:'/health',timeout:1500,agent:false},res=>{
      let body='';res.on('data',chunk=>{body+=chunk;if(body.length>4096){req.destroy();resolve(false);}});
      res.on('error',()=>resolve(false));res.on('end',()=>{try{resolve(res.statusCode===200&&JSON.parse(body).status==='ok');}catch{resolve(false);}});
    });
    req.on('timeout',()=>{req.destroy();resolve(false);});req.on('error',()=>resolve(false));
  });
}
async function guiStatus(){
  const paths=guiPaths(),current=checkGuiRuntime(paths);
  if(!current)return {schema:1,id:'openai-bridge',configured:false,endpoint:'',model:'',hasKey:false,localReady:false};
  const localReady=await guiLocalReady(paths.target,current.instance.port);
  checkGuiRuntime(paths,current);
  return {schema:1,id:'openai-bridge',configured:true,endpoint:current.endpoint,model:current.model,hasKey:true,localReady};
}
function guiLock(paths,fn){
  const dir=path.dirname(registration.fileOf(paths.home));
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,'openai-bridge.lock');
  if(!exists(file)){
    const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd);
  }
  return withInstanceLock({home:paths.home},fn);
}
async function guiConfigure(input){
  const paths=guiPaths(),current=checkGuiRuntime(paths);
  let key=input.apiKey;
  if(!key){
    if(!current)throw guiError('KEY_REQUIRED');
    if(new URL(input.endpoint).origin!==new URL(current.endpoint).origin)throw guiError('KEY_HOST_CHANGED');
    key=current.apiKey;
  }
  let config;try{config=validateConfig({...input,apiKey:key},current?.instance.port||3459);}catch{throw guiError('INVALID_INPUT');}
  return await guiLock(paths,async checkLock=>{
    const recheck=previous=>{checkLock();guiPaths();return checkGuiRuntime(paths,previous);};
    const checked=recheck(current);
    if(!!checked!==!!current)throw guiError('RUNTIME_CONFLICT');
    if(!current){
      await install({dir:paths.target,settings:paths.settings,'bundled-runtime':SOURCE,guiConfig:config,quiet:true,yes:true,
        guiBeforeDeploy:()=>{if(recheck(null)!==null)throw guiError('RUNTIME_CONFLICT');},
        guiRegister:(service,target,port)=>{
          checkLock();if(registration.read(paths.home))throw guiError('RUNTIME_CONFLICT');
          atomic(registration.fileOf(paths.home),JSON.stringify(registration.value(target,port,service.instanceId),null,2)+'\n');
        }});
    }else if(current.endpoint!==config.endpoint||current.model!==config.model||current.apiKey!==config.apiKey){
      readSettings(paths.settings,true);
      const nextConfigText=JSON.stringify(routerConfig(config,current.instance.port,current.localKey),null,2)+'\n';
      const nextConnectionText=JSON.stringify({baseUrl:current.options.endpoint,apiKey:current.localKey,model:config.model},null,2)+'\n';
      const recoveryFault=path.join(paths.target,'runtime-home/.claude-code-router/recovery.failed'),hadRecoveryFault=exists(recoveryFault);
      recheck(current);atomic(path.join(paths.target,'disabled'),'configuring\n');
      // disabled 阻止本安装 Hook/看护重启；只停止已核对的同一服务实例。
      try{
        checkLock();checkGuiRuntime(paths,current,true);stopManaged(paths.target);
        checkLock();checkGuiRuntime(paths,current,true);
        // 看护可能将本次临时 disabled 记为故障；只清除此操作刚产生的精确标记，不重置既有恢复预算。
        if(!hadRecoveryFault&&exists(recoveryFault)&&regularFile(recoveryFault)&&fs.readFileSync(recoveryFault,'utf8')==='component removed or disabled\n')fs.rmSync(recoveryFault);
        atomic(current.configPath,nextConfigText);
        checkLock();checkInstance(paths.target,current.options,current.instance);
        atomic(current.connectionPath,nextConnectionText);
        checkLock();checkGuiRuntime(paths,null,true);
        fs.rmSync(path.join(paths.target,'disabled'));
      }catch(error){
        // 只回滚仍属于同一实例的本次写入；身份变化时保留 tombstone，绝不追着新实例写。
        try{
          checkLock();checkInstance(paths.target,current.options,current.instance);
          regularFile(current.configPath);regularFile(current.connectionPath);
          const actualConfig=fs.readFileSync(current.configPath,'utf8'),actualConnection=fs.readFileSync(current.connectionPath,'utf8');
          if(![current.configText,nextConfigText].includes(actualConfig)||![current.connectionText,nextConnectionText].includes(actualConnection))throw guiError('RUNTIME_CONFLICT');
          atomic(current.configPath,current.configText);atomic(current.connectionPath,current.connectionText);
          checkGuiRuntime(paths,current,true);fs.rmSync(path.join(paths.target,'disabled'));
        }catch{}
        throw error;
      }
    }
    let configured=recheck(null),localReady=false;
    // 配置落盘不代表远端可用。本机启动失败也保留已保存配置并明确 localReady:false。
    try{
      const r=run('bash',[path.join(paths.target,'start-bridge.sh')],{env:cleanEnv(),timeout:70000});
      configured=recheck(configured);
      localReady=r.status===0&&await guiLocalReady(paths.target,configured.instance.port);
    }catch(error){if(error.guiCode)throw error;}
    recheck(configured);
    return {schema:1,id:'openai-bridge',configured:true,endpoint:configured.endpoint,model:configured.model,hasKey:true,localReady,connectionPath:configured.connectionPath,...(!localReady?{localError:'LOCAL_START_FAILED'}:{})};
  });
}
async function guiModels(input){
  // 读取清单不保存配置、不探测/启动本地桥。只有未输入新 Key 时才读取已验证的 GUI 私有配置。
  try{
    return await require('./gui-models.cjs').listModels(input,{resolveSavedKey(endpoint){
      const paths=guiPaths(),current=checkGuiRuntime(paths);
      if(!current)throw guiError('KEY_REQUIRED');
      if(new URL(endpoint).origin!==new URL(current.endpoint).origin)throw guiError('KEY_HOST_CHANGED');
      checkGuiRuntime(paths,current);
      return current.apiKey;
    }});
  }finally{input.apiKey='';}
}
async function gui(command,args){
  process.umask(0o077);
  scrubGuiEnv();
  try{
    if(args.length)throw guiError('INVALID_INPUT');
    const result=command==='gui-models'?await guiModels(await guiInput(command)):command==='gui-configure'?await guiConfigure(await guiInput(command)):await guiStatus();
    console.log(JSON.stringify(result));
  }catch(error){
    const requested=error.guiCode||(error.message?.includes('正在使用')?'BUSY':'RUNTIME_CONFLICT');
    const code=Object.hasOwn(GUI_MESSAGES,requested)?requested:'RUNTIME_CONFLICT';
    console.error(JSON.stringify({schema:1,id:'openai-bridge',error:{code,message:GUI_MESSAGES[code]}}));process.exitCode=1;
  }
}
function purgeTarget(target) {
  if(fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target)!==target)throw new Error('清理目标或父路径有符号链接，拒绝删除。');
  if(!target.startsWith(path.resolve(os.homedir())+path.sep) && !target.startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('清理目标必须位于私有 HOME 或临时目录的专用子目录。');
  const manifest=loadManifest(target);
  safeTarget(target,path.resolve(manifest.settings));
  return target;
}
async function confirmStop(target,options) {
  if(options.yes)return;
  if(!process.stdin.isTTY)throw new Error('此操作可能打断请求，需 --yes 或交互确认。');
  const message=options.purge?'将停止此安装并永久删除整个专用目录（含密钥、配置和日志）：'+target+'。输入 yes':'将停止此安装的看护和桥，可能打断请求。输入 yes';
  if((await ask(message))!=='yes')throw new Error('已取消。');
}
function stopManaged(target,context=null) {
  // 固定组件内联的停止协议。无论 manifest 如何自报 hash，绝不 source/exec 私有代码。
  const baseline=stopMetadata(target),manifest=JSON.parse(instanceFile(path.join(target,MARKER),65536).data),port=instancePort(target);
  if(manifest?.id!=='ccr-bridge-kit'||manifest.version!==VERSION||manifest.target!==target)throw new Error('停止目标不是规范的受管理实例。');
  const registryFile=registration.fileOf(path.resolve(os.homedir()));
  const registry=exists(registryFile)?instanceFile(registryFile,4096).data:null;
  let startLock,serviceLock;
  const recheck=()=>{
    if(context)context.recheck();
    if(startLock)startLock.check();if(serviceLock)serviceLock.check();
    const current=stopMetadata(target);
    if(current.stats.some((st,i)=>!sameFile(st,baseline.stats[i]))||!same(JSON.parse(instanceFile(path.join(target,MARKER),65536).data),manifest)||instancePort(target)!==port)throw new Error('停止期间实例身份已变更。');
    const now=exists(registryFile)?instanceFile(registryFile,4096).data:null;
    if(registry===null?now!==null:now===null||!registry.equals(now))throw new Error('停止期间服务注册已变更。');
  };
  const state=baseline.state;
  const procFile=(pid,name,limit)=>{
    const fd=fs.openSync('/proc/'+pid+'/'+name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{
      const buffer=Buffer.alloc(limit+1);let size=0,n;
      while(size<buffer.length&&(n=fs.readSync(fd,buffer,size,buffer.length-size,null))>0)size+=n;
      if(size>limit)throw new Error('进程身份信息过大，拒绝停止。');
      return buffer.subarray(0,size).toString('utf8');
    }finally{fs.closeSync(fd);}
  };
  const executable=file=>{
    const real=fs.realpathSync(file),stat=fs.statSync(real);
    if(!stat.isFile())throw new Error('停止工具不是普通可执行文件。');
    fs.accessSync(real,fs.constants.X_OK);
    return {real,stat};
  };
  const nodeExecutable=executable(process.execPath);let bashExecutable;
  const trustedBash=()=>{
    if(bashExecutable)return bashExecutable;
    for(const dir of (process.env.PATH||'').split(path.delimiter)){
      const file=path.resolve(dir||'.','bash');
      try{bashExecutable=executable(file);return bashExecutable;}
      catch(error){if(!['ENOENT','ENOTDIR','EACCES'].includes(error.code))throw error;}
    }
    throw new Error('无法解析可信 Bash 停止工具。');
  };
  const processIdentity=(pid,kind)=>{
    try{
      const stat=procFile(pid,'stat',4096),end=stat.lastIndexOf(') '),fields=stat.slice(end+2).trim().split(/\s+/);
      if(end<0||!/^\d+$/.test(fields[19]||''))throw new Error('进程身份信息不合法。');
      if(fields[0]==='Z'||fields[0]==='X')return null;
      const args=procFile(pid,'cmdline',65536).split('\0');if(args.at(-1)==='')args.pop();
      let matches;
      if(kind==='watchdog')matches=args.length===2&&path.basename(args[0])==='bash'&&args[1]===path.join(target,'watchdog.sh');
      else{
        const cli='node_modules/@musistudio/claude-code-router/dist/cli.js';
        matches=args.length===3&&path.basename(args[0])==='node'&&args[2]==='start'&&(args[1]===path.join(target,cli)||args[1]===cli&&fs.readlinkSync('/proc/'+pid+'/cwd')===target);
      }
      if(!matches)return null;
      // argv[0] 可任意伪装；真实 /proc/PID/exe 必须属于固定解析的解释器。
      const expected=kind==='watchdog'?trustedBash():nodeExecutable,exe='/proc/'+pid+'/exe';
      if(fs.realpathSync(exe)!==expected.real||!sameFile(fs.statSync(exe),expected.stat)||!sameFile(fs.statSync(expected.real),expected.stat))return null;
      return {pid,stamp:fields[19]};
    }catch(error){if(['ENOENT','ESRCH'].includes(error.code))return null;throw error;}
  };
  const stillSame=(identity,kind)=>{
    const current=processIdentity(identity.pid,kind);
    if(current&&current.stamp!==identity.stamp)throw new Error('停止期间 PID 已复用，拒绝发送信号。');
    return !!current;
  };
  const signal=(identity,kind,name)=>{
    recheck();
    if(!stillSame(identity,kind))return;
    recheck(); // /proc 身份读取之后也不能沿用先前注册，发送信号是独立副作用。
    if(!stillSame(identity,kind))return;
    try{process.kill(identity.pid,name);}catch(error){if(error.code!=='ESRCH')throw error;}
  };
  const wait=(identity,kind,rounds)=>{
    for(let i=0;i<rounds;i++){
      if(!stillSame(identity,kind))return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
    }
    return !stillSame(identity,kind);
  };
  const removePid=(file,pid)=>{
    recheck();if(!exists(file)||instancePid(file)!==pid)return;
    const dir=openInstanceDirectory(path.dirname(file));
    try{recheck();dir.check();if(instancePid(file)===pid){recheck();dir.check();fs.unlinkSync(dir.at(path.basename(file)));}}
    finally{fs.closeSync(dir.fd);}
  };
  const acquire=(lock,seconds)=>{
    recheck();lock.check();
    const result=run('flock',['-w',String(seconds),'3'],{stdio:['ignore','ignore','pipe',lock.fd],timeout:(seconds+1)*1000});
    lock.check();recheck();
    if(result.status!==0)throw new Error('等待实例停止锁超时，运行文件与钩子保留。');
  };
  const probeWatchdog=()=>{
    const file=path.join(state,'watchdog.lock');if(!exists(file))throw new Error('看护 PID 缺少对应锁，拒绝停止。');
    const lock=openInstanceLock(file,false,recheck);
    try{
      recheck();lock.check();
      const result=run('flock',['-n','3'],{stdio:['ignore','ignore','pipe',lock.fd],timeout:2000});
      lock.check();recheck();
      if(result.status!==0&&result.status!==1)throw new Error('无法核对看护锁。');
      return result.status===1;
    }finally{lock.close();}
  };
  try{
    recheck();
    // 与既有 start 一致的锁顺序；服务锁先安全打开，任何坏锁都不能先触发 kill。
    startLock=openInstanceLock(path.join(state,'start.lock'),true,recheck);
    acquire(startLock,10);
    serviceLock=openInstanceLock(path.join(state,'service.lock'),true,recheck);
    const watchdogPidFile=path.join(state,'watchdog.pid'),watchdogPid=instancePid(watchdogPidFile);
    if(watchdogPid){
      const identity=processIdentity(watchdogPid,'watchdog');
      if(identity){
        if(!probeWatchdog())throw new Error('看护身份与锁不一致，拒绝停止。');
        recheck();signal(identity,'watchdog','SIGTERM');
        if(!wait(identity,'watchdog',80))throw new Error('未能在限定时间内安全停止看护。');
        recheck();removePid(watchdogPidFile,watchdogPid);
      }
    }
    acquire(serviceLock,10);
    const pidFile=path.join(state,'.claude-code-router.pid'),pid=instancePid(pidFile);
    if(pid){
      const identity=processIdentity(pid,'bridge');
      if(identity){
        recheck();signal(identity,'bridge','SIGTERM');
        if(!wait(identity,'bridge',40)){
          recheck();signal(identity,'bridge','SIGKILL');
          if(!wait(identity,'bridge',10))throw new Error('未能在限定时间内安全停止桥。');
        }
        recheck();removePid(pidFile,pid);
      }
    }
    recheck();
  }finally{if(serviceLock)serviceLock.close();if(startLock)startLock.close();}
}
function instanceSettings(file) {
  instanceDirectory(path.dirname(file));
  const read=exists(file)?instanceFile(file):null,value=read?JSON.parse(read.data):{};
  if(!object(value)||value.hooks!==undefined&&!object(value.hooks)||value.hooks?.SessionStart!==undefined&&!Array.isArray(value.hooks.SessionStart))throw new Error('Claude 设置结构不合法，未修改。');
  return {value,read};
}
function instanceAtomic(file,content,recheck) {
  const dir=openInstanceDirectory(path.dirname(file)),temp=dir.at('.kit-'+crypto.randomUUID()+'.tmp');
  let created=false;
  try{
    recheck();dir.check();
    fs.writeFileSync(temp,content,{flag:'wx',mode:0o600});created=true;
    recheck();dir.check();
    fs.renameSync(temp,dir.at(path.basename(file)));created=false;
  }finally{if(created)fs.unlinkSync(temp);fs.closeSync(dir.fd);}
}
function uninstallInstance(target,options,instance) {
  return withInstanceLock(instance,checkLock=>{
    let registered=true;
    const recheck=()=>{checkLock();return checkInstance(target,options,instance,registered);};
    // 交互确认和锁等待后重新核对，后续每个副作用也不能沿用初次读到的注册。
    recheck();const settings=instance.manifest.settings,before=instanceSettings(settings);
    const settingsUnchanged=()=>{
      recheck();const now=instanceSettings(settings);
      if(before.read?(!now.read||!sameFile(before.read.stat,now.read.stat)||!before.read.data.equals(now.read.data)):now.read)throw new Error('卸载期间 Claude 设置已变更，未覆盖。');
    };
    instanceAtomic(path.join(target,'disabled'),'uninstalled\n',settingsUnchanged);
    recheck();stopManaged(target,{recheck});
    settingsUnchanged();const after=removeHook(before.value,target);
    // 已持有注册锁且完整核对 endpoint/port；不可重入旧 unregister 或忽略其 false。
    const dir=openInstanceDirectory(path.dirname(registration.fileOf(instance.home)));
    try{settingsUnchanged();dir.check();fs.unlinkSync(dir.at(path.basename(registration.fileOf(instance.home))));registered=false;}
    finally{fs.closeSync(dir.fd);}
    if(!same(before.value,after)){
      if(before.read){
        const backupFile=settings+'.bridge-kit-backup-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex');
        const settingsDir=openInstanceDirectory(path.dirname(settings));
        try{settingsUnchanged();settingsDir.check();fs.writeFileSync(settingsDir.at(path.basename(backupFile)),before.read.data,{flag:'wx',mode:0o600});}
        finally{fs.closeSync(settingsDir.fd);}
      }
      instanceAtomic(settings,JSON.stringify(after,null,2)+'\n',settingsUnchanged);
    }
    recheck();
    console.log('已停止并移除本安装的钩子，其他配置未动。');
    if(options.purge){
      purgeTarget(target);
      const parent=openInstanceDirectory(path.dirname(target));
      try{recheck();parent.check();fs.rmSync(parent.at(path.basename(target)),{recursive:true});}
      finally{fs.closeSync(parent.fd);}
      console.log('已删除整个专用安装目录（含依赖、密钥、配置和日志）：'+target);
    }else console.log('安装目录和密钥保留：'+target+'；如需永久删除，确认备份后使用 uninstall --yes --purge。');
  });
}
async function manage(command,options) {
  const scoped=instanceOptions(command,options);
  const target=path.resolve(options.dir||SOURCE);
  const m=loadManifest(target);
  const instance=scoped?checkInstance(target,options):null;
  if(options.purge){
    if(command!=='uninstall')throw new Error('--purge 只适用于 uninstall。');
    purgeTarget(target);
  }
  if(command==='ensure'){
    if(exists(path.join(target,'disabled')))throw new Error('本地桥未注册或已停用。');
    for(const name of RUNTIME_FILES){
      const expected=path.join(SOURCE,'runtime',name),actual=path.join(target,name);
      if(!exists(expected)||sha(fs.readFileSync(expected))!==sha(fs.readFileSync(actual)))throw new Error('自动启动契约要求匹配的组件与私有运行版本；未执行旧运行脚本。');
    }
    checkInstance(target,options,instance);
    const r=run('bash',[path.join(target,'start-bridge.sh')],{env:cleanEnv(),timeout:70000});
    if(r.status!==0)throw new Error('本地桥启动失败或恢复次数已达上限，请检查运行状态。');
    checkInstance(target,options,instance);
    if(exists(path.join(target,'disabled')))throw new Error('就绪期间本地桥被停用。');
    console.log(JSON.stringify({schema:1,id:'openai-bridge',ready:true,endpoint:options.endpoint,instanceId:m.service.instanceId}));
    return;
  }
  if(command==='connection'){showConnection(target,options['show-key']);return;}
  if(command==='status'){
    console.log('安装版本：'+m.version+' / CCR '+CCR_VERSION);
    console.log('本地 HTTP 健康：'+(await health(target)?'正常（不代表上游推理成功）':'未运行或未就绪'));
    const fault=path.join(target,'runtime-home','.claude-code-router','recovery.failed');
    if(exists(fault))console.log('自动恢复：已停止（达到有限恢复上限）；排查后由使用者显式 start --reset-recovery。');
    showConnection(target);return;
  }
  if(command==='start'){
    if(exists(path.join(target,'disabled')))throw new Error('此安装已卸载停用，请先重新 configure。');
    if(options['reset-recovery']){
      if(!options.yes)throw new Error('重置恢复预算需要 --yes。');
      stopManaged(target);
      for(const name of ['recovery.failed','recovery.attempts'])fs.rmSync(path.join(target,'runtime-home','.claude-code-router',name),{force:true});
    }
    const r=run('bash',[path.join(target,'start-bridge.sh')],{env:cleanEnv(),timeout:110000,stdio:'inherit'});
    if(r.status!==0)throw new Error('启动失败。');return;
  }
  await confirmStop(target,options);
  if(command==='uninstall'&&scoped){uninstallInstance(target,options,instance);return;}
  const stoppedHealthy=command==='stop'&&await health(target);
  if(command==='uninstall'){
    readSettings(m.settings,true);
    atomic(path.join(target,'disabled'),'uninstalled\n');
    if(m.service)registration.unregister(m.service.home,target,m.service.instanceId);
  }
  stopManaged(target);
  if(command==='stop'){
    if(stoppedHealthy)fs.rmSync(path.join(target,'runtime-home','.claude-code-router','recovery.attempts'),{force:true});
    console.log('已停止；SessionStart 钩子仍在，下次会话会重新启动。永久停用请卸载。');return;
  }
  const before=readSettings(m.settings,true);
  const after=removeHook(before,target);
  if(!same(before,after)){if(exists(m.settings))backup(m.settings);atomic(m.settings,JSON.stringify(after,null,2)+'\n');}
  console.log('已停止并移除本安装的钩子，其他配置未动。');
  if(options.purge){
    purgeTarget(target);
    fs.rmSync(target,{recursive:true});
    console.log('已删除整个专用安装目录（含依赖、密钥、配置和日志）：'+target);
  }else console.log('安装目录和密钥保留：'+target+'；如需永久删除，确认备份后使用 uninstall --yes --purge。');
}
function parse(argv) {
  const out={};
  for(let i=0;i<argv.length;i++){
    const key=argv[i];
    if(!key.startsWith('--'))throw new Error('未知参数：'+key);
    const name=key.slice(2);
    if(Object.hasOwn(out,name))throw new Error('参数不能重复：'+key);
    if(['yes','start','show-key','help','purge','reset-recovery'].includes(name)){out[name]=true;continue;}
    if(!['dir','settings','config','port','bundled-runtime','endpoint','instance'].includes(name)||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('未知或缺值的参数：'+key);
    out[name]=argv[++i];
  }
  return out;
}
async function main() {
  process.umask(0o077);
  const [cmd='install',...argv]=process.argv.slice(2);
  if(['gui-status','gui-configure','gui-models'].includes(cmd)){await gui(cmd,argv);return;}
  const options=parse(argv);
  if(options.help){console.log('用法：bash install.sh [--config 私有JSON] [--port 端口] [--dir 安装目录] [--settings 设置路径] [--yes] [--start]\n管理：node manage.cjs status|start|stop|uninstall|connection --dir 安装目录 [--yes] [--show-key] [--purge（仅卸载，永久删除专用目录）]');return;}
  if(!COMMANDS.has(cmd))throw new Error('未知操作：'+cmd);
  if(options.purge&&cmd!=='uninstall')throw new Error('--purge 只适用于 uninstall。');
  if(options['reset-recovery']&&cmd!=='start')throw new Error('--reset-recovery 只适用于 start。');
  instanceOptions(cmd,options);
  if(cmd==='install')await install(options);else await manage(cmd,options);
}
if(require.main===module)main().catch(e=>{console.error('错误：'+e.message);process.exitCode=1;});
module.exports={atomic,mergeHook,removeHook,validateConfig,routerConfig,readSettings,safeTarget,hookEntry,legacyHookEntry,parse,quote,copyBundledRuntime,purgeTarget,instanceOptions};
