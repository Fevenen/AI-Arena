import { renderMatchChart } from './monitor-charts.js';
import { buildMatchTiming } from './match-timing-data.js';
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const seconds=value=>Number.isFinite(value)?(value/1000).toFixed(2)+' 秒':'未提供';
const colors=['#f7aa7e','#91c8ff','#a8d59c','#d5b1ff'];
const statuses={playing:'进行中',paused:'已暂停',finished:'已结束',aborted:'已中止'};

export function matchChoiceLabel(match) {
  const players=(match.seatOrder??Object.keys(match.seats??{})).map(id=>match.seats?.[id]?.name??match.seats?.[id]?.modelName??'未命名');
  return `${match.gameName} · ${players.join(' vs ')} · ${new Date(match.createdAt).toLocaleString()} · ${statuses[match.status]??match.status}`;
}

export function renderMatchComparison(view,metric='totalMs') {
  const pace=view.match.aiPace==='fast'?'限时模式':'正常模式';
  const heading=`<div class="monitor-match-heading"><span class="chip">${esc(view.match.gameName)}</span><span class="chip">${pace}</span><span class="caption">${esc(statuses[view.match.status]??view.match.status)}</span><a class="btn btn-sm" href="#/replay/${encodeURIComponent(view.match.id)}">查看棋谱</a></div>`;
  if(!view.seats.length)return heading+'<div class="monitor-empty">本局暂无符合筛选条件的落子记录。</div>';
  const cards=`<div class="monitor-player-cards" style="--seat-count:${view.seats.length}">${view.seats.map((seat,index)=>`<article class="monitor-player-card" style="--seat-color:${colors[index%colors.length]}"><div class="monitor-player-title"><span>${esc(seat.label)}</span><strong>${esc(seat.name)}</strong></div><div class="monitor-primary-time"><span class="caption">平均每次行动</span><strong>${seconds(seat.meanMs)}</strong><span class="caption">${seat.timedMoves} 次已计时</span></div><details class="rules-details" data-monitor-disclosure="stats-${esc(seat.id)}"><summary>更多统计</summary><div class="monitor-player-extra"><span>累计 ${seconds(seat.totalMs)}</span><span>最慢 ${seconds(seat.maxMs)}</span><span>思考输出阶段累计 ${seconds(seat.reasoningMs)}</span><span>${esc(seat.reasoningSettings.join(' / ')||'尚未记录推理设置')}</span><span>异常或取消请求 ${seat.abnormalRequests} 次</span></div></details></article>`).join('')}</div>`;
  const cell=(move)=>{
    if(!move)return '<span class="caption">—</span>';
    const time=move.source==='human'?'真人行动，未计时':move.source==='system'?'系统自动处理':seconds(move.totalMs);
    return `<div class="monitor-move-cell"><div><a href="#/replay/${encodeURIComponent(view.match.id)}?step=${move.step}">第 ${move.step} 手</a><strong>${time}</strong></div><span class="caption">思考输出阶段 ${seconds(move.reasoningMs)}</span><span class="caption">末次首输出 ${seconds(move.firstOutputMs)} · 排队 ${seconds(move.queueMs)}</span><span class="caption">${Number.isFinite(move.attempts)?'尝试 '+move.attempts+' 次':''}${Number.isFinite(move.outputTokens)?' · 输出 '+move.outputTokens+' tokens（含思考）':''}${Number.isFinite(move.reasoningTokens)?' · 思考 '+move.reasoningTokens+' tokens':''}</span>${move.requestId?`<button class="btn btn-quiet btn-sm" data-request="${esc(move.requestId)}">请求详情</button>`:''}</div>`;
  };
  const table=`<details class="rules-details monitor-move-disclosure" data-monitor-disclosure="move-table"><summary>展开逐步对照（${view.rows.length} 次行动）</summary><div class="monitor-table-wrap"><table class="monitor-table monitor-match-table"><thead><tr><th>各方行动次数</th>${view.seats.map((seat,index)=>`<th style="--seat-color:${colors[index%colors.length]}">${esc(seat.label)}<span class="caption">${esc(seat.name)}</span></th>`).join('')}</tr></thead><tbody>${view.rows.map(row=>`<tr><th scope="row">${row.ordinal}</th>${view.seats.map(seat=>`<td>${cell(row.cells[seat.id])}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${view.seats.length+1}">还没有完成的行动。</td></tr>`}</tbody></table></div></details>`;
  const activity=view.active.map(row=>`<button class="monitor-request" data-request="${esc(row.id)}"><strong>${esc(view.seats.find(s=>s.id===row.seat)?.name??row.modelName??row.modelId)}</strong><span>${esc({queued:'等待模型空闲',thinking:'正在输出思考',answering:'正在生成答案',requesting:'正在请求接口',waiting_output:'等待输出'}[row.stage]??row.stage)}</span><span data-match-elapsed="${esc(row.id)}">${seconds(row.elapsedMs)}</span></button>`).join('');
  const failures=view.unfinished.length?`<details class="rules-details" data-monitor-disclosure="failures"><summary>异常或取消的落子请求（${view.unfinished.length}）</summary><div class="monitor-failed-moves">${view.unfinished.slice(-10).reverse().map(row=>`<button class="monitor-request" data-request="${esc(row.id)}"><strong>${esc(view.seats.find(s=>s.id===row.seat)?.name??row.modelName??row.modelId)}</strong><span>${row.step?'第 '+row.step+' 手 · ':''}${esc(row.errorCode??row.status)}</span><span>${seconds(row.elapsedMs)}</span></button>`).join('')}</div></details>`:'';
  return heading+cards+activity+`<div id="monitor-match-chart" class="monitor-chart">${renderMatchChart(view,metric)}</div>`+table+failures;
}

export function renderInlineMatchTiming(match) {
  const view=buildMatchTiming(match);
  return `<div class="match-inline-summary">${view.seats.map((seat,index)=>`<div style="--seat-color:${colors[index%colors.length]}"><strong>${esc(seat.label)} · ${esc(seat.name)}</strong><span>平均 ${seconds(seat.meanMs)} · 最近 ${seconds(seat.moves.at(-1)?.totalMs)}</span></div>`).join('')}</div>
    <details class="rules-details match-inline-details"><summary>展开逐步耗时（${view.rows.length} 次行动）</summary><div class="monitor-chart match-inline-chart">${renderMatchChart(view)}</div>
    <div class="monitor-table-wrap match-inline-table"><table class="monitor-table"><thead><tr><th>次数</th>${view.seats.map(seat=>`<th>${esc(seat.label)}<span class="caption">${esc(seat.name)}</span></th>`).join('')}</tr></thead><tbody>${view.rows.map(row=>`<tr><th>${row.ordinal}</th>${view.seats.map(seat=>{
      const move=row.cells[seat.id];
      return move?`<td><strong>第 ${move.step} 手 · ${move.source==='human'?'真人未计时':move.source==='system'?'系统自动处理':seconds(move.totalMs)}</strong><span class="caption">思考输出阶段 ${seconds(move.reasoningMs)}${Number.isFinite(move.attempts)?' · 尝试 '+move.attempts+' 次':''}</span></td>`:'<td>—</td>';
    }).join('')}</tr>`).join('')||`<tr><td colspan="${view.seats.length+1}">等待第一步完成。</td></tr>`}</tbody></table></div></details>
    <p class="caption">整步耗时包含等待和重试；思考输出阶段需要完整时间点，缺失时显示未提供。</p>`;
}
