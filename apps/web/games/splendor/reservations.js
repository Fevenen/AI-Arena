// Reconstruct only information that appeared in the public market/history.
// Never inspect seatViews, deck order or a blind-reserved card's identity.
export function publicReservations(steps) {
  const held={};
  for(let index=1;index<steps.length;index++){
    const step=steps[index],previous=steps[index-1]?.view;
    const action=step.action?.action;
    if(typeof action!=='string'||!step.seat)continue;
    const [type,target]=action.split(':');
    held[step.seat]??=[];
    if(type==='reserve'&&!target?.startsWith('deck')){
      const card=Object.values(previous?.market??{}).flat().find(card=>card.id===target);
      if(card&&!held[step.seat].some(c=>c.id===card.id))held[step.seat].push(card);
    }
    if(type==='buy')held[step.seat]=held[step.seat].filter(card=>card.id!==target);
  }
  const view=steps.at(-1)?.view;
  return Object.fromEntries((view?.seats??[]).map(seat=>{
    const count=view.players?.[seat]?.reservedCount??0;
    const cards=(held[seat]??[]).slice(0,count);
    return [seat,{cards,hiddenCount:Math.max(0,count-cards.length)}];
  }));
}
