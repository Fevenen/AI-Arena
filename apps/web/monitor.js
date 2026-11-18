import { filterMatchTiming } from './monitor-scope.js';
import { renderRequestChart } from './monitor-charts.js';
import { renderMatchComparison, matchChoiceLabel } from './monitor-match.js';
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const seconds=value=>Number.isFinite(value)?(value/1000).toFixed(2)+' 秒':'未提供';
const number=value=>Number.isFinite(value)?value.toLocaleString():'未提供';
const tasks={diagnostic:'参数验收',move:'落子',timed_move:'限时落子',chat:'桌宠聊天',question:'主动提问',comment:'自动点评',screen_comment:'屏幕点评',intent:'意图判断',tavern_comment:'酒馆点评',tavern_play:'酒馆代玩',benchmark:'固定局面测速'};
const stages={queued:'等待模型空闲',requesting:'正在请求接口',waiting_output:'等待输出（内部阶段未提供）',thinking:'正在输出思考',answering:'正在生成答案',completed:'已完成',legacy_completed:'旧记录 · 已完成',failed:'请求失败',invalid:'非法动作',truncated:'达到输出上限',cancelled:'已取消',skipped:'忙时跳过'};
const opts=(values,selected='')=>values.map(([value,label])=>`<option value="${esc(value)}" ${value===selected?'selected':''}>${esc(label)}</option>`).join('');
const pace=value=>({quality:'正常模式',fast:'限时模式',benchmark:'固定局面测速'}[value]??'未记录');
const effort=row=>row.reasoning?.label??'档位未知';
const progress=row=>`<span class="monitor-stage stage-${esc(row.stage)}">${esc(stages[row.stage]??row.stage)}</span>`;

