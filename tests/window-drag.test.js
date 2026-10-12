import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMovable } from '../window-drag.js';

function fixture() {
    const listeners = new Map();
    let captures = 0, prevented = 0;
    const header = {
        addEventListener(name, fn) { listeners.set(name, fn); },
        removeEventListener(name) { listeners.delete(name); },
        setPointerCapture() { captures++; },
    };
    const values = new Map([['--wbo-left','10px'],['--wbo-panel-top','10px'],['--wbo-width','300px'],['--wbo-height','300px']]);
    const panel = { classList: { add() {} }, style: { getPropertyValue:k=>values.get(k), setProperty:(k,v)=>values.set(k,v) },
        getBoundingClientRect:()=>({left:10,top:10,width:300,height:300}) };
    const detach = makeMovable(panel, {innerWidth:800,innerHeight:600}, header, null);
    const emit = (name, control, x=30, y=30) => listeners.get(name)?.({button:0,pointerId:1,clientX:x,clientY:y,target:{closest:()=>control},preventDefault(){prevented++;}});
    return {emit,detach,listeners,values,captures:()=>captures,prevented:()=>prevented};
}

test('header close/control pointer is not captured or prevented by dragging', () => {
    const f=fixture();f.emit('pointerdown',true);f.emit('pointermove',true,80,80);
    assert.equal(f.captures(),0);assert.equal(f.prevented(),0);assert.equal(f.values.get('--wbo-left'),'10px');f.detach();
});
test('header non-control starts pointer drag and still clamps/applies geometry', () => {
    const f=fixture();f.emit('pointerdown',false);f.emit('pointermove',false,80,80);f.emit('pointerup',false,80,80);
    assert.equal(f.captures(),1);assert.equal(f.values.get('--wbo-left'),'60px');assert.equal(f.values.get('--wbo-panel-top'),'60px');f.detach();
});
test('detaching dragging removes every gesture listener', () => {
    const f=fixture();assert.equal(f.listeners.size,4);f.detach();assert.equal(f.listeners.size,0);
});
