import { createAdapter } from './adapter.js';
import { mountOptimizer } from './ui.js';

async function init() {
    if (document.getElementById('wbo-open')) return;
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) { console.warn('[WorldBook Opt] 扩展设置区域不存在'); return; }
    const section = document.createElement('div'); section.className='wbo-settings';
    const heading=document.createElement('h3');heading.textContent='WorldBook Opt · 世界书缓存优化';
    const text=document.createElement('p');text.textContent='逐条对比、手动应用、自动备份。不需要酒馆助手。';
    const button=document.createElement('button');button.type='button';button.id='wbo-open';button.className='menu_button';button.textContent='打开世界书优化器';
    button.addEventListener('click',async()=>{button.disabled=true;try{if(document.querySelector('.wbo-overlay'))return;mountOptimizer(await createAdapter());}catch(error){console.error('[WorldBook Opt]',error);globalThis.toastr?.error(error.message,'世界书优化器')}finally{button.disabled=false}});
    section.append(heading,text,button);container.append(section);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
