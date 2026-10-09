import { analyzeWorldInfo, applyPlan, estimateTokens } from './engine.js';
import { commitWithBackup } from './transaction.js';

function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, handler) { const b = el('button', text, 'wbo-button'); b.type = 'button'; b.addEventListener('click', handler); return b; }
const positions = ['主提示词前', '主提示词后', '作者注释前', '作者注释后', '指定深度', '示例前', '示例后', 'Outlet'];
function state(entry) { return `${entry.disable ? '禁用' : entry.constant ? '蓝灯·常驻' : '绿灯·条件'} · ${positions[entry.position ?? 0] ?? '未知位置'}${Number(entry.position) === 4 ? ` D${entry.depth ?? 4} / ${['系统', '用户', '助手'][entry.role ?? 0] ?? '未知角色'}` : ''} · 顺序 ${entry.order ?? 100} · 冷却 ${entry.cooldown ?? 0}`; }
export function mountOptimizer(adapter, target = document.body) {
    const overlay = el('div', undefined, 'wbo-overlay');
    const panel = el('section', undefined, 'wbo-panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', '世界书缓存优化');
    const header = el('header'); header.append(el('h2', '世界书缓存优化'), button('关闭', () => { if (!busy) { overlay.remove(); opener?.focus(); } }));
    const opener = document.activeElement;
    const description = el('p', '让固定提示词更稳定、动态内容靠后。会改变触发方式及指令位置，不保证缓存命中或节省费用。', 'wbo-muted');
    const warning = el('p', '应用前请关闭世界书编辑器，等待其保存完成；不要同时在其他页面编辑。动态检测是启发式，风险条目默认不选。', 'wbo-warning');
    const toolbar = el('div', undefined, 'wbo-toolbar');
    const bookSelect = el('select'); bookSelect.setAttribute('aria-label', '选择世界书');
    const filter = el('select'); filter.setAttribute('aria-label', '过滤方案');
    for (const [value, label] of [['all','全部条目'],['changed','建议修改'],['risk','风险条目']]) { const o = el('option', label); o.value = value; filter.append(o); }
    const message = el('p', '请选择世界书，然后生成方案。', 'wbo-status'); message.setAttribute('role','status');
    const summary = el('div', undefined, 'wbo-summary');
    const cards = el('div', undefined, 'wbo-cards');
    const confirmation = el('div', undefined, 'wbo-confirm'); confirmation.hidden = true;
    const backupSelect = el('select'); backupSelect.setAttribute('aria-label', '选择备份');
    const backups = el('details', undefined, 'wbo-backups'); backups.append(el('summary', '备份与恢复（当前账号、当前浏览器，最多20份）'));
    const backupTools = el('div', undefined, 'wbo-toolbar');
    let plan = null, baseline = null, cachedBaseline, name = '', selected = new Set(), busy = false, pending = null;
    function status(text, error = false) { message.textContent = text; message.classList.toggle('wbo-error', error); }
    async function run(task) { if (busy) return; busy = true; panel.setAttribute('aria-busy','true'); panel.querySelectorAll('button,select,input').forEach(x=>x.disabled=true); try { await task(); } catch (error) { status(error.message, true); } finally { busy=false; panel.removeAttribute('aria-busy'); panel.querySelectorAll('button,select,input').forEach(x=>x.disabled=false); render(); } }
    function cancel() { pending = null; confirmation.hidden = true; confirmation.replaceChildren(); }
    function reset() { cancel(); plan=null; baseline=null; selected.clear(); cards.replaceChildren(); summary.replaceChildren(); }
    function requestConfirm(text, task) { cancel(); pending=task; confirmation.hidden=false; confirmation.append(el('p',text),button('确认写入世界书',()=>run(async()=>{ const action=pending; cancel(); if(action) await action(); })),button('取消',cancel)); confirmation.scrollIntoView({block:'nearest'}); }
    async function generate() { reset(); name=bookSelect.value; if(!name)throw Error('请先选择世界书'); baseline=structuredClone(await adapter.read(name)); cachedBaseline=structuredClone(adapter.cached(name)); plan=analyzeWorldInfo(baseline); selected=new Set(plan.entries.filter(r=>r.changed&&!r.skipped&&!r.risks.length).map(r=>r.id)); status('方案已生成。正文不会被摘要或压缩；请逐条检查前后差异。'); }
    function render() {
        if (!plan) return;
        summary.replaceChildren();
        const chosen=plan.entries.filter(r=>selected.has(r.id)&&r.changed);
        const next=structuredClone(baseline);
        for (const row of chosen) next.entries[row.id]=structuredClone(row.after);
        const beforeBlue=Object.values(baseline.entries).filter(e=>!e.disable&&e.constant).length;
        const afterBlue=Object.values(next.entries).filter(e=>!e.disable&&e.constant).length;
        summary.append(el('strong',`${plan.entries.length} 条 · 建议修改 ${plan.entries.filter(r=>r.changed).length} · 已选择 ${chosen.length} · 常驻 ${beforeBlue} → ${afterBlue}`));
        const blueTokens=book=>Object.values(book.entries).filter(e=>!e.disable&&e.constant).reduce((sum,e)=>sum+estimateTokens(e.content),0);
        summary.append(el('p',`常驻正文 Token≈ ${blueTokens(baseline)} → ${blueTokens(next)}（字符估算，不含模板展开及消息包装）。这是世界书配置对比，不是实际发送提示词或 API 缓存命中率对比。`));
        const notes=el('details'); notes.append(el('summary','规则限制与注意事项')); for(const text of plan.warnings)notes.append(el('p',text,'wbo-warning'));summary.append(notes);
        if(Object.hasOwn(baseline,'originalData')) summary.append(el('p','这本书保留了 originalData 原始导入数据，仅支持预览。为避免导出恢复旧值，本版本禁止应用；请先在酒馆转换为原生世界书格式。','wbo-warning'));
        cards.replaceChildren();
        for(const row of plan.entries) {
            if(filter.value==='changed'&&!row.changed)continue;
            if(filter.value==='risk'&&!row.risks.length)continue;
            const card=el('article',undefined,'wbo-card');
            const label=el('label',undefined,'wbo-entry-title'); const check=el('input'); check.type='checkbox'; check.checked=selected.has(row.id); check.disabled=busy||!row.changed||row.skipped; check.setAttribute('aria-label',`选择 ${row.before.comment||row.id}`); check.addEventListener('change',()=>{cancel();check.checked?selected.add(row.id):selected.delete(row.id);render()});
            label.append(check,el('strong',`${row.before.comment||'未命名条目'} · UID ${row.uid}`));card.append(label);
            const diff=el('div',undefined,'wbo-diff');
            for(const [title,entry] of [['优化前',row.before],['优化后',row.after]]) {const block=el('div');block.append(el('small',title),el('p',state(entry)));diff.append(block)} card.append(diff);
            card.append(el('p',row.reasons.join('；')||'保持原样','wbo-muted'));
            if(row.risks.length)card.append(el('p',row.risks.map(x=>typeof x==='string'?x: x.label??x.message??JSON.stringify(x)).join('；'),'wbo-warning'));
            const content=el('details');content.append(el('summary',`查看原正文 · Token≈ ${row.estimatedTokens}（估算）`),el('pre',row.before.content??''));card.append(content);cards.append(card);
        }
    }
    function refreshBackups() {
        backupSelect.replaceChildren(); const records=adapter.getBackups();
        for(const record of [...records].reverse()){const option=el('option',`${record.name} · ${new Date(record.createdAt).toLocaleString()} · ${record.operation}`);option.value=record.id;backupSelect.append(option)}
        if(!records.length){backupSelect.append(el('option','暂无备份'))}
    }
    toolbar.append(bookSelect,button('刷新列表',()=>run(load)),button('生成方案',()=>run(generate)),filter,button('选择无风险建议',()=>{if(plan){cancel();selected=new Set(plan.entries.filter(r=>r.changed&&!r.skipped&&!r.risks.length).map(r=>r.id));render()}}),button('清空选择',()=>{cancel();selected.clear();render()}),button('应用所选修改',()=>{
        if(!plan||!selected.size){status('请先生成方案并选择要修改的条目。',true);return}
        let next;
        try { next=applyPlan(baseline,plan,[...selected]); } catch(error) { status(error.message,true); return; }
        requestConfirm(`将修改「${name}」的 ${selected.size} 个条目。位置、灯色和冷却改变可能影响角色表现。自动备份成功后才写入。确认继续？`,async()=>{await commitWithBackup(adapter,{name,baseline,cachedBaseline,next,operation:'优化'});reset();refreshBackups();status('保存并验证成功。请重新打开世界书编辑器查看结果。');});
    }));
    filter.addEventListener('change',render);bookSelect.addEventListener('change',()=>{reset();status('世界书已切换，请重新生成方案。')});
    backupTools.append(backupSelect,button('刷新备份',()=>{try{refreshBackups()}catch(e){status(e.message,true)}}),button('导出备份',()=>{
        const record=adapter.getBackups().find(x=>x.id===backupSelect.value);if(!record)return;
        const blob=new Blob([JSON.stringify(record.data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=el('a');a.href=url;a.download=`${record.name.replace(/[\\/:*?"<>|]/g,'_')}-backup.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }),button('恢复所选备份',()=>run(async()=>{
        const record=adapter.getBackups().find(x=>x.id===backupSelect.value);if(!record)throw Error('请先选择备份');
        const current=structuredClone(await adapter.read(record.name));const cache=structuredClone(adapter.cached(record.name));
        requestConfirm(`恢复「${record.name}」将覆盖该世界书当前全部条目。当前版本也会先备份。确认恢复？`,async()=>{await commitWithBackup(adapter,{name:record.name,baseline:current,cachedBaseline:cache,next:record.data,operation:'恢复前'});reset();refreshBackups();status('恢复并验证成功。');});
    })));
    backups.append(backupTools,el('p','备份只保存在当前账号的浏览器存储，清除浏览器数据会丢失。建议导出重要备份。恢复会覆盖整本书。','wbo-muted'));
    async function load(){ const previous=bookSelect.value; const names=await adapter.list(); reset();bookSelect.replaceChildren();for(const value of names){const o=el('option',value);o.value=value;bookSelect.append(o)}if(names.includes(previous))bookSelect.value=previous;refreshBackups();status(names.length?'列表已更新，可生成方案。':'没有世界书，请先在酒馆创建或导入。');}
    panel.append(header,description,warning,toolbar,message,summary,confirmation,cards,backups);overlay.append(panel);target.append(overlay);
    overlay.addEventListener('keydown',e=>{if(e.key==='Escape'&&!busy){overlay.remove();opener?.focus()}if(e.key==='Tab'){const nodes=[...panel.querySelectorAll('button,select,input,summary')].filter(x=>!x.disabled&&x.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}});
    header.querySelector('button').focus();run(load);return overlay;
}
