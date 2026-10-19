// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_LISTEN_KEY, VOICE_MODE_KEY, resolveVoiceMode, writeVoiceMode } from './voiceMode';

/**
 * 语音模式的读写与迁移（半双工为缺省）：
 * - 新键 `znwd.voiceMode` 是唯一权威；
 * - 新键缺失时按旧键 `znwd.listen` 回退（老现场升级后行为不变）；
 * - 两键皆无 → 点按（缺省半双工）；
 * - 写入双写镜像，回滚 dist 后旧代码读到正确值。
 */
describe('语音模式（voiceMode）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('两键皆无 → 点按（缺省半双工），且不落键', () => {
    expect(resolveVoiceMode()).toBe('tap');
    expect(localStorage.getItem(VOICE_MODE_KEY), '加载路径绝不写存储').toBeNull();
    expect(localStorage.getItem(LEGACY_LISTEN_KEY)).toBeNull();
  });

  it('新键两个取值各自生效', () => {
    localStorage.setItem(VOICE_MODE_KEY, 'tap');
    expect(resolveVoiceMode()).toBe('tap');
    localStorage.setItem(VOICE_MODE_KEY, 'full');
    expect(resolveVoiceMode()).toBe('full');
  });

  it('旧键回退：listen=0 → 点按；listen=1 → 全双工；脏值按旧缺省归入全双工', () => {
    localStorage.setItem(LEGACY_LISTEN_KEY, '0');
    expect(resolveVoiceMode()).toBe('tap');
    localStorage.setItem(LEGACY_LISTEN_KEY, '1');
    expect(resolveVoiceMode()).toBe('full');
    localStorage.setItem(LEGACY_LISTEN_KEY, 'true'); // 脏值：旧语义「非 '0' 即开」
    expect(resolveVoiceMode()).toBe('full');
  });

  it('新键压过旧键（双向）', () => {
    localStorage.setItem(LEGACY_LISTEN_KEY, '1');
    localStorage.setItem(VOICE_MODE_KEY, 'tap');
    expect(resolveVoiceMode(), '运营显式拨过点按，旧键的全双工不该翻案').toBe('tap');

    localStorage.setItem(LEGACY_LISTEN_KEY, '0');
    localStorage.setItem(VOICE_MODE_KEY, 'full');
    expect(resolveVoiceMode(), '新键是唯一权威').toBe('full');
  });

  it('新键脏值不作数，继续按旧键回退', () => {
    localStorage.setItem(VOICE_MODE_KEY, 'FULL'); // 大小写不认
    localStorage.setItem(LEGACY_LISTEN_KEY, '1');
    expect(resolveVoiceMode()).toBe('full');
    localStorage.removeItem(LEGACY_LISTEN_KEY);
    expect(resolveVoiceMode(), '新键脏 + 旧键无 → 回到缺省点按').toBe('tap');
  });

  it('writeVoiceMode 写新键并镜像旧键（full→1 / tap→0）', () => {
    writeVoiceMode('full');
    expect(localStorage.getItem(VOICE_MODE_KEY)).toBe('full');
    expect(localStorage.getItem(LEGACY_LISTEN_KEY), '镜像给回滚后的旧代码').toBe('1');
    expect(resolveVoiceMode()).toBe('full');

    writeVoiceMode('tap');
    expect(localStorage.getItem(VOICE_MODE_KEY)).toBe('tap');
    expect(localStorage.getItem(LEGACY_LISTEN_KEY)).toBe('0');
    expect(resolveVoiceMode()).toBe('tap');
  });
});
