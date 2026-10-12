import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Index startup is suppressed, and the DOM stub belongs only to this test file.
// No SillyTavern capture modules are initialized and no network is performed.
const priorDocument = globalThis.document;
globalThis.document = { readyState: 'loading', addEventListener() {} };
const { buildWandMenuEntry } = await import('../index.js');
if (priorDocument === undefined) delete globalThis.document;
else globalThis.document = priorDocument;

function withDOM(run) {
    const prior = globalThis.document;
    const createElement = tag => {
        const listeners = new Map(), attributes = new Map();
        return {
            tagName: tag.toUpperCase(), children: [], attributes, listeners,
            append(...children) { this.children.push(...children); },
            setAttribute(name, value) { attributes.set(name, value); },
            addEventListener(name, fn) { listeners.set(name, fn); },
            click() { listeners.get('click')?.(); },
        };
    };
    globalThis.document = { createElement };
    try { run(); } finally {
        if (prior === undefined) delete globalThis.document;
        else globalThis.document = prior;
    }
}

function key(entry, key, overrides = {}) {
    const event = {
        key, repeat: false, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; }, ...overrides,
    };
    entry.listeners.get('keydown')(event);
    return event;
}

test('wand uses the native ST div row and native icon geometry class', () => withDOM(() => {
    const entry = buildWandMenuEntry(() => {});
    assert.equal(entry.tagName, 'DIV');
    assert.equal(entry.id, 'wbo-request-diff');
    assert.match(entry.className, /\blist-group-item\b/);
    assert.match(entry.className, /\binteractable\b/);
    assert.equal(entry.attributes.get('role'), 'button');
    assert.equal(entry.tabIndex, 0);
    const [icon, label] = entry.children;
    assert.equal(icon.tagName, 'DIV');
    assert.equal(icon.className, 'fa-solid fa-arrows-left-right-to-line extensionsMenuExtensionButton');
    assert.equal(icon.attributes.get('aria-hidden'), 'true');
    assert.equal(label.tagName, 'SPAN');
    assert.equal(label.textContent, '请求输入差异');
}));

test('click, Enter and Space activate once without ST delegated double activation', () => withDOM(() => {
    let calls = 0;
    const entry = buildWandMenuEntry(() => calls++);
    entry.click();
    for (const value of ['Enter', ' ']) {
        const event = key(entry, value);
        assert.equal(event.prevented, true);
        assert.equal(event.stopped, true);
    }
    assert.equal(calls, 3);
    key(entry, 'Enter', { repeat: true });
    key(entry, ' ', { repeat: true });
    assert.equal(calls, 3, 'held keys must not repeatedly open the dialog');
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
        const event = key(entry, 'Enter', { [modifier]: true });
        assert.equal(event.prevented, false);
    }
    assert.equal(key(entry, 'Escape').stopped, false);
    assert.equal(calls, 3);
}));

test('wand CSS leaves font scale, spacing and appearance to native ST/theme CSS', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(match => match[1].includes('.wbo-wand-button'));
    assert.equal(rules.length, 1);
    assert.match(rules[0][1], /:focus-visible/);
    assert.doesNotMatch(rules[0][2], /(?:font(?:-size|-family)?|padding|margin|gap|height|width|display|align-items|background|opacity)\s*:/);
});
