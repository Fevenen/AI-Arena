// Apply the same visible request filters to the per-seat comparison.
export function filterMatchTiming(view,filters={}) {
  const keys=['modelId','gameId','effort','task','pace','moveMode'];
  if(!keys.some(key=>filters[key]))return view;
  const accepts=row=>Boolean(row)&&keys.every(key=>!filters[key]||String(key==='effort'?row.reasoning?.label??'旧记录：档位未知':row[key]??'')===String(filters[key]));
  const requests=view.requests.filter(accepts),active=view.active.filter(accepts);
  const requestMap=new Map(requests.map(row=>[row.id,row]));
  const average=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
  const total=values=>values.length?values.reduce((a,b)=>a+b,0):null;
  const seats=view.seats.map(seat=>{
    const moves=seat.moves.filter(move=>requestMap.has(move.requestId));
    const measured=moves.map(m=>m.totalMs).filter(Number.isFinite);
    const reasoning=moves.map(m=>m.reasoningMs).filter(Number.isFinite);
    const output=moves.map(m=>m.outputTokens).filter(Number.isFinite);
    return {...seat,moves,moveCount:moves.length,timedMoves:measured.length,totalMs:total(measured),meanMs:average(measured),
      maxMs:measured.length?Math.max(...measured):null,reasoningMs:total(reasoning),reasoningMeasuredMoves:reasoning.length,
      outputTokens:total(output),outputMeasuredMoves:output.length,reasoningSettings:[...new Set(moves.map(m=>m.reasoning))],
      abnormalRequests:requests.filter(r=>r.seat===seat.id&&r.origin!=='legacy'&&!['completed','legacy_completed'].includes(r.status)).length};
  }).filter(seat=>seat.moves.length||active.some(row=>row.seat===seat.id));
  const steps=new Set(seats.flatMap(seat=>seat.moves.map(move=>move.step)));
  const rows=view.rows.map(row=>({...row,cells:Object.fromEntries(seats.map(seat=>[seat.id,row.cells[seat.id]&&steps.has(row.cells[seat.id].step)?row.cells[seat.id]:null]))})).filter(row=>Object.values(row.cells).some(Boolean));
  return {...view,seats,rows,requests,active,unfinished:view.unfinished.filter(accepts)};
}
