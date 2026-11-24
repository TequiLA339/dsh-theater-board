// Browser face of the DSH plugin. Hand-written in the closure-factory format the
// DSH client module loader expects (window.__ModuleLoader__.load), so the
// package ships without a build step. Only React from the shared module table
// is used.
window.__ModuleLoader__.load({id:`dsh-theater-board`,factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:`Module`});
const React=require("react");const h=React.createElement;
const PANEL_ID='dsh-theater-board.board';
const DEFAULT_PORT=4181;
const LOOPBACK=['127.0.0.1','localhost'];
function BoardIcon({size}){const s=size||20;return h('svg',{width:s,height:s,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinejoin:'round','aria-hidden':true},h('rect',{x:3.5,y:3.5,width:7,height:9,rx:1.5}),h('rect',{x:13.5,y:3.5,width:7,height:5,rx:1.5}),h('rect',{x:13.5,y:11.5,width:7,height:9,rx:1.5}),h('rect',{x:3.5,y:15.5,width:7,height:5,rx:1.5}))}
function boardUrl(port){const host=LOOPBACK.includes(location.hostname)?location.hostname:null;return host?`http://${host}:${port}/`:null}
function makePage(readPort){return function TheaterBoardPage(){
 const port=readPort();const src=boardUrl(port);
 if(!src)return h('div',{style:{padding:32,lineHeight:1.7}},'战区看板只能在本机打开的 DeepSeek Harness 中使用（地址为 127.0.0.1 或 localhost）。');
 return h('iframe',{src,title:'战区经营看板',style:{display:'block',width:'100%',height:'100%',border:0,background:'#fff'}})}}
const inject=['slots'];
function apply(ctx,config){
 const readPort=()=>{try{const v=config&&config.port&&config.port.get();return Number.isInteger(v)?v:DEFAULT_PORT}catch{return DEFAULT_PORT}};
 ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:PANEL_ID},makePage(readPort)));
 ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:PANEL_ID,order:50,label:'战区看板'},BoardIcon));
}
exports.apply=apply;exports.inject=inject;return module.exports}});
