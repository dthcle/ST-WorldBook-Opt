import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLines, alignLines, diffLines } from '../line-diff.js';

test('splitLines keeps empty input empty and preserves blank lines', () => {
    assert.deepEqual(splitLines(''), []);
    assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
    assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b']);
    assert.deepEqual(splitLines('a\n'), ['a', '']);
    assert.throws(() => splitLines(null), /字符串/);
});

test('alignLines pairs equal lines and marks changes in place', () => {
    const rows = alignLines(['a', 'b', 'c'], ['a', 'B', 'c']);
    assert.deepEqual(rows.map(r => r.type), ['equal', 'change', 'equal']);
    assert.equal(rows[1].beforeIndex, 1);
    assert.equal(rows[1].afterIndex, 1);
});

test('alignLines detects inserted and deleted lines', () => {
    const inserted = alignLines(['a', 'c'], ['a', 'b', 'c']);
    assert.deepEqual(inserted.map(r => r.type), ['equal', 'insert', 'equal']);
    assert.equal(inserted[1].afterIndex, 1);
    const deleted = alignLines(['a', 'b', 'c'], ['a', 'c']);
    assert.deepEqual(deleted.map(r => r.type), ['equal', 'delete', 'equal']);
});

test('diffLines reports which lines changed with intra-line ranges', () => {
    const before = ['header', '温度：-32℃', 'footer'].join('\n');
    const after = ['header', '温度：-33℃', 'footer'].join('\n');
    const diff = diffLines(before, after);
    assert.equal(diff.supported, true);
    assert.equal(diff.beforeLineCount, 3);
    assert.equal(diff.changedLineCount, 1);
    const changed = diff.rows.filter(r => r.type === 'change');
    assert.equal(changed.length, 1);
    assert.equal(changed[0].beforeText, '温度：-32℃');
    assert.equal(changed[0].afterText, '温度：-33℃');
    assert.equal(changed[0].beforeText.slice(changed[0].beforeChanged.start, changed[0].beforeChanged.end), '2');
    assert.equal(changed[0].afterText.slice(changed[0].afterChanged.start, changed[0].afterChanged.end), '3');
});

test('diffLines marks add/remove rows with null side text', () => {
    const diff = diffLines('a\nb', 'a\nb\nc');
    const inserted = diff.rows.filter(r => r.type === 'insert');
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].beforeText, null);
    assert.equal(inserted[0].afterText, 'c');
    assert.equal(diff.changedLineCount, 1);
});

test('diffLines does not flag a wrapper id line as the whole block', () => {
    // Regression for the reported case: one marker line differs, everything else is stable.
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}: 稳定内容`);
    const before = ['§§TH_SQUASH_WI:aaa:START§§', ...body, '§§TH_SQUASH_WI:aaa:END§§'].join('\n');
    const after = ['§§TH_SQUASH_WI:bbb:START§§', ...body, '§§TH_SQUASH_WI:bbb:END§§'].join('\n');
    const diff = diffLines(before, after);
    assert.equal(diff.changedLineCount, 2, 'only the two marker lines changed');
    assert.equal(diff.rows.filter(r => r.type === 'equal').length, 200);
});

test('diffLines stays bounded for very large inputs', () => {
    const big = 'x'.repeat(5000);
    const huge = Array.from({ length: 400 }, () => big).join('\n');
    const diff = diffLines(huge, `${huge}y`);
    assert.equal(diff.supported, false);
    assert.match(diff.reason, /过大|行数过多/);
});

test('diffLines treats identical text as all-equal', () => {
    const diff = diffLines('a\nb\nc', 'a\nb\nc');
    assert.equal(diff.changedLineCount, 0);
    assert.equal(diff.rows.every(r => r.type === 'equal'), true);
});

test('diffLines handles empty sides', () => {
    assert.equal(diffLines('', '').changedLineCount, 0);
    const added = diffLines('', 'a\nb');
    assert.equal(added.changedLineCount, 2);
    const removed = diffLines('a\nb', '');
    assert.equal(removed.changedLineCount, 2);
});

test('diffLines reports 1-based hunk ranges with change/add/delete counts', () => {
    const before = ['keep', 'a', 'b', 'keep2', 'c'].join('\n');
    const after = ['keep', 'a2', 'b2', 'keep2', 'c', 'd'].join('\n');
    const diff = diffLines(before, after);
    assert.equal(diff.hunks.length, 2);
    assert.deepEqual(
        { s: diff.hunks[0].beforeStart, e: diff.hunks[0].beforeEnd, changes: diff.hunks[0].changes },
        { s: 2, e: 3, changes: 2 },
    );
    const last = diff.hunks.at(-1);
    assert.equal(last.inserts, 1);
    assert.equal(last.beforeStart, null, 'a pure insertion has no before range');
    assert.equal(last.afterStart, 6);
});

test('a large all-new region is reported as inserts, not invented 1:1 changes', () => {
    // Regression: pairing an 11-line block with a 700-line block fabricated differences.
    const before = Array.from({ length: 11 }, (_, i) => `old ${i}`);
    const after = Array.from({ length: 700 }, (_, i) => `new ${i}`);
    const diff = diffLines(before.join('\n'), after.join('\n'));
    const hunk = diff.hunks[0];
    assert.equal(hunk.changes, 0, 'no fabricated change pairs');
    assert.equal(hunk.deletes, 11);
    assert.equal(hunk.inserts, 700);
});

test('patience alignment keeps a stable tail aligned across a large insertion', () => {
    const stable = Array.from({ length: 300 }, (_, i) => `stable line ${i}`);
    const before = ['head', ...stable.slice(0, 150), ...stable.slice(150)].join('\n');
    const after = ['head', ...Array.from({ length: 400 }, (_, i) => `inserted ${i}`), ...stable].join('\n');
    const diff = diffLines(before, after);
    assert.equal(diff.rows.filter(r => r.type === 'equal').length, 301, 'head + 300 stable lines stay equal');
    assert.equal(diff.changedLineCount, 400);
});

