import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorldInfo,analyzeWorldInfo,applyPlan} from '../engine.js';
import {commitWithBackup} from '../transaction.js';
const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004'];
const entry=(uid,constant=false)=>({uid,comment:'UUID fixture',disable:false,constant,selective:false,position:0,order:100,cooldown:2,key:['test'],keysecondary:[],content:'原始正文不变',custom:{keep:true}});
const book=(...entries)=>({entries:Object.fromEntries(entries.map(e=>[String(e.uid),e])),metadata:{keep:'original'}});
for(const constant of [false,true]) test(`UUID validation is independent of constant=${constant}`,()=>{
 const source=book(entry(ids[0],constant));assert.equal(validateWorldInfo(source).valid,true);
 const plan=analyzeWorldInfo(source);assert.equal(plan.entries[0].uid,ids[0]);assert.equal(plan.entries[0].skipped,false);
 const next=applyPlan(source,plan,[ids[0]]);assert.equal(next.entries[ids[0]].uid,ids[0]);assert.equal(next.entries[ids[0]].content,'原始正文不变');assert.equal(next.entries[ids[0]].constant,true);assert.equal(next.entries[ids[0]].cooldown,0);
 assert.equal(source.entries[ids[0]].constant,constant);assert.equal(source.entries[ids[0]].cooldown,2);
});
test('four UUID entries and legacy integer coexist without key or UID conversion',()=>{
 const source=book(...ids.map(id=>entry(id)),entry(7,true));const plan=analyzeWorldInfo(source);const next=applyPlan(source,plan,Object.keys(source.entries));
 assert.deepEqual(Object.keys(next.entries),Object.keys(source.entries));for(const id of Object.keys(source.entries))assert.equal(next.entries[id].uid,source.entries[id].uid);
 assert.equal(typeof next.entries['7'].uid,'number');assert.equal(typeof next.entries[ids[0]].uid,'string');assert.deepEqual(next.metadata,source.metadata);
});
test('selection applies only selected UUID and preserves non-selected contents',()=>{
 const source=book(entry(ids[0]),entry(ids[1]));const next=applyPlan(source,analyzeWorldInfo(source),[ids[0]]);
 assert.equal(next.entries[ids[0]].constant,true);assert.deepEqual(next.entries[ids[1]],source.entries[ids[1]]);assert.deepEqual(next.entries[ids[0]].custom,{keep:true});
});
test('uppercase UUID retains exact original spelling',()=>{
 const id='ABCDEF01-ABCD-4ABC-8ABC-ABCDEF012345';const source=book(entry(id));assert.equal(validateWorldInfo(source).valid,true);
 const next=applyPlan(source,analyzeWorldInfo(source),[id]);assert.equal(next.entries[id].uid,id);assert.deepEqual(Object.keys(next.entries),[id]);
});
test('case-insensitive UUID duplicates are rejected, not silently merged',()=>{
 const id='abcdef01-abcd-4abc-8abc-abcdef012345';const source=book(entry(id),entry(id.toUpperCase()));
 assert.equal(validateWorldInfo(source).valid,false);assert.throws(()=>analyzeWorldInfo(source),/uid 重复/);
});
test('UUID key/uid mismatch is conservatively skipped, never renumbered',()=>{
 const source={entries:{[ids[0]]:entry(ids[1])}};const plan=analyzeWorldInfo(source);assert.equal(plan.entries[0].skipped,true);
 assert.deepEqual(applyPlan(source,plan,[ids[0]]),source);
});
test('invalid string IDs and malformed UUIDs are still rejected',()=>{
 for(const uid of ['','0','abc','00000000000040008000000000000001',`${ids[0]} `,ids[0].replace('000000000001','00000000000Z')])assert.equal(validateWorldInfo(book(entry(uid))).valid,false,String(uid));
});
test('altering UUID in a proposed plan is rejected',()=>{
 const source=book(entry(ids[0]));const plan=analyzeWorldInfo(source);plan.entries[0].after.uid=ids[1];assert.throws(()=>applyPlan(source,plan,[ids[0]]),/方案已被修改/);
});
test('UUID apply, verified save, backup and restore preserve original identity',async()=>{
 const source=book(entry(ids[0]));let backend=structuredClone(source),cache=structuredClone(source),backups=[];
 const adapter={async read(){return structuredClone(backend)},cached(){return structuredClone(cache)},getBackups(){return structuredClone(backups)},putBackups(value){backups=structuredClone(value)},async write(name,value){backend=structuredClone(value);cache=structuredClone(value)}};
 const next=applyPlan(source,analyzeWorldInfo(source),[ids[0]]);
 await commitWithBackup(adapter,{name:'UUID fixture',baseline:source,cachedBaseline:source,next,operation:'optimize'});
 assert.equal(backend.entries[ids[0]].uid,ids[0]);assert.deepEqual(backups[0].data,source);
 const baseline=structuredClone(backend);await commitWithBackup(adapter,{name:'UUID fixture',baseline,cachedBaseline:baseline,next:backups[0].data,operation:'restore'});
 assert.deepEqual(backend,source);assert.deepEqual(cache,source);assert.equal(backups.length,2);
});
