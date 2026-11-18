import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMatchTiming} from '../apps/web/match-timing-data.js';
import {filterMatchTiming} from '../apps/web/monitor-scope.js';
import {renderMatchComparison,renderInlineMatchTiming} from '../apps/web/monitor-match.js';
const fixture=()=>{
 const match={id:'one',gameId:'gomoku',gameName:'五子棋',status:'finished',createdAt:new Date().toISOString(),seats:{a:{name:'A',kind:'model'},b:{name:'B',kind:'model'}},actions:[
  {index:1,seat:'a',source:'model',modelMeta:{monitorId:'a1'},metrics:{elapsedMs:1000}},
  {index:2,seat:'b',source:'model',modelMeta:{monitorId:'b1'},metrics:{elapsedMs:3000}},
  {index:3,seat:'a',source:'model',modelMeta:{monitorId:'a2'},metrics:{elapsedMs:5000}},
 ]};
 const records=[{id:'a1',seat:'a',modelId:'A',reasoning:{label:'off'}},{id:'b1',seat:'b',modelId:'B',reasoning:{label:'off'}},{id:'a2',seat:'a',modelId:'A',reasoning:{label:'high'}}].map(r=>({...r,matchId:'one',gameId:'gomoku',task:'move',status:'completed',origin:'arena',pace:'quality',moveMode:'pure'}));
 return {match,view:buildMatchTiming(match,records)};
};
test('对局与模型、桌游、推理筛选相交，保留原行动序号',()=>{
 const {view}=fixture();const scoped=filterMatchTiming(view,{modelId:'A',gameId:'gomoku',effort:'high'});
 assert.equal(scoped.seats.length,1);assert.equal(scoped.seats[0].totalMs,5000);assert.equal(scoped.rows.length,1);assert.equal(scoped.rows[0].ordinal,2);assert.equal(scoped.rows[0].cells.a.step,3);assert.equal(scoped.requests.length,1);
 assert.equal(filterMatchTiming(view,{gameId:'splendor'}).seats.length,0);
 assert.equal(filterMatchTiming(view,{task:'comment'}).requests.length,0);
 assert.equal(filterMatchTiming(view,{}),view);
});
test('缺失计时不伪造为零，活动请求仍可见',()=>{
 const {view}=fixture();view.seats[0].moves[0].totalMs=null;
 const scoped=filterMatchTiming(view,{modelId:'A',effort:'off'});assert.equal(scoped.seats[0].meanMs,null);assert.equal(scoped.seats[0].timedMoves,0);
 view.active=[{id:'running',modelId:'C',seat:'b',gameId:'gomoku'}];assert.equal(filterMatchTiming(view,{modelId:'C'}).seats[0].id,'b');
});
test('完整统计和逐步表格默认收起，摘要保留平均用时',()=>{
 const {match,view}=fixture();for(const html of [renderMatchComparison(view),renderInlineMatchTiming(match)]){assert.doesNotMatch(html,/<details[^>]*\bopen\b/);assert.match(html,/平均/);assert.match(html,/展开逐步/);}
});
