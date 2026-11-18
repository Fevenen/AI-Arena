import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const finite = value => Number.isFinite(value) ? value : null;
export function summarizeRequests(records) {
  const groups = new Map();
  for (const row of records) {
    const key = JSON.stringify([row.modelId, row.modelName, row.reasoning?.adapter, row.reasoning?.label ?? '旧记录：档位未知', row.gameId, row.task, row.pace, row.moveMode, row.benchmarkId ? 'benchmark' : 'game']);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(rows => {
    const times = rows.map(r => r.elapsedMs).filter(Number.isFinite).sort((a,b) => a-b);
    const average = values => values.length ? Math.round(values.reduce((a,b)=>a+b,0) / values.length) : null;
    const valid = rows.filter(r => r.legal === true).length;
    const checked = ['move','timed_move','benchmark'].includes(rows[0].task) ? rows.length : rows.filter(r => typeof r.legal === 'boolean').length;
    return { modelId: rows[0].modelId, modelName: rows[0].modelName, reasoning: rows[0].reasoning,
      gameId: rows[0].gameId, task: rows[0].task, pace: rows[0].pace, moveMode: rows[0].moveMode,
      benchmark: Boolean(rows[0].benchmarkId), count: rows.length,
      meanMs: average(times), medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
      p95Ms: times.length ? times[Math.ceil(times.length * .95)-1] : null,
      failureCount: rows.filter(r => !['completed','legacy_completed'].includes(r.status)).length,
      timeoutCount: rows.filter(r => /timeout/.test(r.errorCode ?? '')).length,
      legalRate: checked ? valid / checked : null,
      meanOutputTokens: average(rows.map(r=>r.usage?.completion_tokens).filter(Number.isFinite)),
    };
  });
}

export class ModelMonitor {
  constructor(dir) {
    this.dir = dir; this.file = path.join(dir, 'requests.jsonl'); this.active = new Map(); this.records = [];
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file,'utf8').split('\n').slice(-20001)) {
        try { const row=JSON.parse(line); if(row.id && row.origin==='arena') this.records.push(row); } catch {}
      }
    }
  }
  persist(row) {
    fs.mkdirSync(this.dir,{recursive:true});
    fs.appendFileSync(this.file, JSON.stringify(row)+'\n',{mode:0o600});
  }
  start(metadata) {
    const row = { ...metadata, id: randomUUID(), origin:'arena', startedAt:new Date().toISOString(), stage:'requesting', status:'running' };
    const started=Date.now(); this.active.set(row.id,row);
    let done=false;
    const update=(stage,patch={})=>{Object.assign(row,patch,{stage,elapsedMs:Date.now()-started});};
    return { id:row.id, update, row,
      finish:(status,patch={})=>{
        if(done)return; done=true; update(status,patch); row.status=status; row.finishedAt=new Date().toISOString();
        this.active.delete(row.id); this.records.push(row); this.records=this.records.slice(-20000); this.persist(row);
      },
    };
  }
  outcome(id, legal, errorCode=null) {
    const row=this.records.findLast(r=>r.id===id);
    if(row){
      row.legal=legal;
      if(errorCode){row.errorCode=errorCode;if(row.status!=='truncated')row.status='invalid';row.stage=row.status;}
      else if(legal && row.status==='truncated'){row.status='completed';row.stage='completed';}
      this.persist(row);
    }
  }
  snapshot({historical=[],external=[],filters={},limit=500}={}) {
    const map=new Map();
    for(const row of [...historical,...this.records,...external.filter(r=>r.status!=='running')])map.set(row.id,row);
    const matches=r=>Object.entries(filters).every(([key,value])=>!value || String(key==='effort' ? r.reasoning?.label ?? '旧记录：档位未知' : r[key] ?? '')===String(value));
    const all=[...map.values()].filter(matches).sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt)));
    const active=[...this.active.values(),...external.filter(r=>r.status==='running')].filter(matches).map(r=>({...r,elapsedMs:Date.now()-Date.parse(r.startedAt)}));
    return { active, recent:all.slice(0,limit), groups:summarizeRequests(all), count:all.length,
      options:{modelId:[...new Set([...map.values()].map(r=>r.modelId).filter(Boolean))],gameId:[...new Set([...map.values()].map(r=>r.gameId).filter(Boolean))],effort:[...new Set([...map.values()].map(r=>r.reasoning?.label??'旧记录：档位未知'))]},
      recordedSince:this.records[0]?.startedAt??null, updatedAt:new Date().toISOString() };
  }
}

export function legacyRequests(matches) {
  const rows=[];
  for(const match of matches){for(const action of match.actions??[]){
    if(!['model','dafeiyu'].includes(action.source) || action.modelMeta?.monitorId || !Number.isFinite(action.metrics?.elapsedMs))continue;
    const meta=action.modelMeta??{};const usage=meta.tokenUsage;
    rows.push({id:`legacy:${match.id}:${action.index}`,origin:'legacy',modelId:meta.modelId??action.sourceName,modelName:action.sourceName,
      matchId:match.id,step:action.index,gameId:match.gameId,task:'move',pace:match.aiPace??'quality',moveMode:action.metrics.moveMode,
      startedAt:action.at,status:'legacy_completed',stage:'completed',elapsedMs:action.metrics.elapsedMs,timing:meta.requestTiming,
      reasoning:{label:meta.reasoning?.label??'旧记录：档位未验证',recordedEffort:meta.reasoningEffort??null,confirmation:'unverified'},
      usage:usage?{prompt_tokens:usage.promptTokens,completion_tokens:usage.completionTokens,completion_tokens_details:{reasoning_tokens:usage.reasoningTokens}}:null,
      attempts:action.metrics.attempts,legal:true});
  }}
  return rows;
}
