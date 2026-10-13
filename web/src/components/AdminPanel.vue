<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  fetchAdminStats,
  fetchFeedbackStats,
  fetchUncovered,
  type AdminStats,
  type FeedbackStats,
  type UncoveredItem,
} from '../api';
import { readStorage, removeStorage, writeStorage } from '../storage';
import KnowledgePanel from './KnowledgePanel.vue';
import DiagnosticsPanel from './DiagnosticsPanel.vue';

/**
 * 运营视图：统计、未覆盖问题（要补的资料）、负反馈，以及知识库管理与检索诊断（子面板）。
 * 口令只存 sessionStorage，不进 URL、不进日志；管理接口没配 ADMIN_TOKEN 时后端直接放行（开发态）。
 * 所有管理请求都经 api/admin.ts 的 adminRequest 统一带 authorization 头。
 */
const TOKEN_KEY = 'znwd.adminToken';

const token = ref(readStorage('session', TOKEN_KEY) ?? '');
/** 提交后的口令：子面板拿它发请求，避免输入框每敲一个字就打一轮接口 */
const committedToken = ref(token.value);
const stats = ref<AdminStats | null>(null);
const uncovered = ref<UncoveredItem[]>([]);
const feedback = ref<FeedbackStats | null>(null);
const error = ref('');
let loadGeneration = 0;

async function load(): Promise<void> {
  const generation = ++loadGeneration;
  const requestToken = token.value;
  error.value = '';
  if (requestToken) writeStorage('session', TOKEN_KEY, requestToken);
  else removeStorage('session', TOKEN_KEY);
  committedToken.value = requestToken;
  try {
    const [s, u, f] = await Promise.all([
      fetchAdminStats(requestToken),
      fetchUncovered(requestToken),
      fetchFeedbackStats(requestToken),
    ]);
    if (generation !== loadGeneration) return;
    stats.value = s;
    uncovered.value = u.items;
    feedback.value = f;
  } catch (e) {
    if (generation === loadGeneration) {
      stats.value = null;
      uncovered.value = [];
      feedback.value = null;
      error.value = e instanceof Error ? e.message : '加载失败';
    }
  }
}

function tokens(): string {
  const t = stats.value?.tokens;
  if (!t) return '-';
  return `入 ${t.prompt ?? 0} / 出 ${t.completion ?? 0} / 计费 ${t.total ?? 0}`;
}

/**
 * 声学遥测（`stats.speech`）：**没上报过就没有这个键**，整块行据此不出现——
 * 否则没开常开聆听的部署上会一直挂着一排 0，看着像功能没生效。
 */
const speech = computed(() => stats.value?.speech ?? null);

/** 取一个声学计数：缺字段按 0 显示，面板不因为有键没到就空着 */
function s(key: string): number {
  return speech.value?.[key] ?? 0;
}

/** 超时结束没有独立计数：它是「语句数 − 自动 − 手动」的余数（与后端同一套分解口径） */
function maxEnds(): number {
  return Math.max(0, s('utterances') - s('autoEnds') - s('manualEnds'));
}

/**
 * 疑似漏断占自动收尾的比例（§5 S3）。
 *
 * <p>单看次数看不出严重程度：漏断本来就发生在「说了一半换气」的少数句子上，
 * 而分母（自动收尾次数）随现场说话量变化。没有自动收尾样本时返回 null（不显示括号）。
 */
function truncationRate(): string | null {
  const auto = s('autoEnds');
  if (!auto) return null;
  return ((s('suspectedTruncations') / auto) * 100).toFixed(1);
}

/** 服务端算好的比例（0~1）按百分数显示 */
function percent(key: string): string {
  return `${(s(key) * 100).toFixed(1)}%`;
}

/**
 * 延迟表要不要出现：四条路径任意一条有样本就出。
 *
 * <p>表里的行各自还有自己的 `v-if`（见模板注释），这里只是「整张表别有壳无肉」的那道兜底——
 * 没有它，一个只有分段样本的实例会渲染出一张空表。
 */
function hasLatency(): boolean {
  return Boolean(s('partialLatencyCount') || s('finalCalls') || s('firstSentenceCount'));
}

