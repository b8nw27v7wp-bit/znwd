<script setup lang="ts">
import { ref } from 'vue';
import AvatarFigure from './AvatarFigure.vue';

/**
 * 虚拟讲解员形象（立绘优先，手绘 SVG 兜底）。
 *
 * 立绘：public/avatar-guide.png（576×1024 竖版，纯白底）。
 *
 * 取景口径（动这一个数就能调"露出多少身体"）：
 *   .portrait-frame 的 --frame-ratio 决定画面里露到哪——元素高 = 比例 × 框高，
 *   框内只看得到元素上部 1/比例，换算到原图：
 *     1.20 → 可见约 450px（只露头肩，人最大）
 *     1.65 → 可见约 620px（头到胸口，当前设置）
 *     1.95 → 整个人都在（人最小，留白最多）
 *   比例越大 → 人越小、露出的身体越多。底部渐隐必须跟着这个比例一起换算
 *   （见 --fade-* / --visible），否则会在身上硬切一刀。
 *
 * 白底处理：mix-blend-mode: multiply 让近白像素融进页面白底（白底页面上对主体几乎无影响）。
 * 兜底：立绘加载失败（文件被删/断网）时自动换回 SVG 形象，页面不会空白。
 * 换形象：替换 public/avatar-guide.png 即可。要眨眼/口型那种真动作得换 Live2D/3D 模型。
 */
const props = withDefaults(
  defineProps<{ state?: 'idle' | 'speaking' | 'thinking' | 'listening'; src?: string }>(),
  { state: 'idle', src: '/avatar-guide.png' },
);

const failed = ref(false);
</script>

<template>
  <div v-if="!failed" class="portrait-frame">
    <img
      class="portrait"
      :class="`portrait--${props.state}`"
      :src="props.src"
      alt="展厅虚拟讲解员形象"
      @error="failed = true"
    />
  </div>
  <AvatarFigure v-else :state="props.state" />
</template>

<style scoped>
.portrait-frame {
  /* 露出多少身体：1.65 = 头到胸口（越大露得越多、人越小） */
  --frame-ratio: 1.65;
  /* 可见窗口占元素高度的比例；渐隐按它换算，74/84/93% 是分段缓出 */
  --visible: calc(100% / var(--frame-ratio));
  --fade-0: calc(var(--visible) * 0.74);
  --fade-1: calc(var(--visible) * 0.84);
  --fade-2: calc(var(--visible) * 0.93);

  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  display: flex;
  justify-content: center;
  align-items: flex-start;
}

.portrait {
  height: calc(100% * var(--frame-ratio));
  width: auto;
  flex: none;
  display: block;
  mix-blend-mode: multiply;
  -webkit-mask-image: linear-gradient(
    to bottom,
    #000 var(--fade-0),
    rgba(0, 0, 0, 0.85) var(--fade-1),
    rgba(0, 0, 0, 0.4) var(--fade-2),
    transparent var(--visible)
  );
  mask-image: linear-gradient(
    to bottom,
    #000 var(--fade-0),
    rgba(0, 0, 0, 0.85) var(--fade-1),
    rgba(0, 0, 0, 0.4) var(--fade-2),
    transparent var(--visible)
  );
}

/* 空闲：极慢的呼吸起伏，避免"立牌"感。
   聆听中沿用同一档：常开聆听是展厅的常态，单给它一档更快的动画等于把「有人说话」的信号稀释掉 */
.portrait--idle,
.portrait--listening,
.portrait--thinking {
  animation: portrait-breathe 6.4s ease-in-out infinite;
}

/* 回答中：幅度略大、节奏略快，算是"在说话"的替代信号（立绘没法动口型） */
.portrait--speaking {
  animation: portrait-breathe 2.8s ease-in-out infinite;
}

@keyframes portrait-breathe {
  0%,
  100% {
    transform: translateY(0) scale(1);
  }
  50% {
    transform: translateY(3px) scale(1.006);
  }
}

.portrait--thinking {
  animation:
    portrait-breathe 6.4s ease-in-out infinite,
    portrait-sway 3.4s ease-in-out infinite;
}

@keyframes portrait-sway {
  0%,
  100% {
    rotate: 0deg;
  }
  50% {
    rotate: 1deg;
  }
}

@media (prefers-reduced-motion: reduce) {
  .portrait,
  .portrait--thinking {
    animation: none;
  }
}
</style>
