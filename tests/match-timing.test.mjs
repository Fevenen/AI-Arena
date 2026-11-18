import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMatchTiming } from '../apps/server/match-timing.mjs';
import { timeScale, renderRequestChart, renderMatchChart } from '../apps/web/monitor-charts.js';

const fixture=()=>({id:'fixture',gameId:'gomoku',gameName:'五子棋',seatOrder:['a','b'],seats:{a:{name:'模型 A',colorName:'黑方',kind:'model'},b:{name:'模型 B',colorName:'白方',kind:'model'}},actions:[
  {index:1,seat:'a',source:'model',metrics:{elapsedMs:3500,attempts:2},modelMeta:{monitorId:'a-ok',requestTiming:{firstOutputMs:100,firstAnswerMs:1100}}},
  {index:2,seat:'b',source:'model',metrics:{elapsedMs:6000,attempts:1},modelMeta:{requestTiming:{firstOutputMs:200}}},
  {index:3,seat:'a',source:'model',metrics:{elapsedMs:1000,attempts:1}},
]});

test('对局按座位分开，整步包含重试，思考阶段只使用完整时间点',()=>{
  const match=fixture();const records=[
    {id:'a-bad',origin:'arena',matchId:'fixture',seat:'a',step:1,task:'move',status:'invalid',queueMs:20,elapsedMs:2000},
    {id:'a-ok',origin:'arena',matchId:'fixture',seat:'a',step:1,task:'move',status:'completed',queueMs:30,legal:true},
    {id:'noise',origin:'arena',matchId:'fixture',seat:'a',step:1,task:'comment',status:'completed',elapsedMs:999999},
    {id:'bench',origin:'arena',matchId:'fixture',seat:'a',step:1,task:'benchmark',benchmarkId:'test',status:'completed',elapsedMs:999999},
  ];
  const view=buildMatchTiming(match,records);
  assert.equal(view.seats[0].totalMs,4500);assert.equal(view.seats[0].meanMs,2250);
  assert.equal(view.seats[1].totalMs,6000);assert.equal(view.seats[0].moves[0].queueMs,50);
  assert.equal(view.seats[0].moves[0].reasoningMs,1000);assert.equal(view.seats[1].moves[0].reasoningMs,null);
  assert.equal(view.rows[1].cells.a.step,3);assert.equal(view.rows[1].cells.b,null);
  assert.equal(view.requests.length,2);assert.equal(view.unfinished.length,1);
});

test('同模型不同座位不合并，真人与系统自动处理不伪造计时',()=>{
  const match=fixture();match.seats.b.name=match.seats.a.name;
  match.actions[1].source='human';match.actions[1].metrics.elapsedMs=0;
  match.actions.push({index:4,seat:'b',source:'system',metrics:{elapsedMs:0}});
  const view=buildMatchTiming(match);
  assert.equal(view.seats.length,2);assert.equal(view.seats[1].totalMs,null);assert.equal(view.seats[1].timedMoves,0);
  assert.equal(view.seats[1].moveCount,2);
});

test('四席统计、空对局和旧记录均可用',()=>{
  const match=fixture();for(const id of ['c','d']){match.seats[id]={name:id,kind:'model'};match.seatOrder.push(id);}
  const view=buildMatchTiming(match);assert.equal(view.seats.length,4);assert.equal(view.seats[3].totalMs,null);
  match.actions=[];assert.equal(buildMatchTiming(match).rows.length,0);
});

test('纵轴覆盖峰值，刻度递增，图表标注秒且保留请求详情入口',()=>{
  for(const value of [0,5,555,2000,112978,800000]){
    const scale=timeScale([value]);assert.ok(scale.top>=value);assert.equal(scale.ticks[0],0);
    assert.equal(scale.ticks.at(-1),scale.top);assert.ok(scale.ticks.every((v,i)=>!i||v>scale.ticks[i-1]));
  }
  const chart=renderRequestChart([{id:'request-a',elapsedMs:112978,modelName:'<unsafe>',status:'completed'}]);
  assert.match(chart,/纵轴，单位秒/);assert.match(chart,/monitor-y-tick/);assert.match(chart,/data-request="request-a"/);
  assert.ok(!chart.includes('<unsafe>'));
  assert.match(renderMatchChart(buildMatchTiming(fixture())),/模型 A/);
});
