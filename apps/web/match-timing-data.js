const finite=value=>Number.isFinite(value)&&value>=0?value:null;
const sum=values=>values.length?values.reduce((a,b)=>a+b,0):null;
const mean=values=>values.length?sum(values)/values.length:null;
const moveRequest=row=>['move','timed_move'].includes(row.task)&&!row.benchmarkId;

// Consume the observer-visible match, never private state or prompts.
export function buildMatchTiming(match, records=[], active=[]) {
  const requests=records.filter(r=>r.matchId===match.id&&moveRequest(r));
  const running=active.filter(r=>r.matchId===match.id&&moveRequest(r));
  const seats=(match.seatOrder??Object.keys(match.seats??{})).filter(id=>match.seats?.[id]).map(id=>{
    const seat=match.seats[id];
    return {id,label:seat.colorName??seat.shortName??seat.name??id,name:seat.name??seat.modelName??'未命名棋手',kind:seat.kind,moves:[]};
  });
  const bySeat=new Map(seats.map(s=>[s.id,s]));
  for(const action of match.actions??[]) {
    const seat=bySeat.get(action.seat);if(!seat)continue;
    const meta=action.modelMeta??{};
    const relevant=requests.filter(r=>r.id===meta.monitorId || (r.step===action.index&&(!r.seat||r.seat===action.seat)));
    const actual=relevant.filter(r=>r.origin!=='legacy');
    const preferred=actual.find(r=>r.id===meta.monitorId)??actual.findLast(r=>r.legal===true)??actual.at(-1)??relevant.at(-1);
    const timing=meta.requestTiming??preferred?.timing??preferred?.requestTiming??preferred??{};
    const firstOutputMs=finite(timing.firstOutputMs),firstAnswerMs=finite(timing.firstAnswerMs);
    const reasoningMs=firstOutputMs!==null&&firstAnswerMs!==null&&firstAnswerMs>=firstOutputMs?firstAnswerMs-firstOutputMs:null;
    const queueValues=actual.map(r=>finite(r.queueMs));
    const queueMs=queueValues.length&&queueValues.every(v=>v!==null)?sum(queueValues):null;
    const metric=action.metrics??{};
    const totalMs=['human','system'].includes(action.source)?null:finite(metric.elapsedMs);
    const usage=meta.tokenUsage;
    const move={step:action.index,seat:action.seat,ordinal:seat.moves.length+1,source:action.source,
      totalMs,queueMs,firstOutputMs,firstAnswerMs,reasoningMs,
      attempts:metric.attempts??(actual.length||null),
      outputTokens:usage?.completionTokens??preferred?.usage?.completion_tokens??null,
      reasoningTokens:usage?.reasoningTokens??preferred?.usage?.completion_tokens_details?.reasoning_tokens??null,
      reasoning:meta.reasoning?.label??preferred?.reasoning?.label??'旧记录：档位未验证',
      requestId:preferred?.id??null,
    };
    seat.moves.push(move);
  }
  for(const seat of seats) {
    const measured=seat.moves.map(m=>m.totalMs).filter(v=>v!==null);
    const reasoning=seat.moves.map(m=>m.reasoningMs).filter(v=>v!==null);
    const output=seat.moves.map(m=>finite(m.outputTokens)).filter(v=>v!==null);
    const seatRequests=requests.filter(r=>r.seat===seat.id&&r.origin!=='legacy');
    Object.assign(seat,{moveCount:seat.moves.length,timedMoves:measured.length,totalMs:sum(measured),meanMs:mean(measured),
      maxMs:measured.length?Math.max(...measured):null,reasoningMs:sum(reasoning),reasoningMeasuredMoves:reasoning.length,
      outputTokens:sum(output),outputMeasuredMoves:output.length,
      abnormalRequests:seatRequests.filter(r=>!['completed','legacy_completed'].includes(r.status)).length,
      reasoningSettings:[...new Set(seat.moves.map(m=>m.reasoning))],
    });
  }
  const rows=Array.from({length:Math.max(0,...seats.map(s=>s.moves.length))},(_,index)=>({ordinal:index+1,cells:Object.fromEntries(seats.map(s=>[s.id,s.moves[index]??null]))}));
  const unfinished=requests.filter(r=>r.origin!=='legacy'&&!['completed','legacy_completed'].includes(r.status));
  return {match:{id:match.id,gameId:match.gameId,gameName:match.gameName,status:match.status,createdAt:match.createdAt,aiPace:match.aiPace??'quality',pending:match.pending??null},
    seats,rows,requests,active:running,unfinished};
}
