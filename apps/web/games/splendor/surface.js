const colors = { W: '白', U: '蓝', G: '绿', R: '红', B: '黑', Y: '金' };
const token = (color, value) => '<span class="spl-token spl-' + color + '">' + colors[color] + value + '</span>';
const tokens = values => Object.entries(values ?? {}).filter(([, amount]) => amount).map(([color, amount]) => token(color, amount)).join(' ');
const title = { action: '选择拿取、预留或购买', return: '请归还超出 10 枚的筹码', noble: '请选择一位到访的贵族', finished: '对局结束' };

function label(action) {
  const [type, target] = action.split(':');
  if (type === 'take' || type === 'return') return (type === 'take' ? '拿取 ' : '归还 ') + [...target].map(color => colors[color]).join('、');
  if (type === 'reserve') return target.startsWith('deck') ? '盲预留第 ' + target.at(-1) + ' 级' : '预留';
  if (type === 'buy') return '购买';
  if (type === 'noble') return '接待 ' + target;
  return '跳过';
}

function button(action, esc) {
  return '<button type="button" class="btn btn-quiet btn-sm" data-action="splendor-action" data-move="' + esc(action) + '">' + esc(label(action)) + '</button>';
}

export function renderSplendor({ match, view, interactive, humanColor, replay, reservedView }, escapeHtml, escapeAttr) {
  if (!view?.bank) return '';
  const name = seat => {
    const item = match.seats?.[seat];
    return escapeHtml([...new Set([item?.colorName, item?.name].filter(Boolean))].join(' · ') || seat || '—');
  };
  const choices = interactive ? view.choices ?? [] : [];
  const has = action => choices.includes(action);
  const gold = humanColor ? view.players[humanColor]?.tokens.Y : 0;
  const payment = card => gold ? '<details><summary>黄金分配</summary><form data-form="splendor-payment" data-card="' + card.id
    + '"><input name="gold" aria-label="指定黄金替代色" placeholder="WUGRB" pattern="[WUGRBwugrb]{1,5}" required maxlength="5">'
    + '<button type="submit" class="btn btn-quiet btn-sm">确认</button></form></details>' : '';
  const cards = (card, reservable) => '<article class="spl-card" data-bonus="' + card.bonus + '"><header>' + token(card.bonus, '+1')
    + '<strong>' + card.points + ' 分</strong><small>' + card.id + '</small></header><div class="spl-cost" aria-label="牌价">'
    + tokens(card.cost) + '</div><footer>' + (has('buy:' + card.id) ? button('buy:' + card.id, escapeAttr) + payment(card) : '')
    + (reservable && has('reserve:' + card.id) ? button('reserve:' + card.id, escapeAttr) : '') + '</footer></article>';
  const playerRows = view.seats.map(seat => {
    const player = view.players[seat];
    return '<section class="spl-player' + (view.turn === seat ? ' active' : '') + '"><strong>' + name(seat)
      + ' · ' + player.points + ' 分</strong><div>筹码 ' + (tokens(player.tokens) || '—') + '</div><div>折扣 '
      + (tokens(Object.fromEntries(Object.entries(player.bonuses).filter(([color]) => color !== 'Y'))) || '—') + '</div><small>已购 '
      + player.boughtCount + ' · 预留 ' + player.reservedCount + ' · 贵族 ' + player.nobles.length + '</small></section>';
  }).join('');
  const nobles = view.nobles.map(noble => '<article class="spl-noble"><strong>贵族 ' + noble.id + ' · 3 分</strong><div>'
    + tokens(noble.cost) + '</div>' + (has('noble:' + noble.id) ? button('noble:' + noble.id, escapeAttr) : '') + '</article>').join('');
  const market = Object.entries(view.market).reverse().map(([tier, row]) =>
    '<section class="spl-tier"><div class="spl-deck"><strong>' + tier + ' 级</strong><small>' + view.deckCounts[tier]
      + ' 张暗牌</small>' + (has('reserve:deck' + tier) ? button('reserve:deck' + tier, escapeAttr) : '')
      + '</div>' + row.map(card => cards(card, true)).join('') + '</section>').join('');
  const own = humanColor && view.players[humanColor]?.reserved;
  const reservedGroups=view.seats.filter(seat=>seat!==humanColor||!own).map(seat=>{
    const count=view.players[seat]?.reservedCount??0;
    const visible=reservedView?.[seat]?.cards??[];
    const hidden=Math.max(0,count-visible.length);
    return '<section class="spl-reserve-group"><h4>'+name(seat)+' · 预留 '+count+' 张</h4><div class="spl-reserve-cards">'
      +visible.map(card=>cards(card,false)).join('')
      +Array.from({length:hidden},()=>'<article class="spl-card spl-card-back"><strong>预留牌</strong><span>牌面未公开</span></article>').join('')
      +(count?'':'<span class="caption">暂无预留</span>')+'</div></section>';
  }).join('');
  const outcome = view.outcome?.standings?.map(item => name(item.seat) + ' ' + item.points + ' 分').join(' · ');
  const resourceActions = choices.filter(action => /^(take:|return:|pass$)/.test(action));
  return '<section class="board-card splendor-surface"><header class="spl-heading"><div><strong>璀璨宝石</strong><p>第 '
    + view.round + ' 轮' + (view.finalRound ? ' · 最后一轮' : '') + '</p></div><span>'
    + (outcome ? '结算 · ' + outcome : replay ? '历史牌桌' : name(view.turn) + '行动') + '</span></header>'
    + '<div class="spl-players">' + playerRows + '</div><section class="spl-bank"><strong>库存</strong> '
    + Object.entries(view.bank).map(([color, amount]) => token(color, amount)).join(' ') + '</section>'
    + (interactive ? '<div class="spl-actions"><strong>' + title[view.phase] + '</strong><div>'
      + resourceActions.map(action => button(action, escapeAttr)).join(' ') + '</div></div>' : '')
    + '<section class="spl-noble-area" aria-label="贵族"><h3>贵族</h3><div class="spl-nobles">' + nobles + '</div></section>'
    + '<section class="spl-market" aria-label="卡牌市场"><h3>卡牌市场</h3>' + market + '</section>'
    + '<section class="spl-reservations" aria-label="各方预留牌"><h3>各方预留牌</h3><p class="caption">公开市场预留的牌可查看；盲预留显示牌背。预留不要求库存一定有黄金。</p><div class="spl-reserve-groups">'+reservedGroups+'</div></section>'
    + (own?.length ? '<section class="spl-reserved"><strong>我的预留</strong><div>' + own.map(card => cards(card, false)).join('') + '</div></section>' : '')
    + '</section>';
}
