import test from 'node:test';
import assert from 'node:assert/strict';
import { POSITION, ROLE, validateWorldInfo, detectDynamicContent, estimateTokens, analyzeWorldInfo, applyPlan } from '../engine.js';
const entry = (uid, overrides = {}) => ({ uid, disable: false, constant: false, selective: true, position: POSITION.atDepth, depth: 4, role: ROLE.SYSTEM, order: 100, cooldown: 3, content: 'Static lore 世界', key: ['lore'], keysecondary: [], comment: 'Preserve title', custom: { nested: ['keep'] }, ...overrides });
const book = (...entries) => ({ name: 'Original', metadata: { revision: 1 }, entries: Object.fromEntries(entries.map(e => [String(e.uid), e])) });
const one = overrides => analyzeWorldInfo(book(entry(0, overrides))).entries[0];
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }

test('upstream interoperable enums', () => {
    assert.deepEqual(POSITION, { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 });
    assert.deepEqual(ROLE, { SYSTEM: 0, USER: 1, ASSISTANT: 2 });
});
test('empty native book is valid with zero statistics', () => {
    const result = analyzeWorldInfo(book());
    assert.equal(result.stats.total, 0); assert.equal(result.stats.estimatedTokens, 0);
    assert.deepEqual(applyPlan(book(), result, []), book());
});
for (const depth of [0, 1, 9]) test(`static shallow D${depth} becomes userD0, without dynamic anchor stays green`, () => {
    const p = one({ depth });
    assert.equal(p.after.depth, 0); assert.equal(p.after.role, 1); assert.equal(p.after.constant, false); assert.equal(p.after.cooldown, 0);
});
for (const depth of [10, 11, 9999, 10000]) test(`static deep D${depth} becomes constant userD9999`, () => {
    const p = one({ depth });
    assert.equal(p.after.depth, 9999); assert.equal(p.after.role, 1); assert.equal(p.after.constant, true);
    assert.ok(p.risks.some(r => r.includes('D9999')));
});
test('shallow green strictly before dynamic by DESC order is promoted; after and tie are not', () => {
    const p = analyzeWorldInfo(book(entry(0, { order: 200 }), entry(1, { order: 100, content: '{{random::a::b}}' }), entry(2, { order: 50 }), entry(3, { order: 100 })));
    assert.equal(p.entries[0].after.constant, true);
    assert.equal(p.entries[2].after.constant, false);
    assert.equal(p.entries[3].after.constant, false);
    assert.ok(p.entries[3].risks.some(r => r.includes('order')));
});
test('disabled or special dynamic does not anchor static promotion', () => {
    for (const overrides of [{ disable: true }, { sticky: 2 }, { position: 7 }]) {
        const p = analyzeWorldInfo(book(entry(0, { order: 200 }), entry(1, { order: 100, content: '<%= value %>', ...overrides })));
        assert.equal(p.entries[0].after.constant, false);
    }
});
for (const constant of [true, false]) test(`dynamic retains constant=${constant}, including originally deep and nondepth`, () => {
    for (const position of [0, 1, 4]) {
        const p = one({ constant, position, depth: 300, content: '<%= getvar("state") %>' });
        assert.equal(p.after.constant, constant); assert.equal(p.after.position, 4); assert.equal(p.after.depth, 0); assert.equal(p.after.role, 1);
    }
});
for (const position of [0, 1]) test(`ordinary nondepth position ${position} static green only promotes constant and resets cooldown`, () => {
    const p = one({ position, role: null, depth: null });
    assert.equal(p.after.constant, true); assert.equal(p.after.position, position); assert.equal(p.after.depth, null); assert.equal(p.after.role, null);
    assert.deepEqual(p.changedFields, ['constant', 'cooldown']);
});
test('nondepth blue placement unchanged, cooldown is still zero', () => {
    const p = one({ position: 0, constant: true });
    assert.equal(p.after.cooldown, 0);
    assert.deepEqual(p.changedFields, ['cooldown']);
    assert.equal(one({ position: 0, constant: true, cooldown: 0 }).changed, false);
});
for (const content of ['<%= foo %>', '<% unfinished', 'MVU', '<UpdateVariable>', 'stat_data.health', '{{getvar::hp}}', '{{random::a::b}}', '{{time}}', '{{unknownMacro}}', '{{char}}', '{{unfinished', '${value}', 'Math.random()', 'Date.now()', 'new Date()', 'strftime("%H")']) {
    test(`dynamic heuristic recognises ${content}`, () => {
        const d = detectDynamicContent(content); assert.equal(d.dynamic, true); assert.equal(d.heuristic, true); assert.ok(d.reasons.length);
    });
}
for (const content of ['', '普通静态人物背景', 'A random stranger arrived at midnight.', 'A variable name in prose.', '3 < 5', '{ordinary}']) {
    test(`ordinary prose not automatically dynamic: ${content}`, () => assert.equal(detectDynamicContent(content).dynamic, false));
}
for (const overrides of [{ disable: true }, { position: 2 }, { position: 3 }, { position: 5 }, { position: 6 }, { position: 7 }, { position: 99 }, { sticky: 1 }, { delay: 1 }, { vectorized: true }, { preventRecursion: true }, { excludeRecursion: true }, { delayUntilRecursion: true }, { group: 'x' }, { groupOverride: true }, { automationId: 'script' }, { triggers: ['normal'] }, { decorators: ['@@activate'] }, { content: '@@activate\nlore' }, { content: '  @@dont_activate\nlore' }, { ignoreBudget: true }, { content: 'foo', keysecondary: ['bar'] }, { useProbability: true, probability: 20 }, { characterFilter: { names: ['Alice'], tags: [] } }, { extensions: { unknown: true } }]) {
    test(`conservatively skip ${JSON.stringify(overrides)}`, () => {
        const p = one(overrides); assert.equal(p.skipped, true); assert.equal(p.changed, false); assert.deepEqual(p.after, p.before); assert.ok(p.risks.length);
    });
}
test('inactive default special fields do not cause skip', () => {
    const p = one({ sticky: 0, delay: 0, vectorized: false, group: '', automationId: '', triggers: [], decorators: [], useProbability: true, probability: 100, characterFilter: { names: [], tags: [] }, extensions: {} });
    assert.equal(p.skipped, false);
});
test('uid/key mismatch is conservatively unchanged', () => {
    const b = { entries: { alias: entry(0) } }; assert.equal(analyzeWorldInfo(b).entries[0].skipped, true);
});
test('missing optional nondepth depth/role/cooldown is accepted, no defaults added except cooldown', () => {
    const e = entry(0, { position: 0 }); delete e.depth; delete e.role; delete e.cooldown;
    const p = analyzeWorldInfo(book(e)).entries[0];
    assert.equal(p.after.cooldown, 0); assert.equal(Object.hasOwn(p.after, 'depth'), false); assert.equal(Object.hasOwn(p.after, 'role'), false);
});
test('pure analysis/apply, independent clones, content and arbitrary JSON untouched', () => {
    const b = book(entry(0, { content: '  A\n原文\r\n\t"quoted"  ' }), entry(1, { content: '{{time}}' }));
    const original = structuredClone(b); freeze(b);
    const p = analyzeWorldInfo(b); const out = applyPlan(b, p, ['0']);
    assert.deepEqual(b, original); assert.deepEqual(out.metadata, original.metadata); assert.deepEqual(out.entries['1'], original.entries['1']);
    assert.notEqual(out.entries['1'], b.entries['1']);
    for (const [id, item] of Object.entries(out.entries)) {
        for (const field of Object.keys(original.entries[id]).filter(k => !['constant', 'cooldown', 'position', 'depth', 'role'].includes(k))) assert.deepEqual(item[field], original.entries[id][field]);
    }
    assert.notEqual(p.entries[0].before.custom, p.entries[0].after.custom);
    p.entries[0].after.custom.nested.push('mutation'); assert.deepEqual(p.entries[0].before.custom.nested, ['keep']);
});
test('JSON __proto__/constructor keys round-trip without prototype mutation', () => {
    const b = JSON.parse('{"entries":{"0":{"uid":0,"disable":false,"constant":false,"selective":false,"position":0,"order":0,"content":"x","key":[],"__proto__":{"polluted":true}}},"__proto__":{"x":1},"constructor":"metadata"}');
    const out = applyPlan(b, analyzeWorldInfo(b), ['0']);
    assert.deepEqual(out.__proto__, { x: 1 }); assert.equal({}.polluted, undefined); assert.equal(out.constructor, 'metadata');
    assert.deepEqual(out.entries['0'].__proto__, { polluted: true });
});
test('stats are content estimates, not API hit rates; content token sum unchanged', () => {
    const p = analyzeWorldInfo(book(entry(0, { position: 0, constant: true }), entry(1, { depth: 10 }), entry(2, { disable: true }), entry(3, { content: '{{time}}' })));
    assert.equal(p.stats.total, 4); assert.equal(p.stats.enabled, 3); assert.equal(p.stats.disabled, 1); assert.equal(p.stats.dynamic, 1); assert.equal(p.stats.skipped, 1);
    assert.equal(p.stats.estimatedTokens, p.entries.reduce((n, e) => n + estimateTokens(e.before.content), 0));
    assert.ok(p.stats.estimatedConstantTokensAfter > p.stats.estimatedConstantTokensBefore);
    assert.ok(p.warnings.some(w => w.includes('非完备'))); assert.ok(p.warnings.some(w => w.includes('API')));
    assert.equal(Object.hasOwn(p.stats, 'cacheHitRate'), false);
    assert.equal(estimateTokens(''), 0); assert.equal(estimateTokens('abcd'), 1); assert.equal(estimateTokens('中'), 1); assert.equal(estimateTokens('😀'), 1);
});
test('selected apply rejects omitted, nonstring, duplicate and unknown IDs', () => {
    const b = book(entry(0)); const p = analyzeWorldInfo(b);
    for (const ids of [undefined, '0', [0], ['0', '0'], ['404']]) assert.throws(() => applyPlan(b, p, ids), TypeError);
    assert.deepEqual(applyPlan(b, p, []), b);
    assert.throws(() => applyPlan(b, {}, []), TypeError);
});
test('selected apply rejects stale input and altered proposals', () => {
    const b = book(entry(0)); const p = analyzeWorldInfo(b);
    const modified = structuredClone(b); modified.entries['0'].content = 'changed';
    assert.throws(() => applyPlan(modified, p, ['0']), /重新分析/);
    p.entries[0].after.content = 'injection'; assert.throws(() => applyPlan(b, p, ['0']), /方案已被修改/);
});
test('selected apply detects cross-entry stale order changing constant promotion', () => {
    const b = book(entry(0), entry(1, { order: 50, content: '{{time}}' }));
    const p = analyzeWorldInfo(b); b.entries['1'].order = 200;
    assert.throws(() => applyPlan(b, p, ['0']), /方案已被修改/);
});
test('skipped selections stay unchanged; independently selected blue can be applied', () => {
    const b = book(entry(0, { disable: true }), entry(1, { position: 0, constant: true }));
    const out = applyPlan(b, analyzeWorldInfo(b), ['0', '1']); assert.deepEqual(out.entries['0'], b.entries['0']); assert.equal(out.entries['1'].cooldown, 0);
});
for (const invalid of [null, [], {}, { entries: [] }, { entries: { a: null } }, { entries: { 0: {} } }]) test(`invalid native shape ${JSON.stringify(invalid)}`, () => {
    assert.equal(validateWorldInfo(invalid).valid, false); assert.throws(() => analyzeWorldInfo(invalid), TypeError);
});
for (const overrides of [{ uid: -1 }, { uid: '0' }, { disable: 'false' }, { constant: 1 }, { selective: null }, { position: '4' }, { position: -1 }, { order: 1.5 }, { depth: -1 }, { depth: null }, { role: 3 }, { role: null }, { cooldown: '1' }, { content: null }, { key: 'word' }, { key: [2] }, { keysecondary: {} }]) test(`invalid field ${JSON.stringify(overrides)}`, () => assert.equal(validateWorldInfo(book(entry(0, overrides))).valid, false));
test('duplicate uids rejected even if object keys differ', () => assert.equal(validateWorldInfo({ entries: { a: entry(0), b: entry(0) } }).valid, false));
test('non-JSON input fails without executing accessors', () => {
    for (const value of [NaN, Infinity, undefined, 1n, () => {}, new Date(), Symbol('x')]) {
        const b = book(entry(0)); b.extra = value; assert.equal(validateWorldInfo(b).valid, false);
    }
    const b = book(entry(0)); b.extra = b; assert.equal(validateWorldInfo(b).valid, false);
    let called = false; const accessor = {}; Object.defineProperty(accessor, 'extra', { enumerable: true, get() { called = true; throw Error('do not call'); } });
    assert.equal(validateWorldInfo(accessor).valid, false); assert.equal(called, false);
    assert.equal(validateWorldInfo({ entries: {}, list: Array(2) }).valid, false);
});
test('originalData books are preview-only and conservatively refuse all apply actions', () => {
    for (const originalData of [null, {}, { entries: [{ id: 0, constant: false, extensions: { position: 4, depth: 4, role: 0, cooldown: 3 } }] }]) {
        const b = book(entry(0)); b.originalData = originalData;
        const original = structuredClone(b); const p = analyzeWorldInfo(b);
        assert.ok(p.warnings.some(w => w.includes('originalData')));
        assert.ok(p.entries[0].risks.some(w => w.includes('originalData')));
        assert.throws(() => applyPlan(b, p, ['0']), /originalData/);
        assert.throws(() => applyPlan(b, p, []), /originalData/);
        assert.deepEqual(b, original);
    }
});
test('helper input validation', () => { assert.throws(() => estimateTokens(4), TypeError); assert.throws(() => detectDynamicContent(null), TypeError); });
test('already optimized deep and dynamic plans are idempotent', () => {
    const b = book(entry(0, { depth: 10 }), entry(1, { content: '{{time}}', order: 200 }));
    const out = applyPlan(b, analyzeWorldInfo(b), ['0', '1']);
    assert.equal(analyzeWorldInfo(out).stats.changed, 0);
});
