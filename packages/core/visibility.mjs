/**
 * 未来桌游的私有信息按座位或公开范围标记。当前五子棋全部为公开信息，
 * 但存储与传输入口从第一版起就走同一套可见性过滤。
 */
export function isVisibleTo(item, viewer) {
  const visibility = item?.visibility ?? 'public';
  if (visibility === 'public') return true;
  if (visibility === 'observer') return viewer?.role === 'observer';
  if (visibility.startsWith('seat:')) {
    return viewer?.seat === visibility.slice('seat:'.length);
  }
  // 未知范围默认不发送，避免未来游戏误把私密数据公开。
  return false;
}

export function filterVisible(items, viewer) {
  return (Array.isArray(items) ? items : []).filter((item) => isVisibleTo(item, viewer));
}
