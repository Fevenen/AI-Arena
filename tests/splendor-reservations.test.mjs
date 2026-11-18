import test from 'node:test';
import assert from 'node:assert/strict';
import { publicReservations } from '../apps/web/games/splendor/reservations.js';
import { renderSplendor } from '../apps/web/games/splendor/surface.js';

const card={id:'visible-card',bonus:'G',points:1,cost:{W:2},tier:1};
const view=(count,market=[card])=>({seats:['a','b'],market:{1:market},players:{a:{reservedCount:count},b:{reservedCount:0}}});
test('公开市场预留保留牌面，盲预留不读取私有牌或牌堆',()=>{
  const steps=[{view:view(0)},
    {seat:'a',action:{action:'reserve:visible-card'},view:view(1,[])},
    {seat:'a',action:{action:'reserve:deck3'},view:{...view(2,[]),privateBySeat:{a:{secret:'hidden-card'}}},seatViews:{a:{reserved:[{id:'hidden-card'}]}}},
  ];
  const publicView=publicReservations(steps);
  assert.equal(publicView.a.cards[0].id,card.id);assert.equal(publicView.a.hiddenCount,1);
  assert.doesNotMatch(JSON.stringify(publicView),/hidden-card/);
  steps.push({seat:'a',action:{action:'buy:visible-card'},view:view(1,[])});
  assert.equal(publicReservations(steps).a.cards.length,0);
  assert.equal(publicReservations(steps).a.hiddenCount,1);
});
test('观战牌桌为 AI 绘制预留区和公开牌面，缺失牌面使用牌背',()=>{
  const full={...view(2),bank:{Y:0},turn:'a',round:1,phase:'action',deckCounts:{1:1},nobles:[]};
  for(const player of Object.values(full.players))Object.assign(player,{tokens:{},bonuses:{},nobles:[],boughtCount:0,points:0});
  const html=renderSplendor({match:{seats:{a:{name:'AI A'},b:{name:'AI B'}}},view:full,interactive:false,humanColor:null,reservedView:{a:{cards:[card],hiddenCount:1}}},String,String);
  assert.match(html,/各方预留牌/);assert.match(html,/visible-card/);assert.match(html,/spl-card-back/);assert.match(html,/AI A/);
});
