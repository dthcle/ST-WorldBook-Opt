import { createAdapter } from './adapter.js';
import { mountOptimizer } from './ui.js';
import { installExactCapture } from './exact-capture.js';
import { mountRequestDiff } from './request-diff-ui.js';

let optimizerAdapter = null;
async function getOptimizerAdapter() { optimizerAdapter ??= await createAdapter(); return optimizerAdapter; }
function openOptimizer() {
    if (document.querySelector('.wbo-overlay')) return;
    getOptimizerAdapter()
        .then(adapter => mountOptimizer(adapter))
        .catch(error => { console.error('[WorldBook Opt]', error); globalThis.toastr?.error(error.message, '世界书优化器'); });
}

/** Matches SillyTavern's native collapsible drawer markup so styling and toggle behaviour are native. */
export function buildSettingsDrawer(actions) {
    const drawer = document.createElement('div');
    drawer.className = 'wbo-settings inline-drawer';
    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header';
    const title = document.createElement('b');
    title.textContent = 'WorldBook Opt · 世界书缓存优化';
    const icon = document.createElement('div');
    icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
    header.append(title, icon);
    const content = document.createElement('div');
    content.className = 'inline-drawer-content';
    content.style.display = 'none';
    content.append(
        Object.assign(document.createElement('p'), { className: 'wbo-muted', textContent: '逐条对比、手动应用、自动备份；记录真实 N−1→N 请求差异，下一次预览固定以上次真实发送为 BASE，不改动输入框。' }),
    );
    const row = document.createElement('div');
    row.className = 'wbo-toolbar';
    for (const action of actions) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'wbo-button'; b.textContent = action.label;
        if (action.id) b.id = action.id;
        b.addEventListener('click', action.run);
        row.append(b);
    }
    content.append(row);
    drawer.append(header, content);
    return drawer;
}

async function init() {
    if (document.getElementById('wbo-open')) return;
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) { console.warn('[WorldBook Opt] 扩展设置区域不存在'); return; }
    const drawer = buildSettingsDrawer([
        { label: '打开世界书优化器', id: 'wbo-open', run: openOptimizer },
        {
            label: '请求输入差异',
            run: async () => {
                if (document.querySelector('.wbo-overlay')) return;
                try { const runtime = await initDiagnostics(); if (!document.querySelector('.wbo-overlay')) mountRequestDiff(runtime); }
                catch (error) { console.error('[WorldBook Opt]', error); globalThis.toastr?.error(error.message, '请求输入差异'); }
            },
        },
    ]);
    drawer.querySelector('.wbo-button').id = 'wbo-open';
    container.append(drawer);
}

/** Native ST wand row: div + extensionsMenuExtensionButton inherit the menu's theme sizing. */
export function buildWandMenuEntry(run) {
    const entry = document.createElement('div');
    entry.id = 'wbo-request-diff';
    entry.className = 'list-group-item wbo-wand-button interactable';
    entry.setAttribute('role', 'button');
    entry.tabIndex = 0;
    const icon = document.createElement('div');
    // Included in SillyTavern's bundled Font Awesome 6.5.2 (two bars with opposing arrows).
    icon.className = 'fa-solid fa-arrows-left-right-to-line extensionsMenuExtensionButton';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = '请求输入差异';
    entry.append(icon, label);
    entry.addEventListener('click', run);
    entry.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        // ST also delegates Enter for .interactable controls; don't activate twice.
        event.stopPropagation();
        if (!event.repeat) entry.click();
    });
    return entry;
}

/** Wand (magic wand) menu entry. */
export async function initDiagnostics(factory = installExactCapture) {
    if (initDiagnostics.runtime) return initDiagnostics.runtime;
    if (!initDiagnostics.promise) initDiagnostics.promise = Promise.resolve().then(factory).catch(error => { initDiagnostics.promise = null; throw error; });
    const runtime = await initDiagnostics.promise;
    initDiagnostics.runtime = runtime;
    function mountWand() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) return false;
        if (!document.getElementById('wbo-request-diff')) {
            const container = document.createElement('div');
            container.className = 'extension_container';
            const entry = buildWandMenuEntry(() => { if (!document.querySelector('.wbo-overlay')) mountRequestDiff(runtime); });
            container.append(entry); menu.append(container);
        }
        return true;
    }
    if (!mountWand()) {
        const observer = new MutationObserver(() => { if (mountWand()) observer.disconnect(); });
        observer.observe(document.body, { childList: true, subtree: true });
    }
    return runtime;
}

function start() {
    init();
    // The wand entry needs real SillyTavern modules; offline preview pages opt out.
    if (!document.documentElement.hasAttribute('data-wbo-preview')) {
        initDiagnostics().catch(error => console.warn('[WorldBook Opt] 请求诊断初始化失败', error));
    }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
