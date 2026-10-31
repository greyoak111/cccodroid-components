#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const api=require('./installer.cjs');
const [command='help',...args]=process.argv.slice(2);
function run(file,argv){
  const result=spawnSync(process.execPath,[file,...argv],{stdio:'inherit'});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
}
try{
  if(command==='--selftest'){
    if(args.length)throw new Error('selftest 不接受额外参数。');
    run(path.join(__dirname,'runtime/selftest.cjs'),[]);
  }else if(command==='gui-status'||command==='gui-configure'||command==='gui-models'){
    // 图形配置和模型清单只通过继承的 stdin 管道传秘密；不接受 argv 参数，不经旧私有管理器。
    run(path.join(__dirname,'installer.cjs'),[command,...args]);
  }else if(command==='help'||command==='--help'){
    console.log('openai-bridge --selftest | configure | start | status | stop --yes | uninstall --yes [--purge]\nApp 实例操作：ensure | uninstall --dir 目录 --endpoint 本机地址 --instance 实例ID [--yes]\n--endpoint/--instance 必须成对；--purge 会永久删除整个专用目录，含密钥和日志，须另行确认。\nconfigure 请用户自己在终端输入端点和密钥；安全修复范围与未完成的发布验证见源仓库 SECURITY.md。');
  }else if(['configure','start','ensure','status','stop','uninstall'].includes(command)){
    const options=api.parse(args);
    if(options['show-key']||options['bundled-runtime'])throw new Error('组件入口不允许此参数。');
    if(options.purge&&command!=='uninstall')throw new Error('--purge 只适用于 uninstall。');
    const scoped=api.instanceOptions(command,options);
    if(command==='configure'){
      run(path.join(__dirname,'installer.cjs'),['install',...args,'--bundled-runtime',__dirname]);
    }else if(command==='ensure'||(command==='uninstall'&&scoped)){
      const target=path.resolve(options.dir||path.join(os.homedir(),'.local/share/ccr-bridge-kit'));
      // 固定入口必须保留实例核对，不能将新参数交给可能不认识它们的旧 manage.cjs。
      // 当前安装器验证既有 manifest/注册/运行文件后管理它；绝不覆盖私有运行副本。
      const forwarded=options.dir===undefined?[...args,'--dir',target]:args;
      run(path.join(__dirname,'installer.cjs'),[command,...forwarded]);
    }else{
      const target=path.resolve(options.dir||path.join(os.homedir(),'.local/share/ccr-bridge-kit'));
      const marker=path.join(target,'.ccr-bridge-kit.json');
      if(!fs.existsSync(marker))throw new Error('尚未配置此安装。请用户在终端运行 openai-bridge configure。');
      const manifest=JSON.parse(fs.readFileSync(marker,'utf8'));
      if(manifest.id!=='ccr-bridge-kit'||path.resolve(manifest.target)!==target)throw new Error('不是受管理的桥安装。');
      // 手动清理不要求新实例协议；保留旧运行副本自带管理器，不擅自覆盖它。
      const forwarded=options.dir===undefined?[...args,'--dir',target]:args;
      run(path.join(target,'manage.cjs'),[command,...forwarded]);
    }
  }else throw new Error('未知操作；运行 openai-bridge --help 查看用法。');
}catch(error){console.error('错误：'+error.message);process.exitCode=1;}
