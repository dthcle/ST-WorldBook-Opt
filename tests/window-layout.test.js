import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, clampLayout, MIN_WIDTH, MIN_HEIGHT } from '../window-layout.js';

const phone = { width: 390, height: 664 };
const desktop = { width: 1280, height: 800 };

test('mobile layout uses most of the visible height instead of a thin strip', () => {
    const layout = defaultLayout(phone);
    assert.ok(layout.height >= phone.height - 20, `expected a tall window, got ${layout.height}`);
    assert.ok(layout.width >= phone.width - 20, `expected a wide window, got ${layout.width}`);
    assert.equal(layout.top, 8);
});

test('desktop layout stays bounded and centred', () => {
    const layout = defaultLayout(desktop);
    assert.ok(layout.width <= 920 && layout.width >= MIN_WIDTH);
    assert.ok(layout.height <= desktop.height - 16);
    assert.ok(layout.left > 0);
});

test('layout never collapses below the minimum on a tiny viewport', () => {
    const layout = defaultLayout({ width: 150, height: 120 });
    assert.ok(layout.width >= MIN_WIDTH);
    assert.ok(layout.height >= MIN_HEIGHT);
});

test('clamp keeps a dragged window inside the viewport', () => {
    const layout = clampLayout({ left: -500, top: 9999, width: 300, height: 400 }, phone);
    assert.equal(layout.left, 0);
    assert.equal(layout.top, phone.height - 400);
    assert.equal(layout.width, 300);
});

test('clamp shrinks an oversized window to the viewport', () => {
    const layout = clampLayout({ left: 0, top: 0, width: 5000, height: 5000 }, phone);
    assert.equal(layout.width, phone.width - 8);
    assert.equal(layout.height, phone.height - 8);
});

test('clamp still allows the header to remain reachable', () => {
    const layout = clampLayout({ left: 10, top: 10, width: 10, height: 10 }, desktop);
    assert.ok(layout.width >= MIN_WIDTH && layout.height >= MIN_HEIGHT);
});

test('degenerate viewports do not produce NaN', () => {
    for (const viewport of [{}, { width: 0, height: 0 }]) {
        const layout = defaultLayout(viewport);
        assert.ok(Number.isFinite(layout.left) && Number.isFinite(layout.top));
        assert.ok(layout.width >= MIN_WIDTH && layout.height >= MIN_HEIGHT);
    }
});