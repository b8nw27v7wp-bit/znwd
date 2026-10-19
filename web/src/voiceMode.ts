import { readStorage, writeStorage } from './storage';

/**
 * 语音模式：`'tap'` = 点按说话（半双工，缺省），`'full'` = 全双工（常开聆听）。
 *
 * <p>术语只用「点按 / 全双工」，不用「档位」——deployment.md 与 voice-realtime-plan.md 里
 * 「档位」已各有含义，混用会让现场文档对不上。
 */
export type VoiceMode = 'tap' | 'full';

/** 新键，唯一的权威：只要它取值合法，一律按它 */
export const VOICE_MODE_KEY = 'znwd.voiceMode';
/**
 * 旧键（第 3 档的常开聆听开关），只为迁移兜底：
 *
 * <p>老版本运营显式拨过 `'1'`（全双工）的现场，升级后行为不能变；拨过 `'0'` 的退回点按。
 * 脏值（如 `'true'`）按旧缺省「非 '0' 即开」归入 full。`writeVoiceMode` 仍会镜像写它，
 * 让回滚 `web/dist` 后的旧代码读到正确值。
 */
export const LEGACY_LISTEN_KEY = 'znwd.listen';

/**
 * 读当前语音模式。三条守则（与 storage 的用法一致）：
 * 1. **加载路径只读不写**——页面每次加载都往 localStorage 塞键，是替还没做过决定的参观者做决定；
 * 2. 新键 `znwd.voiceMode` 合法（`'tap'` / `'full'`）时优先，旧键不再参与；
 * 3. 新键缺失时按旧键回退，两键皆无 → `'tap'`（缺省半双工）。
 */
export function resolveVoiceMode(): VoiceMode {
  const mode = readStorage('local', VOICE_MODE_KEY);
  if (mode === 'tap' || mode === 'full') return mode;
  const legacy = readStorage('local', LEGACY_LISTEN_KEY);
  if (legacy !== null) return legacy === '0' ? 'tap' : 'full';
  return 'tap';
}

/**
 * 落存储。**只在运营真的拨了开关那一下调用**（加载路径绝不写，见 {@link resolveVoiceMode}）。
 *
 * <p>双写：新键是权威，旧键 `znwd.listen` 镜像（full→`'1'`，tap→`'0'`），
 * 保证回滚 `web/dist` 后旧代码读到正确值。
 */
export function writeVoiceMode(mode: VoiceMode): void {
  writeStorage('local', VOICE_MODE_KEY, mode);
  writeStorage('local', LEGACY_LISTEN_KEY, mode === 'full' ? '1' : '0');
}
