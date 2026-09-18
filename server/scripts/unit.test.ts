import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/session/store.ts';
import { RateLimiter } from '../src/http/rateLimit.ts';
import { LruCache, answerCacheKey, adminOk, JsonlStore } from '../src/http/cache.ts';
import { adminTokenRequired, errorPayload, messageLogFields, hashStr } from '../src/http/errors.ts';
import { expandQueryText } from '../src/knowledge/synonyms.ts';
import { buildGroundedAnswer } from '../src/llm/grounded.ts';
import { MockChatModel } from '../src/llm/mock.ts';
import { HybridRetriever } from '../src/knowledge/hybridRetriever.ts';
import { VectorStore } from '../src/knowledge/vectorStore.ts';
import { runChat } from '../src/rag/runChat.ts';
import type { EmbeddingProvider } from '../src/embedding/types.ts';
import type { KnowledgeChunk } from '../src/knowledge/loader.ts';
import { Analytics } from '../src/analytics/stats.ts';

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

test('adminOk requireToken rejects missing token', () => {
  assert.equal(adminOk(undefined, undefined, { requireToken: true }), false);
  assert.equal(adminOk('Bearer secret', 'secret', { requireToken: true }), true);
  assert.equal(adminOk(undefined, undefined, { requireToken: false }), true);
  assert.equal(adminOk('Bearer wrong', 'secret', { requireToken: true }), false);
});

test('adminTokenRequired by NODE_ENV / flag', () => {
  assert.equal(adminTokenRequired({} as NodeJS.ProcessEnv), false);
  assert.equal(adminTokenRequired({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), false);
  assert.equal(adminTokenRequired({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), true);
  assert.equal(adminTokenRequired({ NODE_ENV: 'staging' } as NodeJS.ProcessEnv), true);
  assert.equal(adminTokenRequired({ REQUIRE_ADMIN_TOKEN: 'true' } as NodeJS.ProcessEnv), true);
  assert.equal(adminTokenRequired({ REQUIRE_ADMIN_TOKEN: '1' } as NodeJS.ProcessEnv), true);
});

test('errorPayload shape has no stack', () => {
  const body = errorPayload('internal_error', '服务内部错误', 'req-1');
  assert.equal(body.error, 'internal_error');
  assert.equal(body.message, '服务内部错误');
  assert.equal(body.requestId, 'req-1');
  assert.ok(!JSON.stringify(body).includes('Error:'));
});

test('messageLogFields hash mode hides full message', () => {
  const long = '这是一个很长的机密问题'.repeat(20);
  const f = messageLogFields(long, 'hash');
  assert.ok(f.messagePreview);
  assert.ok(!f.messagePreview!.includes(long));
  assert.ok(f.messagePreview!.includes(String(long.length)));
  const p = messageLogFields(long, 'preview');
  assert.equal(p.messagePreview, long.slice(0, 80));
  assert.ok(hashStr('a') === hashStr('a'));
});

test('JsonlStore hash sanitize + flush + rotate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'znwd-jsonl-'));
  const store = new JsonlStore(dir, 'events', { maxBytes: 200, messageMode: 'hash' });
  const secret = '完整敏感问题'.repeat(30);
  store.append({ type: 'chat', message: secret, answerPreview: 'ans' });
  await store.flush();
  const raw = await readFile(store.path, 'utf8');
  assert.ok(raw.length > 0);
  assert.ok(!raw.includes(secret));
  assert.ok(raw.includes('messagePreview'));
  // force rotate
  for (let i = 0; i < 8; i++) {
    store.append({ type: 'chat', message: 'x'.repeat(80) });
  }
  await store.flush();
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(dir);
  assert.ok(files.some((f) => f.startsWith('events.') && f !== 'events.jsonl'));
});

test('HybridRetriever generation increments on replace', async () => {
  const bag: EmbeddingProvider = {
    name: 'bag-test',
    dims: 8,
    async embed(texts: string[]) {
      return texts.map((t) => {
        const v = new Array(8).fill(0);
        for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) % 17;
        return v;
      });
    },
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'znwd-vec-'));
  const store = new VectorStore(bag, path.join(dir, 'v.json'));
  const r = new HybridRetriever(store);
  assert.equal(r.generation(), 0);
  const mk = (id: string, text: string): KnowledgeChunk => ({
    id,
    title: id,
    sourcePath: id + '.md',
    text,
    zone: 'z',
    zoneTitle: 'Z',
    tags: [],
  });
  await r.replace([mk('a', '光伏清洁无人机 航线作业')]);
  assert.equal(r.generation(), 1);
  assert.equal(r.list().length, 1);
  const genBefore = r.generation();
  const listBefore = r.list().map((c) => c.id);
  const p1 = r.replace([mk('b', '风场检测 停机')]);
  const p2 = r.replace([mk('c', '服务合作')]);
  await Promise.all([p1, p2]);
  assert.equal(r.generation(), genBefore + 2);
  const ids = r.list().map((c) => c.id);
  assert.ok(!ids.includes(listBefore[0]!));
  assert.ok(ids.includes('c'));
  assert.equal(r.stats().generation, r.generation());
});

