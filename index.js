import { createAdapter } from './adapter.js';
import { mountOptimizer } from './ui.js';
import { installRequestPreview } from './request-preview.js';
import { mountRequestDiff } from './request-diff-ui.js';

export async function init(adapterFactory = createAdapter) {
    if (document.getElementById('wbo-open')) return;
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) { console.warn('[WorldBook Opt] 扩展设置区域不存在'); return; }
    const section = document.createElement('div'); section.className='wbo-settings';
    const heading=document.createElement('h3');heading.textContent='WorldBook Opt · 世界书缓存优化';
    const text=document.createElement('p');text.textContent='逐条对比、手动应用、自动备份。不需要酒馆助手。';
    const button=document.createElement('button');button.type='button';button.id='wbo-open';button.className='wbo-button wbo-open';button.textContent='打开世界书优化器';
    button.addEventListener('click',async()=>{button.disabled=true;try{if(document.querySelector('.wbo-overlay'))return;mountOptimizer(await adapterFactory());}catch(error){console.error('[WorldBook Opt]',error);globalThis.toastr?.error(error.message,'世界书优化器')}finally{button.disabled=false}});
    section.append(heading,text,button);container.append(section);
}
let diagnosticRuntime;
export async function initDiagnostics(factory=installRequestPreview) {
    if(diagnosticRuntime)return diagnosticRuntime;
    const runtime=await factory();diagnosticRuntime=runtime;
    function mountWand(){
        const menu=document.getElementById('extensionsMenu');if(!menu)return false;
        if(!document.getElementById('wbo-request-diff')){
            const container=document.createElement('div');container.className='extension_container';
            const button=document.createElement('button');button.type='button';button.id='wbo-request-diff';button.className='list-group-item wbo-wand-button';
            const icon=document.createElement('i');icon.className='fa-solid fa-magnifying-glass';icon.setAttribute('aria-hidden','true');
            const label=document.createElement('span');label.textContent='请求输入差异（免费预览）';button.append(icon,label);
            button.addEventListener('click',()=>{if(!document.querySelector('.wbo-overlay'))mountRequestDiff(runtime)});
            container.append(button);menu.append(container);
        }
        return true;
    }
    if(!mountWand()){const observer=new MutationObserver(()=>{if(mountWand())observer.disconnect()});observer.observe(document.body,{childList:true,subtree:true});}
    return runtime;
}
function start(){init();if(!document.documentElement.hasAttribute('data-wbo-preview'))initDiagnostics().catch(error=>console.warn('[WorldBook Opt] 请求诊断初始化失败',error));}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