export async function mountMonitor({api,renderShell,boot,icon,isCurrent=()=>true}) {
  let stopped=false,busy=false,timer=null,data=null,selected=null,recentLimit=25;
  const filters={matchId:new URLSearchParams(location.hash.split('?')[1]??'').get('match')??''};
  const alive=()=>!stopped && isCurrent() && location.hash.startsWith('#/monitor');
  const initial=await api('/api/monitor?'+new URLSearchParams(filters));
  if(!alive())return ()=>{};
  const matches=(await api('/api/matches')).matches??[];
  if(!alive())return ()=>{};
  let matchView=null,matchMetric='totalMs',matchEpoch=0,matchSignature='';
  const gameName=id=>boot.games.find(g=>g.id===id)?.name??id??'—';
  renderShell(`<div class="page monitor-page">
    <div class="page-head"><div><h1 class="page-title">模型监控</h1><p class="page-subtitle">按对局、模型和桌游筛选耗时。</p></div><span class="chip">每 1.5 秒更新</span></div>
    ${boot.backgroundMatchId?`<div class="notice notice-info monitor-background-game"><span>棋局连接已保留。</span><a class="btn btn-sm" href="#/match/${encodeURIComponent(boot.backgroundMatchId)}">返回棋局</a></div>`:''}
    <section class="card monitor-filters monitor-sticky-filters" aria-label="监控筛选">
      <div class="monitor-primary-filters">
        <label class="field"><span class="field-label">对局</span><select class="select" data-monitor-filter="matchId">${opts([['','全部对局'],...matches.map(m=>[m.id,matchChoiceLabel(m)])],filters.matchId)}</select></label>
        <label class="field"><span class="field-label">模型</span><select class="select" data-monitor-filter="modelId">${opts([['','全部模型'],...initial.options.modelId.map(id=>[id,id])])}</select></label>
        <label class="field"><span class="field-label">桌游</span><select class="select" data-monitor-filter="gameId">${opts([['','全部桌游'],...boot.games.map(g=>[g.id,g.name])])}</select></label>
      </div>
      <div class="monitor-filter-footer"><details class="monitor-extra-filters"><summary id="monitor-more-filters-label">更多筛选</summary><div class="monitor-extra-filter-grid">
        <label class="field"><span class="field-label">推理设置</span><select class="select" data-monitor-filter="effort">${opts([['','全部设置'],...initial.options.effort.map(id=>[id,id])])}</select></label>
        <label class="field"><span class="field-label">任务</span><select class="select" data-monitor-filter="task">${opts([['','全部任务'],...Object.entries(tasks)])}</select></label>
        <label class="field"><span class="field-label">模式</span><select class="select" data-monitor-filter="pace">${opts([['','全部模式'],['quality','正常模式'],['fast','限时模式'],['benchmark','固定局面测速']])}</select></label>
        <label class="field"><span class="field-label">规则辅助</span><select class="select" data-monitor-filter="moveMode">${opts([['','全部'],['pure','纯模型'],['assisted','规则辅助']])}</select></label>
      </div></details><button class="btn btn-quiet btn-sm" data-monitor-clear>清空筛选</button></div>
    </section>
    <div id="monitor-health" class="caption"></div>
    <div id="monitor-kpis" class="monitor-kpis"></div>
    <section class="card card-pad" id="monitor-active-section"><h2 class="section-title">正在运行</h2><div id="monitor-active" class="monitor-active"></div></section>
    <section class="card card-pad" id="monitor-match-panel" hidden>
      <div class="side-card-head"><h2 class="section-title">本局耗时</h2><label class="monitor-metric-choice"><span>图表</span><select class="select" data-match-metric>${opts([['totalMs','整步耗时'],['reasoningMs','思考输出阶段']])}</select></label></div>
      <div id="monitor-match-body"></div>
    </section>
    <section class="card card-pad" id="monitor-trend-section"><h2 class="section-title">耗时趋势</h2><div id="monitor-chart" class="monitor-chart"></div></section>
    <details class="card monitor-disclosure" id="monitor-groups-section"><summary>分组统计<span>按模型、推理设置和游戏汇总平均耗时</span></summary><div class="card-pad"><p class="caption">每行是一组相同配置的请求。展开可比较平均值、最慢区间、用量与异常次数。</p><div id="monitor-groups" class="monitor-table-wrap"></div></div></details>
    <details class="card monitor-disclosure" id="monitor-recent-section"><summary>请求明细<span>展开查看单次调用和参数</span></summary><div class="card-pad"><a class="btn btn-sm" id="monitor-export" href="/api/monitor/export" download>导出当前筛选</a><div id="monitor-recent" class="monitor-table-wrap"></div><button class="btn btn-sm mt-12" data-monitor-more>显示更多请求</button></div></details>
    <details class="card monitor-disclosure" id="monitor-benchmark-section"><summary>固定局面测速<span id="monitor-benchmark-state">按需启动</span></summary><div class="card-pad"><p class="caption">对同一局面比较推理设置，会真实调用模型；不修改原棋局。合法率不等于棋力。</p>
      <form id="monitor-benchmark" class="form-grid">
        <label class="field span-2"><span class="field-label">对局</span><select class="select" name="matchId" required>${opts(matches.map(m=>[m.id,`${gameName(m.gameId)} · ${new Date(m.createdAt).toLocaleString()} · ${m.moveCount} 手`]))}</select></label>
        <label class="field"><span class="field-label">完成第几手后的局面</span><input class="input" type="number" name="step" value="0" min="0" step="1" required /></label>
        <label class="field"><span class="field-label">模型配置</span><select class="select" name="modelId" required>${opts(boot.models.map(m=>[m.id,m.name]))}</select></label>
        <label class="field"><span class="field-label">重复次数（每组）</span><input class="input" type="number" name="repetitions" value="3" min="1" max="5" required /></label>
        <label class="field"><span class="field-label">规则辅助</span><select class="select" name="moveMode">${opts([['assisted','规则辅助'],['pure','纯模型']])}</select></label>
        <div class="span-2"><span class="field-label">对比设置 · 根据所选模型提供</span><div id="monitor-variants" class="monitor-variants"></div></div>
        <div class="span-2 form-actions"><span id="monitor-benchmark-note" class="caption"></span><button class="btn btn-primary" type="submit">开始测速</button></div>
      </form><div id="monitor-benchmarks"></div></div></details>
    <section id="monitor-detail" class="card card-pad" hidden></section>
    <details class="monitor-help"><summary>指标说明</summary><p class="caption">整步耗时包含等待和重试。首输出包含思考；思考输出阶段是首输出到答案开始的间隔，不等于全部内部推理时间。缺失数据不作推算。旧记录只有成功落子的部分数据。默认不记录提示词、回答或完整思考正文。</p></details>
  </div>`,'monitor');
  const root=document.querySelector('.monitor-page');
  const form=root.querySelector('#monitor-benchmark');
  function syncMatchChoices(choices){
    const select=root.querySelector('[data-monitor-filter="matchId"]');
    const expected=(choices??[]).map(m=>m.id).join('|');
    if(select.dataset.items!==expected){select.innerHTML=opts([['','全部对局'],...(choices??[]).map(m=>[m.id,matchChoiceLabel(m)])],filters.matchId);select.dataset.items=expected;}
    else for(const match of choices??[]){const option=[...select.options].find(o=>o.value===match.id);if(option)option.textContent=matchChoiceLabel(match);}
  }
  function syncFilterControls(){
    root.querySelectorAll('[data-monitor-filter]').forEach(select=>{select.title=select.selectedOptions[0]?.textContent??'';});
    const extra=['effort','task','pace','moveMode'].filter(key=>filters[key]).length;
    root.querySelector('#monitor-more-filters-label').textContent='更多筛选'+(extra?'（'+extra+' 项）':'');
    root.querySelector('[data-monitor-clear]').disabled=!Object.values(filters).some(Boolean);
  }
  function paintMatch(){
    if(!matchView)return;
    const view=filterMatchTiming(matchView,filters),body=root.querySelector('#monitor-match-body');
    const signature=JSON.stringify({...view,metric:matchMetric,active:view.active.map(({elapsedMs,...r})=>r)});
    if(signature!==matchSignature){
      const scrolls=[...body.querySelectorAll('.monitor-chart-scroll,.monitor-table-wrap')].map(e=>e.scrollLeft);
      const open=new Set([...body.querySelectorAll('details[open][data-monitor-disclosure]')].map(e=>e.dataset.monitorDisclosure));
      body.innerHTML=renderMatchComparison(view,matchMetric);
      [...body.querySelectorAll('.monitor-chart-scroll,.monitor-table-wrap')].forEach((e,i)=>{e.scrollLeft=scrolls[i]??0;});
      body.querySelectorAll('[data-monitor-disclosure]').forEach(e=>{e.open=open.has(e.dataset.monitorDisclosure);});
      matchSignature=signature;
    }
    body.querySelectorAll('[data-match-elapsed]').forEach(element=>{const row=view.active.find(r=>r.id===element.dataset.matchElapsed);if(row)element.textContent=seconds(row.elapsedMs);});
  }
  async function loadMatch(){
    const epoch=++matchEpoch,id=filters.matchId;
    root.querySelector('#monitor-match-panel').hidden=!id;
    if(!id){matchView=null;matchSignature='';return;}
    try{
      const view=await api('/api/monitor/matches/'+encodeURIComponent(id));
      if(alive()&&epoch===matchEpoch&&id===filters.matchId){matchView=view;paintMatch();}
    }catch(error){if(alive()&&epoch===matchEpoch)root.querySelector('#monitor-match-body').innerHTML='<div class="notice notice-warn">'+esc(error.message)+'</div>';}
  }
  function variants(){
    const model=boot.models.find(m=>m.id===form.elements.modelId.value);
    const adapter=model?.reasoning?.adapter??'auto';
    const native=boot.reasoningProfiles?.[adapter]?.efforts??['default'];
    const values=adapter==='auto'?[['default|default','跟随服务（能力未确认）']]:[['off|default','关闭思考'],['on|default','开启思考 · 默认强度'],...native.filter(v=>v!=='default').map(v=>['on|'+v,(adapter==='kvmem'?'引擎扩展 ':'原生 ')+v])];
    root.querySelector('#monitor-variants').innerHTML=values.map(([value,label],i)=>`<label class="checkline"><input type="checkbox" name="variant" value="${esc(value)}" ${i<2?'checked':''} />${esc(label)}</label>`).join('');
  }
  variants();
  function detail(row){
    selected=row.id;const box=root.querySelector('#monitor-detail');box.hidden=false;
    const t=row.timing??row.requestTiming??row;
    const u=row.usage??{};
    const link=row.matchId?`<a class="btn btn-sm" href="#/replay/${encodeURIComponent(row.matchId)}?step=${Number(row.step??0)}">查看对应回放 · 第 ${number(row.step)} 手</a>`:'';
    box.innerHTML=`<div class="side-card-head"><h2 class="section-title">请求详情 · ${esc(row.modelName??row.modelId)}</h2>${link}</div>
      <div class="monitor-timeline">${[['排队',row.queueMs],['首输出（含思考）',t.firstOutputMs],['答案开始',t.firstAnswerMs],['请求总耗时',row.elapsedMs]].map(([label,value])=>`<div><span class="caption">${label}</span><strong>${seconds(value)}</strong></div>`).join('')}</div>
      <p>${progress(row)} · ${esc(tasks[row.task]??row.task)} · ${esc(gameName(row.gameId))} · ${esc(pace(row.pace))}</p>
      <p class="caption">输入 ${number(u.prompt_tokens)} tokens · 输出（含思考）${number(u.completion_tokens)} tokens · 思考 ${number(u.completion_tokens_details?.reasoning_tokens)} tokens · 输出上限 ${number(row.maxTokens)} tokens</p>
      ${row.errorCode?`<p class="notice notice-warn">${esc(row.errorCode)}</p>`:''}
      <details class="rules-details"><summary>本次推理参数与来源</summary><pre>${esc(JSON.stringify({requested:row.reasoning,serviceDefault:row.serviceDefault??'未提供',finishReason:row.finishReason??'未记录',promptHash:row.promptHash??undefined},null,2))}</pre></details>`;
  }
  function paint(next){
    data=next;
    syncMatchChoices(next.matches??matches);syncFilterControls();
    root.querySelector('#monitor-kpis').hidden=Boolean(filters.matchId);
    root.querySelector('#monitor-active-section').hidden=Boolean(filters.matchId)||!next.active.length;
    root.querySelector('#monitor-trend-section').hidden=Boolean(filters.matchId);
    root.querySelector('#monitor-match-panel').hidden=!filters.matchId;
    root.querySelector('#monitor-health').textContent=`更新于 ${new Date(next.updatedAt).toLocaleTimeString()} · 桌宠指标${next.bridgeOnline?'已连接':'未连接（Arena 指标正常）'} · 当前筛选 ${next.count} 次历史请求`;
    const rows=next.recent;
    const total=next.groups.reduce((n,g)=>n+g.count,0);
    const sum=next.groups.reduce((n,g)=>n+(g.meanMs??0)*g.count,0);
    root.querySelector('#monitor-kpis').innerHTML=[['活动请求',next.active.length],['请求数',next.count],['平均耗时',total?seconds(sum/total):'—']].map(([label,value])=>`<div class="card monitor-kpi"><span class="caption">${label}</span><strong>${esc(value)}</strong></div>`).join('');
    root.querySelector('#monitor-active').innerHTML=next.active.map(r=>`<button class="monitor-request" data-request="${esc(r.id)}"><div><strong>${esc(r.modelName??r.modelId)}</strong><span class="caption">${esc(tasks[r.task]??r.task)} · ${esc(gameName(r.gameId))}</span></div>${progress(r)}<span class="chip">${esc(effort(r))}</span><strong>${seconds(r.elapsedMs)}</strong></button>`).join('')||'<div class="monitor-empty">当前没有活动请求。对局与桌宠请求会自动出现在这里。</div>';
    root.querySelector('#monitor-chart').innerHTML=renderRequestChart(rows.slice(0,40).reverse());
    root.querySelector('#monitor-groups').innerHTML=`<table class="monitor-table"><thead><tr><th>模型与推理设置</th><th>游戏／条件</th><th>样本</th><th>平均</th><th>中位数</th><th>P95</th><th>平均输出</th><th>异常／样本</th><th>合法率</th></tr></thead><tbody>${next.groups.map(g=>`<tr><td><strong>${esc(g.modelName??g.modelId)}</strong><span class="caption">${esc(effort(g))}</span></td><td>${esc(gameName(g.gameId))}<span class="caption">${esc(tasks[g.task]??g.task)} · ${esc(pace(g.pace))} · ${g.moveMode==='assisted'?'规则辅助':g.moveMode==='pure'?'纯模型':'—'}</span></td><td>${g.count}</td><td>${seconds(g.meanMs)}</td><td>${seconds(g.medianMs)}</td><td>${seconds(g.p95Ms)}</td><td>${number(g.meanOutputTokens)}<span class="caption">tokens，含思考</span></td><td>${g.failureCount} / ${g.count}<span class="caption">超时 ${g.timeoutCount}</span></td><td>${g.legalRate===null?'未校验':Math.round(g.legalRate*100)+'%'}</td></tr>`).join('')}</tbody></table>`;
    root.querySelector('#monitor-recent').innerHTML=`<table class="monitor-table"><thead><tr><th>模型／任务</th><th>推理设置</th><th>状态</th><th>耗时</th><th>输入</th><th>输出</th><th>思考</th></tr></thead><tbody>${rows.slice(0,recentLimit).map(r=>`<tr data-request="${esc(r.id)}" tabindex="0" role="button" aria-label="查看请求详情"><td>${esc(r.modelName??r.modelId)}<span class="caption">${new Date(r.startedAt).toLocaleString()} · ${esc(tasks[r.task]??r.task)}</span></td><td>${esc(effort(r))}</td><td>${progress(r)}</td><td>${seconds(r.elapsedMs)}</td><td>${number(r.usage?.prompt_tokens)}</td><td>${number(r.usage?.completion_tokens)}</td><td>${number(r.usage?.completion_tokens_details?.reasoning_tokens)}</td></tr>`).join('')}</tbody></table>`;
    const exportLink=root.querySelector('#monitor-export');exportLink.href='/api/monitor/export?'+new URLSearchParams(filters);
    for(const [key,values] of Object.entries(next.options)){
      if(key!=='modelId'&&key!=='effort')continue;
      const select=root.querySelector(`[data-monitor-filter="${key}"]`);
      for(const value of values)if(![...select.options].some(o=>o.value===value))select.add(new Option(value,value));
    }
    const runningBenchmark=next.benchmarks.some(j=>j.status==='running');
    const benchmarkState=root.querySelector('#monitor-benchmark-state');benchmarkState.textContent=runningBenchmark?'正在测速':'按需启动';benchmarkState.classList.toggle('is-running',runningBenchmark);
    root.querySelector('#monitor-benchmarks').innerHTML=next.benchmarks.map(j=>`<div class="monitor-benchmark-status"><span>测速 ${esc(j.id.slice(0,8))} · ${j.done}/${j.total} · ${esc({running:'运行中',completed:'已完成',cancelled:'已取消',failed:'失败'}[j.status]??j.status)}</span>${j.status==='running'?`<button class="btn btn-sm" data-benchmark-cancel="${esc(j.id)}">取消测速</button>`:''}</div>`).join('');
    if(selected){const row=[...next.active,...rows,...(matchView?.requests??[]),...(matchView?.active??[])].find(r=>r.id===selected);if(row)detail(row);}
  }
  let refreshAgain=false;
  async function refresh(){
    if(!alive()||document.hidden)return;
    if(busy){refreshAgain=true;return;}
    busy=true;const signature=JSON.stringify(filters);
    try{const next=await api('/api/monitor?'+new URLSearchParams(filters));
      if(alive()&&signature===JSON.stringify(filters)){paint(next);await loadMatch();}else refreshAgain=true;
    }catch(e){if(alive())root.querySelector('#monitor-health').textContent='指标暂时不可用：'+e.message;}
    finally{busy=false;if(refreshAgain){refreshAgain=false;void refresh();}}
  }
  function changedFilter(){
    selected=null;root.querySelector('#monitor-detail').hidden=true;syncFilterControls();
    const params=new URLSearchParams();if(filters.matchId)params.set('match',filters.matchId);
    history.replaceState(null,'','#/monitor'+(params.size?'?'+params:''));
    void refresh();
  }
  root.addEventListener('change',event=>{
    if(event.target.matches('[data-match-metric]')){matchMetric=event.target.value;paintMatch();}
    const key=event.target.dataset.monitorFilter;
    if(key){if(key==='matchId'){matchView=null;matchSignature='';root.querySelector('#monitor-match-body').innerHTML='<div class="monitor-empty">正在加载…</div>';root.querySelector('#monitor-match-panel').hidden=!event.target.value;}filters[key]=event.target.value;changedFilter();}
    if(event.target.name==='modelId')variants();
  });
  root.addEventListener('click',async event=>{
    if(event.target.closest('[data-monitor-clear]')){
      for(const key of Object.keys(filters))delete filters[key];filters.matchId='';
      root.querySelectorAll('[data-monitor-filter]').forEach(select=>{select.value='';});
      matchView=null;matchSignature='';changedFilter();
    }
    const jump=event.target.closest('[data-monitor-jump]');
    if(jump)root.querySelector('#'+jump.dataset.monitorJump)?.scrollIntoView({block:'start',behavior:'smooth'});
    if(event.target.closest('[data-monitor-more]')){recentLimit=Math.min(500,recentLimit+25);paint(data);}
    const target=event.target.closest('[data-request]');
    if(target){const row=[...data.active,...data.recent,...(matchView?.requests??[]),...(matchView?.active??[])].find(r=>r.id===target.dataset.request);if(row){detail(row);root.querySelector('#monitor-detail').scrollIntoView({block:'nearest',behavior:'smooth'});}}
    const cancel=event.target.closest('[data-benchmark-cancel]');
    if(cancel){try{await api('/api/monitor/benchmarks/'+cancel.dataset.benchmarkCancel+'/cancel',{method:'POST',body:{}});refresh();}catch(error){root.querySelector('#monitor-benchmark-note').textContent=error.message;}}
  });
  root.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.matches('[data-request]'))event.target.click();});
  form.addEventListener('submit',async event=>{
    event.preventDefault();const values=new FormData(form),button=form.querySelector('[type=submit]');
    const variants=values.getAll('variant').map(v=>{const [thinkingMode,reasoningEffort]=v.split('|');return{thinkingMode,reasoningEffort};});
    button.disabled=true;
    try{await api('/api/monitor/benchmarks',{method:'POST',body:{matchId:values.get('matchId'),modelId:values.get('modelId'),step:Number(values.get('step')),repetitions:Number(values.get('repetitions')),moveMode:values.get('moveMode'),variants}});root.querySelector('#monitor-benchmark-note').textContent='测速已启动，可在上方观察请求。';refresh();}
    catch(e){root.querySelector('#monitor-benchmark-note').textContent=e.message;}finally{button.disabled=false;}
  });
  paint(initial);
  if(filters.matchId)await loadMatch();
  if(!alive())return ()=>{};
  const positionFilters=()=>{const sidebar=document.querySelector('.sidebar');root.style.setProperty('--monitor-filter-top',(innerWidth<=820?(sidebar?.getBoundingClientRect().height??56)+6:8)+'px');};
  const sidebar=document.querySelector('.sidebar');const observer=new ResizeObserver(positionFilters);if(sidebar)observer.observe(sidebar);
  window.addEventListener('resize',positionFilters);positionFilters();
  timer=setInterval(refresh,1500);
  return ()=>{stopped=true;clearInterval(timer);observer.disconnect();window.removeEventListener('resize',positionFilters);};
}
