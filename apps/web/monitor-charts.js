const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const format=value=>`${Number((value/1000).toFixed(3))}`;
const colors=['#f7aa7e','#91c8ff','#a8d59c','#d5b1ff'];

export function timeScale(values) {
  const peak=Math.max(1000,...values.filter(v=>Number.isFinite(v)&&v>=0));
  const raw=peak/4, power=10**Math.floor(Math.log10(raw)), factor=raw/power;
  const step=([1,2,2.5,5,10].find(v=>v>=factor)??10)*power;
  const top=Math.ceil(peak/step)*step;
  return {top,ticks:Array.from({length:Math.round(top/step)+1},(_,i)=>i*step)};
}

function frame(scale,plot,labels='',width=null) {
  const axis=scale.ticks.map(value=>`<span class="monitor-y-tick" style="bottom:${value/scale.top*100}%">${format(value)}</span>`).join('');
  const grid=scale.ticks.map(value=>`<i style="bottom:${value/scale.top*100}%"></i>`).join('');
  return `<div class="monitor-axis-title">耗时（秒）</div><div class="monitor-chart-frame"><div class="monitor-y-axis" aria-label="纵轴，单位秒">${axis}</div><div class="monitor-chart-scroll"><div class="monitor-plot" ${width?`style="min-width:${width}px"`:''}>${plot}<div class="monitor-gridlines" aria-hidden="true">${grid}</div></div>${labels}</div></div>`;
}

export function renderRequestChart(rows) {
  if(!rows.length)return '<div class="monitor-empty">暂无请求样本</div>';
  const scale=timeScale(rows.map(r=>r.elapsedMs));
  const bars=rows.map(r=>`<button class="monitor-bar ${['completed','legacy_completed'].includes(r.status)?'':'bad'}" data-request="${esc(r.id)}" style="--bar-height:${Number.isFinite(r.elapsedMs)?r.elapsedMs/scale.top*100:0}%" title="${esc(r.modelName??r.modelId)} · ${esc(r.reasoning?.label??'未知')} · ${format(r.elapsedMs??0)} 秒"><span class="sr-only">${format(r.elapsedMs??0)} 秒</span></button>`).join('');
  return frame(scale,`<div class="monitor-bars">${bars}</div>`,'<div class="monitor-x-labels"><span>较早</span><span>最近</span></div>');
}

export function renderMatchChart(view,metric='totalMs') {
  if(!view.rows.length)return '<div class="monitor-empty">这盘对局还没有完成落子。</div>';
  const values=view.seats.flatMap(s=>s.moves.map(m=>m[metric]));
  if(!values.some(Number.isFinite))return '<div class="monitor-empty">这盘对局未记录所选时间点，可切换到整步耗时。</div>';
  const scale=timeScale(values);
  const width=Math.max(320,view.rows.length*Math.max(40,view.seats.length*15+14));
  const plot=view.rows.map(row=>`<div class="monitor-turn-group">${view.seats.map((seat,index)=>{
    const move=row.cells[seat.id],value=move?.[metric];
    const title=`${seat.label} ${seat.name} · 各方第 ${row.ordinal} 次行动${move?' · 棋谱第 '+move.step+' 手':''} · ${Number.isFinite(value)?format(value)+' 秒':'未提供'}`;
    return Number.isFinite(value)?`<button class="monitor-seat-bar" ${move?.requestId?`data-request="${esc(move.requestId)}"`:''} style="--bar-height:${value/scale.top*100}%;--seat-color:${colors[index%colors.length]}" title="${esc(title)}"><span class="sr-only">${esc(title)}</span></button>`:'<span class="monitor-seat-missing" title="'+esc(title)+'">·</span>';
  }).join('')}</div>`).join('');
  const labels=`<div class="monitor-turn-labels" style="min-width:${width}px">${view.rows.map(r=>`<span>${r.ordinal}</span>`).join('')}</div>`;
  const html=frame(scale,`<div class="monitor-turn-bars" style="min-width:${width}px">${plot}</div>`,labels,width);
  return `<div class="monitor-chart-legend">${view.seats.map((s,i)=>`<span><i style="background:${colors[i%colors.length]}"></i>${esc(s.label)} · ${esc(s.name)}</span>`).join('')}</div>${html}<p class="caption">横轴：各方第几次行动。同一行对应各方各自的行动次数；棋谱步数以表格中的“第几手”为准。</p>`;
}