function when(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

onMounted(load);
</script>

<template>
  <section class="admin">
    <h2>运营统计</h2>
    <input v-model="token" type="password" placeholder="ADMIN_TOKEN（未配置可留空）" @keyup.enter="load" />
    <button class="linkish" @click="load">加载 / 刷新</button>
    <p v-if="error" class="snippet" style="color: var(--warn)">{{ error }}</p>

    <table v-if="stats">
      <tbody>
        <tr><td>问答总数</td><td>{{ stats.chatTotal }}</td></tr>
        <tr><td>引用资料回答</td><td>{{ stats.ragHits }}</td></tr>
        <tr><td>资料未覆盖</td><td>{{ stats.noHit }}</td></tr>
        <tr><td>多轮改写</td><td>{{ stats.rewritten }}</td></tr>
        <tr><td>出错</td><td>{{ stats.errors }}</td></tr>
        <tr><td>活跃会话</td><td>{{ stats.activeSessions }}</td></tr>
        <tr><td>tokens</td><td>{{ tokens() }}</td></tr>
      </tbody>
    </table>

    <table v-if="feedback">
      <tbody>
        <tr><td>有帮助</td><td>{{ feedback.up ?? 0 }}</td></tr>
        <tr><td>没帮助</td><td>{{ feedback.down ?? 0 }}</td></tr>
      </tbody>
    </table>

    <!-- 声学遥测：底噪与 VAD 判定只发生在浏览器里，靠前端定期上报。
         现场调阈值（VAD_SPEECH_RMS / VAD_SILENCE_MS / BARGEIN_FACTOR）就看这几张表：
         底噪逼近说话阈值 → 提高 VAD_SPEECH_RMS；空识别误触多 → 同样提高；
         疑似漏断多 → 静音阈值 VAD_SILENCE_MS 太短；
         超时结束多 → 停顿阈值太长或环境太吵。 -->
    <table v-if="speech">
      <tbody>
        <!-- 样本数必须带出来：底噪上报只收「低于常量地板」的块，而阈值一旦被自适应抬到上限，
             样本数会同时塌到 0（面板显示 RMS 0 / -120dB）——不带样本数就看不出那是「没数据」
             还是「展厅真安静」，也就看不出阈值已经顶死、人声正被挡在门外。 -->
        <tr>
          <td>平均底噪</td>
          <td>{{ s('avgNoiseDb') }} dB（RMS {{ s('avgNoiseRms') }}，{{ s('noiseSamples') }} 个样本）</td>
        </tr>
        <!-- 自适应阈值（§5 S1）：与上一行并排看，才知道「底噪有没有真的参与判决」 -->
        <tr><td>当前说话阈值（自适应）</td><td>RMS {{ s('avgSpeechThreshold') }}</td></tr>
        <tr><td>语句数</td><td>{{ s('utterances') }}</td></tr>
        <tr>
          <td>自动 / 手动 / 超时结束</td>
          <td>{{ s('autoEnds') }} / {{ s('manualEnds') }} / {{ maxEnds() }}</td>
        </tr>
        <tr><td>没听到声音（收回麦克风）</td><td>{{ s('noSpeechAborts') }}</td></tr>
        <tr><td>空识别误触</td><td>{{ s('falseTriggers') }}</td></tr>
        <tr>
          <td>疑似漏断（收尾后马上又起一句）</td>
          <td>
            {{ s('suspectedTruncations') }}
            <span class="muted" v-if="truncationRate() !== null">（占自动收尾 {{ truncationRate() }}%）</span>
          </td>
        </tr>
        <tr><td>播报期间撤回的语句</td><td>{{ s('suppressedAbandons') }}</td></tr>
        <tr>
          <td>分段调用 / 失败 / 丢弃</td>
          <td>{{ s('segmentCalls') }} / {{ s('segmentFailures') }} / {{ s('segmentDropped') }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 延迟：§4 P2 修订 1 的四段各自成行——超标了才知道该优化谁。
         第一段拆成「说完→收尾判决」与「收尾→终稿」，后者与服务端自量的耗时一比就是浏览器侧开销。
         **每一行自己判有没有样本**（而不是整表一个条件）：分段与终稿是两条独立的路径，
         现场真出现「分段正常、整段全挂」时（超时/配额只卡长音频），运营至少要能看到分段那一路的数。 -->
    <table v-if="speech && hasLatency()">
      <tbody>
        <tr v-if="s('partialLatencyCount')">
          <td>分段平均延迟</td><td>{{ s('avgPartialLatencyMs') }} ms</td>
        </tr>
        <tr v-if="s('finalCalls')"><td>说完 → 收尾判决</td><td>{{ s('avgFinalEndDelayMs') }} ms</td></tr>
        <tr v-if="s('finalCalls')">
          <td>说完 → 终稿文本</td>
          <td>{{ s('avgFinalLatencyMs') }} ms（服务端 {{ s('avgFinalServerMs') }} ms）</td>
        </tr>
        <tr v-if="s('firstSentenceCount')"><td>提问 → 首句生成</td><td>{{ s('avgFirstSentenceMs') }} ms</td></tr>
        <tr v-if="s('firstAudioCount')"><td>首句 → 首段音频</td><td>{{ s('avgFirstAudioMs') }} ms</td></tr>
        <tr v-if="s('finalCalls') || s('segmentCalls')">
          <td>ASR 音频秒（计费口径）</td><td>{{ s('asrAudioSec') }} s</td>
        </tr>
      </tbody>
    </table>

    <!-- 播报期间的回声与插话（P3a）：插话门限该抬多高，就看这两行的比例——
         越限比例还高 → 门限要往上抬；判错多 → 同样是门限太低或持续时长太短。 -->
    <table v-if="speech && s('echoSamples')">
      <tbody>
        <tr><td>播报期间回声</td><td>{{ s('avgEchoDb') }} dB（RMS {{ s('avgEchoRms') }}）</td></tr>
        <tr>
          <td>其中越过说话阈值 / 插话门限</td>
          <td>{{ percent('echoOverRate') }} / {{ percent('echoFarOverRate') }}</td>
        </tr>
        <tr><td>判出的插话 / 其中判错</td><td>{{ s('bargeIns') }} / {{ s('bargeInRejected') }}</td></tr>
      </tbody>
    </table>

    <template v-if="uncovered.length">
      <div class="title" style="margin-top: 14px">待补资料的问题</div>
      <div v-for="item in uncovered" :key="item.question + item.at" class="meta">
        {{ item.question }} · {{ when(item.at) }}
      </div>
    </template>

    <KnowledgePanel :token="committedToken" />
    <DiagnosticsPanel :token="committedToken" />
  </section>
</template>
