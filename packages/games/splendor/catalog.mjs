// Published card costs and points, cross-checked against the transcription at
// https://github.com/boardgamers/splendor/blob/main/packages/engine/src/data.ts
// Six digits per card: prestige, white, blue, green, red, black.
export const COLORS = ['W', 'U', 'G', 'R', 'B'];
export const TOKENS = [...COLORS, 'Y'];
export const COLOR_NAMES = { W: '钻石', U: '蓝宝石', G: '翡翠', R: '红宝石', B: '缟玛瑙', Y: '黄金' };
const groups = [
  [1, 'W', '001111 001211 002201 011003 001020 022000 000300 100400'],
  [1, 'U', '010111 010121 010220 001310 012000 020200 003000 100040'],
  [1, 'G', '011011 011012 021020 010310 000102 002020 000030 100004'],
  [1, 'R', '011101 021101 020102 013001 000210 002002 000003 100004'],
  [1, 'B', '011110 011120 020120 001031 000210 020200 000300 104000'],
  [2, 'W', '100322 120033 200142 203050 200005 300006'],
  [2, 'U', '102230 103203 250300 224010 200500 300060'],
  [2, 'G', '130032 123002 202004 200530 205000 300600'],
  [2, 'R', '120023 120303 210042 200035 200005 300060'],
  [2, 'B', '132200 132002 201420 200530 250000 300006'],
  [3, 'W', '303335 400007 436003 507003'],
  [3, 'U', '330335 470000 463003 570003'],
  [3, 'G', '353033 407000 433600 500730'],
  [3, 'R', '333305 400700 430360 503700'],
  [3, 'B', '333530 400070 430063 530070'],
];
export const CARDS = groups.flatMap(([tier, bonus, values]) => values.split(' ').map((value, index) => ({
  id: `${tier}${bonus}${index + 1}`, tier, bonus, points: Number(value[0]),
  cost: Object.fromEntries(COLORS.map((color, i) => [color, Number(value[i + 1])]).filter(([, amount]) => amount)),
})));
export const CARD = Object.fromEntries(CARDS.map(card => [card.id, card]));
export const NOBLES = ['00440', '04400', '44000', '40004', '00044', '03330', '30330', '33003', '00333', '33300']
  .map((value, index) => ({ id: `N${index + 1}`, points: 3,
    cost: Object.fromEntries(COLORS.map((color, i) => [color, Number(value[i])]).filter(([, amount]) => amount)),
  }));
