/**
 * 展览 zone 联动（旧 Node 版 P2 契约，Java/Vue 重写时漏掉的那层）。
 *
 * 三个入口/出口，状态本身仍在 useChat.zone，这里只负责读写 URL 与 window 消息：
 *   1. URL `?zone=<zoneId|mediaId>`：页面加载时优先于 localStorage 决定当前展区；
 *   2. `window.znwdSetZone(id)`：展览播放系统直接切换，id 可为 null（清空）；
 *   3. `znwd:zone` CustomEvent：外部派发可切换本页展区；本页展区变化也向 window 广播。
 *
 * 所有函数在无 window 的 node 环境（useChat 单测）下安全空转。
 */

type ZoneSetter = (id: string | null) => void;

interface ZoneBridgeWindow extends Window {
  znwdSetZone?: ZoneSetter;
}

/** 事件来源：api = window.znwdSetZone 调用；event = 外部派发的 znwd:zone */
export type ZoneSource = 'api' | 'event';

function zoneWindow(): ZoneBridgeWindow | null {
  return typeof window === 'undefined' ? null : (window as ZoneBridgeWindow);
}

/** 读取 URL 的 `?zone=`；空串/纯空白按「没传」处理。search 参数仅供测试注入 */
export function readZoneFromUrl(search?: string): string | null {
  const source = search ?? zoneWindow()?.location?.search;
  if (source === undefined) return null;
  try {
    const value = new URLSearchParams(source).get('zone')?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

/**
 * 用 history.replaceState 同步 zone 参数（不 pushState，不污染后退历史）。
 * 保留 admin 等其它参数、hash 与当前 history.state；id 为空时删除 zone 参数。
 */
export function writeZoneToUrl(id: string | null): void {
  const win = zoneWindow();
  if (!win?.history?.replaceState) return;
  try {
    const url = new URL(win.location.href);
    if (id) url.searchParams.set('zone', id);
    else url.searchParams.delete('zone');
    win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // URL 不可写（sandbox/不透明源）时只保留页面内状态，不影响讲解
  }
}

/**
 * 向 window 广播展区变化。
 *
 * 派发是同步的，期间置一个深度标记：bindZoneBridge 的监听器看到标记就知道这是自己发出去的
 * 事件，不再回流设置——事件回声既不重复请求，也不会和其它监听器互相 ping-pong。
 */
let selfDispatchDepth = 0;

export function dispatchZoneChange(id: string | null): void {
  const win = zoneWindow();
  if (!win || typeof win.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return;
  selfDispatchDepth += 1;
  try {
    win.dispatchEvent(new CustomEvent('znwd:zone', { detail: { zone: id } }));
  } finally {
    selfDispatchDepth -= 1;
  }
}

/**
 * 绑定 window 桥：挂 `znwd:zone` 监听并暴露 `znwdSetZone`。
 *
 * handler(id, source) 的 source 区分调用来自哪条桥：
 *   - 'api'（znwdSetZone）：调用方等的是确认，由本页完成变更与广播；
 *   - 'event'（外部派发的 znwd:zone）：事件本身就是广播，本页只应用、不再回发，避免回环。
 * detail 为字符串或 `{ zone }` 都接受；空串忽略（null 只允许从 znwdSetZone 传）。
 *
 * 返回解绑函数：移除监听，并仅当 znwdSetZone 仍是这次绑定的实现时删除它
 * （先后挂载/卸载交错时不会误删后来者的桥）。
 */
export function bindZoneBridge(handler: (id: string | null, source: ZoneSource) => void): () => void {
  const win = zoneWindow();
  if (!win?.addEventListener) return () => {};

  const onEvent = (event: Event): void => {
    if (selfDispatchDepth > 0) return; // 自己派的回声，不回流
    const detail = (event as CustomEvent<unknown>).detail;
    const raw = typeof detail === 'string' ? detail : (detail as { zone?: unknown } | null | undefined)?.zone;
    if (typeof raw !== 'string') return;
    const next = raw.trim();
    if (!next) return;
    handler(next, 'event');
  };

  const setter: ZoneSetter = (id) => handler(id, 'api');

  win.addEventListener('znwd:zone', onEvent);
  win.znwdSetZone = setter;
  return () => {
    win.removeEventListener('znwd:zone', onEvent);
    if (win.znwdSetZone === setter) delete win.znwdSetZone;
  };
}
