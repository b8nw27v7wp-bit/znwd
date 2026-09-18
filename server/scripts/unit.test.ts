import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/session/store.ts';
import { RateLimiter } from '../src/http/rateLimit.ts';
import { LruCache, answerCacheKey, adminOk } from '../src/http/cache.ts';
import { expandQueryText } from '../src/knowledge/synonyms.ts';
import { buildGroundedAnswer } from '../src/llm/grounded.ts';
import { MockChatModel } from '../src/llm/mock.ts';

test('SessionStore append/peek/reset', () => {
  const s = new SessionStore();
  s.append('a', '你好', '您好');
  const h = s.peek('a');
  assert.ok(h);
  assert.equal(h.messages.length, 2);
  assert.equal(s.reset('a'), true);
  assert.equal(s.peek('a'), null);
});

test('SessionStore history without id', () => {
  const s = new SessionStore();
  assert.deepEqual(s.history(undefined), []);
});

test('RateLimiter blocks after limit', () => {
  const r = new RateLimiter(2, 60_000);
  assert.equal(r.allow('ip'), null);
  assert.equal(r.allow('ip'), null);
  const wait = r.allow('ip');
  assert.ok(wait !== null && wait >= 1);
});

test('LruCache evicts oldest', () => {
  const c = new LruCache<number>(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.size, 2);
});

test('adminOk open when no token; closed when set', () => {
  assert.equal(adminOk(undefined, undefined), true);
  assert.equal(adminOk(undefined, 'secret'), false);
  assert.equal(adminOk('Bearer secret', 'secret'), true);
  assert.equal(adminOk('secret', 'secret'), true);
});

test('expandQueryText adds synonyms', () => {
  const q = expandQueryText('光伏清洁怎么做');
  assert.ok(q.includes('光伏'));
  assert.ok(q.includes('太阳能') || q.includes('组件'));
  assert.equal(expandQueryText('abc'), 'abc');
});

test('grounded mock uses knowledge lines', () => {
  const ctx =
    'sys\n\n【企业知识】\n【片段 1｜光伏产品｜pv-clean｜01/x.md】\n## 核心能力\n光伏组件表面清洁\n通过航线自动作业';
  const ans = buildGroundedAnswer({
    question: '光伏清洁无人机是做什么的',
    context: ctx,
    historyTurns: 0,
  });
  assert.ok(ans.includes('光伏'));
  assert.ok(ans.includes('Mock'));
});

test('grounded mock no-hit branch', () => {
  const ans = buildGroundedAnswer({
    question: 'xyz',
    context: '【企业知识】\n（无命中片段）',
    historyTurns: 0,
  });
  assert.ok(ans.includes('未检索到') || ans.includes('未绑定'));
});

test('MockChatModel stream yields pieces', async () => {
  const m = new MockChatModel();
  const pieces: string[] = [];
  for await (const p of m.stream({
    messages: [
      { role: 'system', content: '【企业知识】\n（无命中片段）' },
      { role: 'user', content: '测试问题' },
    ],
  })) {
    pieces.push(p);
  }
  assert.ok(pieces.length >= 1);
  assert.ok(pieces.join('').includes('测试问题'));
});

test('answerCacheKey stable', () => {
  assert.equal(answerCacheKey('  太阳能  ', 'mock'), answerCacheKey('太阳能', 'mock'));
});
