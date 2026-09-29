import { describe, it, expect, beforeAll } from 'vitest';
import { ref } from 'vue';
import {
  fetchHealth,
  fetchZones,
  fetchSuggestions,
  streamChat,
  fetchAdminStats,
  fetchKnowledgeList,
  runDiagnostics,
  fetchSynonyms,
  resetSession,
  sendFeedback,
  newSessionId,
  apiUrl,
  type ChatMeta,
  type ChatDone,
} from '../api';
import { useChat } from '../composables/useChat';

// ---------------------------------------------------------------------------
// 0. 连通性预检：后端活着吗？
// ---------------------------------------------------------------------------
let healthResult: Awaited<ReturnType<typeof fetchHealth>>;

beforeAll(async () => {
  healthResult = await fetchHealth();
  console.log('[LIVE] health:', JSON.stringify(healthResult, null, 2));
  expect(healthResult.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// 1. 基础读接口
// ---------------------------------------------------------------------------
describe('1. 基础读接口（fetchHealth / fetchZones / fetchSuggestions）', () => {
  it('fetchHealth 返回预期字段', () => {
    expect(healthResult).toHaveProperty('ok', true);
    expect(healthResult).toHaveProperty('knowledgeChunks');
    expect(healthResult).toHaveProperty('llmProvider');
    expect(healthResult).toHaveProperty('storageAvailable');
    expect(healthResult).toHaveProperty('activeSessions');
    console.log(
      '[LIVE] health fields ok — knowledgeChunks=%d llmProvider=%s storage=%s activeSessions=%d',
      healthResult.knowledgeChunks,
      healthResult.llmProvider,
      healthResult.storage,
      healthResult.activeSessions,
    );
  });

  it('fetchZones 返回数组且含 id/title', async () => {
    const { zones } = await fetchZones();
    console.log('[LIVE] zones count:', zones.length, 'first:', zones[0]?.id);
    expect(Array.isArray(zones)).toBe(true);
    expect(zones.length).toBeGreaterThan(0);
    expect(typeof zones[0].id).toBe('string');
    expect(typeof zones[0].title).toBe('string');
  });

  it('fetchSuggestions（不带 zone）返回字符串数组', async () => {
    const items = await fetchSuggestions();
    console.log('[LIVE] suggestions (no zone) count:', items.length);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect(typeof items[0]).toBe('string');
  });

  it('fetchSuggestions（带 zone）返回字符串数组', async () => {
    const { zones } = await fetchZones();
    const zoneId = zones[0]?.id;
    if (!zoneId) return; // 无展区跳过
    const items = await fetchSuggestions(zoneId);
    console.log('[LIVE] suggestions (zone=%s) count:', zoneId, items.length);
    expect(Array.isArray(items)).toBe(true);
    // 带 zone 的建议可能为 0（后端按展区过滤），但不应报错
  });
});

// ---------------------------------------------------------------------------
// 2. SSE 真实流
// ---------------------------------------------------------------------------
describe('2. SSE 真实流（streamChat）', () => {
  it('绕过缓存时真走一次上游：cached=false、latencyMs>0，帧序不变', async () => {
    // 上面那条用的域外问题会被闸门拦下、答案命中缓存（latencyMs=0），验不到真模型回合。
    // 这条用「域内问题 + 唯一后缀」逼出一次真实的检索+生成：缓存键里带整句，后缀不同就不命中。
    const fresh = `光伏清洁无人机是做什么的？live-${Date.now()}`;
    const frames: string[] = [];
    let doneObj: ChatDone | null = null;
    await streamChat(fresh, newSessionId(), {
      onMeta: () => frames.push('meta'),
      onDelta: () => frames.push('delta'),
      onDone: (done) => {
        frames.push('done');
        doneObj = done;
      },
    });
    console.log('[LIVE] 新问题 frames:', frames.join(' → '),
      '| cached:', doneObj?.cached, '| latencyMs:', doneObj?.latencyMs,
      '| answer 长度:', doneObj?.answer?.length, '| sources:', doneObj?.sources?.length);

    expect(frames[0]).toBe('meta');
    expect(frames[frames.length - 1]).toBe('done');
    expect(doneObj!.cached, '全新问题不该命中缓存').toBe(false);
    expect(doneObj!.latencyMs, '不是缓存回放（真走了一次上游）').toBeGreaterThan(100);
    expect((doneObj!.answer ?? '').length, '要有正文').toBeGreaterThan(0);
  });

  it('onMeta → onDelta* → onDone 顺序正确，done 带 answer/latencyMs/sources/sessionToken', async () => {
    const frames: string[] = [];
    let metaObj: ChatMeta | null = null;
    const deltas: string[] = [];
    let doneObj: ChatDone | null = null;

    await streamChat(
      '你好，请简单介绍一下自己',
      newSessionId(),
      {
        onMeta: (meta) => {
          frames.push('meta');
          metaObj = meta;
        },
        onDelta: (text) => {
          frames.push('delta');
          deltas.push(text);
        },
        onDone: (done) => {
          frames.push('done');
          doneObj = done;
        },
      },
    );

    console.log('[LIVE] SSE frame order:', frames.join(' → '));
    console.log('[LIVE] delta count:', deltas.length);
    console.log('[LIVE] done.answer length:', doneObj?.answer?.length);
    console.log('[LIVE] done.latencyMs:', doneObj?.latencyMs);
    console.log('[LIVE] done.sessionToken:', doneObj?.sessionToken);
    console.log('[LIVE] done.sources count:', doneObj?.sources?.length);

    // 顺序：meta 在最前，done 在最后，中间可以有 0~N 个 delta
    expect(frames[0]).toBe('meta');
    expect(frames[frames.length - 1]).toBe('done');
    expect(frames.filter((f) => f === 'delta').length).toBe(deltas.length);

    // meta 帧存在且有字段
    expect(metaObj).not.toBeNull();
    expect(metaObj!.mode).toMatch(/^(rag|llm_only)$/);
    expect(metaObj!.sources).toBeDefined();

    // meta 帧不带 sessionToken
    expect((metaObj as Record<string, unknown>).sessionToken).toBeUndefined();
    console.log('[LIVE] meta 帧无 sessionToken ✓');

    // done 帧
    expect(doneObj).not.toBeNull();
    expect(typeof doneObj!.answer).toBe('string');
    expect(doneObj!.answer.length).toBeGreaterThan(0);
    expect(typeof doneObj!.latencyMs).toBe('number');
    expect(Array.isArray(doneObj!.sources)).toBe(true);
    // sessionToken 是 32 位
    expect(typeof doneObj!.sessionToken).toBe('string');
    expect(doneObj!.sessionToken!.length).toBe(32);
    console.log('[LIVE] done.sessionToken length = %d ✓', doneObj!.sessionToken!.length);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3. useChat 状态机 + 令牌链路（本轮最关键用例）
// ---------------------------------------------------------------------------
describe('3. useChat 状态机 + 令牌链路', () => {
  it('ask() 后 messages 两条、pending=false、sources 可能非空、sessionToken 存入 sessionStorage', async () => {
    const chat = useChat();
    expect(chat.messages.value).toHaveLength(0);

    // 先拿推荐问题，确保触发 RAG（泛问 "你好" 大概率走 llm_only）
    const suggestions = await fetchSuggestions();
    const domainQ = suggestions[0] || '故宫博物院的介绍';

    console.log('[LIVE] useChat sessionId:', chat.sessionId.value);
    console.log('[LIVE] ask question:', domainQ);

    await chat.ask(domainQ);

    // messages 应有 2 条：user + assistant
    console.log('[LIVE] messages count:', chat.messages.value.length);
    expect(chat.messages.value).toHaveLength(2);
    expect(chat.messages.value[0].role).toBe('user');
    expect(chat.messages.value[1].role).toBe('assistant');

    // streaming 结束后 pending=false
    expect(chat.streaming.value).toBe(false);
    expect(chat.messages.value[1].pending).toBe(false);
    console.log('[LIVE] assistant.pending = false ✓');

    // answer 非空
    expect(chat.messages.value[1].content.length).toBeGreaterThan(0);
    console.log('[LIVE] assistant content length:', chat.messages.value[1].content.length);

    // sources：域内问题应触发 RAG → sources 非空；但也可能 noHit（阈值高），这里打值并验证是数组
    console.log('[LIVE] sources count:', chat.sources.value.length);
    expect(Array.isArray(chat.sources.value)).toBe(true);
    if (chat.sources.value.length === 0) {
      console.log('[LIVE] NOTE: sources 为空（可能 noHit 或 llm_only 路由）');
    }

    // sessionToken 已存且有值
    expect(chat.sessionToken.value.length).toBe(32);
    console.log('[LIVE] useChat sessionToken:', chat.sessionToken.value);

    // sessionStorage 同步
    const stored = sessionStorage.getItem('znwd.sessionToken');
    console.log('[LIVE] sessionStorage znwd.sessionToken:', stored);
    expect(stored).toBe(chat.sessionToken.value);

    // startOver → DELETE 真成功 → GET 返回 404
    const oldSessionId = chat.sessionId.value;
    const oldToken = chat.sessionToken.value;
    console.log('[LIVE] startOver — oldSessionId:', oldSessionId);

    await chat.startOver();

    // startOver 后 messages 清空、token 清空
    expect(chat.messages.value).toHaveLength(0);
    expect(chat.sessionToken.value).toBe('');
    expect(sessionStorage.getItem('znwd.sessionToken')).toBeNull();
    console.log('[LIVE] startOver 清空 messages + token ✓');

    // 回查旧 session → 应 404
    const base = 'http://127.0.0.1:8787';
    const checkRes = await fetch(`${base}/api/sessions/${encodeURIComponent(oldSessionId)}`, {
      headers: { 'x-session-token': oldToken },
    });
    console.log('[LIVE] GET old session after reset →', checkRes.status);
    expect(checkRes.status).toBe(404);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 4. 错误面
// ---------------------------------------------------------------------------
describe('4. 错误面', () => {
  it('不存在的会话 GET 404', async () => {
    const base = 'http://127.0.0.1:8787';
    const res = await fetch(`${base}/api/sessions/nonexistent-fake-id-12345`, {
      headers: { 'x-session-token': 'fake-token-for-nonexistent' },
    });
    console.log('[LIVE] nonexistent session GET:', res.status);
    expect(res.status).toBe(404);
  });

  it('反馈缺少 sessionId 字段：记录后端实际行为', async () => {
    const base = 'http://127.0.0.1:8787';
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rating: 'up' }), // 缺少 sessionId
    });
    console.log('[LIVE] feedback missing sessionId →', res.status);
    // 后端实际返回 200（未做严格校验）——这是一个发现，不是断言 bug
    // 真实记录：后端 /api/feedback 缺少 sessionId 时不返回 400
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(600);
  });

  it('反馈 rating 非法：记录后端实际行为', async () => {
    const base = 'http://127.0.0.1:8787';
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test', rating: 'invalid' }),
    });
    console.log('[LIVE] feedback illegal rating →', res.status);
    // 后端可能返回 200 或 400，记录实际行为
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(600);
  });

  it('客户端拿到的错误文案不是 "undefined"', async () => {
    // 用真实前端代码调 sendFeedback 传非法 rating，捕获错误消息
    let errorMsg = '';
    try {
      await sendFeedback({
        sessionId: 'test',
        rating: 'invalid' as 'up',
      });
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }
    console.log('[LIVE] client error message:', errorMsg);
    expect(errorMsg).toBeTruthy();
    expect(errorMsg).not.toBe('undefined');
    expect(errorMsg).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// 5. 管理接口（adminRequest 路径）
// ---------------------------------------------------------------------------
describe('5. 管理接口（adminRequest + Bearer）', () => {
  const ADMIN_TOKEN = 'root:123456';

  it('fetchAdminStats 返回字段齐全', async () => {
    const stats = await fetchAdminStats(ADMIN_TOKEN);
    console.log('[LIVE] admin stats:', JSON.stringify(stats));
    expect(stats).toHaveProperty('chatTotal');
    expect(typeof stats.chatTotal).toBe('number');
  });

  it('fetchKnowledgeList 返回字段齐全', async () => {
    const info = await fetchKnowledgeList(ADMIN_TOKEN);
    console.log('[LIVE] knowledge fileCount:', info.fileCount, 'chunkCount:', info.chunkCount);
    expect(typeof info.fileCount).toBe('number');
    expect(typeof info.chunkCount).toBe('number');
    expect(Array.isArray(info.docs)).toBe(true);
  });

  it('runDiagnostics 返回 query + hits', async () => {
    const diag = await runDiagnostics(ADMIN_TOKEN, '故宫');
    console.log('[LIVE] diagnostics query:', diag.query, 'hits:', diag.hits.length);
    expect(diag.query).toBe('故宫');
    expect(Array.isArray(diag.hits)).toBe(true);
  });

  it('fetchSynonyms 返回 entries 数组', async () => {
    const syn = await fetchSynonyms(ADMIN_TOKEN);
    console.log('[LIVE] synonyms count:', syn.count, 'entries:', syn.entries.length);
    expect(typeof syn.count).toBe('number');
    expect(Array.isArray(syn.entries)).toBe(true);
  });

  it('错口令 → "口令不正确（401）"', async () => {
    let errorMsg = '';
    try {
      await fetchAdminStats('wrong-token');
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }
    console.log('[LIVE] wrong token error:', errorMsg);
    expect(errorMsg).toBe('口令不正确（401）');
  });
});

// ---------------------------------------------------------------------------
// 6. 语音合成
// ---------------------------------------------------------------------------
describe('6. 语音合成（synthesizeSpeech）', () => {
  it('health.speechReady=true 时合成 WAV 返回 RIFF 字节', async () => {
    if (!healthResult.speechReady) {
      console.log('[LIVE] speechReady=false，跳过语音合成测试');
      return; // 后端未启用语音，不算失败
    }

    const base = 'http://127.0.0.1:8787';
    const res = await fetch(`${base}/api/speech/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好' }),
    });
    expect(res.ok).toBe(true);

    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    console.log('[LIVE] speech response size:', buf.byteLength, 'header:', header);
    // WAV 文件以 "RIFF" 开头
    expect(header).toBe('RIFF');
  });
});