test('runChat mock path returns answer and writes session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'znwd-run-'));
  const bag: EmbeddingProvider = {
    name: 'bag-test',
    dims: 2,
    async embed(texts: string[]) {
      return texts.map(() => [0, 0]);
    },
  };
  const vstore = new VectorStore(bag, path.join(dir, 'v.json'));
  const retriever = new HybridRetriever(vstore);
  await retriever.replace([]);
  const sessions = new SessionStore();
  const answerCache = new LruCache(10);
  const logStore = new JsonlStore(dir, 'events', { messageMode: 'hash' });
  const deps = {
    retriever,
    model: new MockChatModel(),
    sessions,
    analytics: new Analytics(),
    answerCache,
    logStore,
  };
  const res = await runChat(deps, { message: '光伏清洁是做什么的', sessionId: 's1' });
  assert.ok(res.answer.length > 0);
  assert.equal(res.sessionId, 's1');
  assert.equal(res.cached, false);
  const h = sessions.peek('s1');
  assert.ok(h && h.messages.length >= 2);
  await logStore.flush();
  const raw = await readFile(logStore.path, 'utf8');
  assert.ok(raw.includes('messagePreview'));
  assert.ok(!raw.includes('"message"'));
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

test('answerCacheKey includes generation', () => {
  assert.equal(answerCacheKey('  太阳能  ', 'mock', 0), answerCacheKey('太阳能', 'mock', 0));
  assert.notEqual(answerCacheKey('太阳能', 'mock', 0), answerCacheKey('太阳能', 'mock', 2));
});

test('expandQueryText covers eval synonyms', () => {
  const q = expandQueryText('太阳能组件怎么清洗');
  assert.ok(q.includes('光伏') || q.includes('清洁') || q.includes('清洗'));
  const w = expandQueryText('风机叶片裂纹');
  assert.ok(w.includes('检测') || w.includes('缺陷') || w.includes('风电'));
});

test('Analytics feedbackStats groups down by question', () => {
  const a = new Analytics();
  a.logFeedback({ at: 1, sessionId: 's1', rating: 'down', question: '叶片检测要停机吗？' });
  a.logFeedback({ at: 2, sessionId: 's2', rating: 'down', question: '叶片检测要停机吗？', comment: '讲不清' });
  a.logFeedback({ at: 3, sessionId: 's3', rating: 'up', question: '光伏清洁' });
  const s = a.feedbackStats();
  assert.equal(s.total, 3);
  assert.equal(s.down, 2);
  assert.equal(s.topDown[0]?.question, '叶片检测要停机吗？');
  assert.equal(s.topDown[0]?.down, 2);
  const csv = a.feedbackCsv();
  assert.ok(csv.startsWith('at,sessionId,rating,question,comment'));
  assert.ok(csv.includes('叶片检测要停机吗？'));
});
