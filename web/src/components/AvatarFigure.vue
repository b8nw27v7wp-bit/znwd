<script setup lang="ts">
/**
 * 虚拟讲解员形象（第一版：手写 SVG 扁平插画）。
 *
 * 为什么用手写 SVG 而不是贴图/生成图：
 *  1) 能让口型跟着回答动（state='speaking'）、空闲时眨眼与呼吸——讲解员场景需要"活着"的感觉；
 *  2) 无外部资源、无依赖、体积极小，展厅一体机断网也能显示；
 *  3) 后续要换真 3D/Live2D 时，只替换这个组件即可（外部只用 state 这一个接口）。
 *
 * 绘制顺序有讲究：后发的头发 → 头 → 耳朵 → 五官 → 刘海，这样耳朵不会被头发盖住。
 */
const props = withDefaults(defineProps<{ state?: 'idle' | 'speaking' | 'thinking' }>(), {
  state: 'idle',
});

</script>

<template>
  <svg
    class="avatar"
    :class="`avatar--${props.state}`"
    viewBox="0 0 320 420"
    role="img"
    aria-label="展厅虚拟讲解员形象"
  >
    <!-- 地面投影 -->
    <ellipse class="avatar-shadow" cx="160" cy="404" rx="76" ry="9" fill="#1d1d1f" opacity="0.05" />

    <g class="avatar-figure">
      <!-- 上身（工作制服：暖白 + 品牌蓝点缀，避免读成医护服） -->
      <path d="M 58 420 C 58 348 94 304 160 304 C 226 304 262 348 262 420 Z" fill="#eef1f5" />
      <path d="M 132 306 L 160 344 L 188 306" fill="none" stroke="#dbe2ea" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M 160 344 L 160 420" stroke="#dfe5ec" stroke-width="3" />
      <!-- 工牌挂绳 + 工牌：一眼看出是工作人员 -->
      <path d="M 148 308 L 144 356" fill="none" stroke="#9dc0e8" stroke-width="4" stroke-linecap="round" />
      <path d="M 174 308 L 178 356" fill="none" stroke="#9dc0e8" stroke-width="4" stroke-linecap="round" />
      <rect x="138" y="352" width="46" height="30" rx="5" fill="#f7fafd" stroke="#d3e0ef" stroke-width="2" />
      <rect x="146" y="360" width="30" height="4" rx="2" fill="#0071e3" opacity="0.5" />
      <rect x="146" y="370" width="20" height="4" rx="2" fill="#e8eef6" />

      <!-- 脖子 -->
      <rect x="146" y="258" width="28" height="52" rx="14" fill="#eac3a9" />

      <!-- 头发（后层：包住头两侧、垂到肩，头与耳朵会盖在它上面） -->
      <path
        d="M 94 210 C 90 140 124 112 160 112 C 196 112 230 140 226 210
           C 230 248 232 280 224 294 C 210 302 196 296 190 286
           C 202 258 206 226 204 204 C 180 184 140 184 116 204
           C 114 226 118 258 130 286 C 124 296 110 302 96 294
           C 88 280 90 248 94 210 Z"
        fill="#3c3c40"
      />

      <!-- 头 -->
      <ellipse cx="160" cy="212" rx="64" ry="72" fill="#f4d3ba" />
      <ellipse cx="118" cy="240" rx="13" ry="8" fill="#eebfa5" opacity="0.5" />
      <ellipse cx="202" cy="240" rx="13" ry="8" fill="#eebfa5" opacity="0.5" />

      <!-- 耳朵（在头发之上，露出来） -->
      <ellipse cx="96" cy="222" rx="9" ry="13" fill="#f4d3ba" />
      <path d="M 95 216 C 100 219 100 226 95 229" fill="none" stroke="#e9c5aa" stroke-width="2.5" stroke-linecap="round" />
      <ellipse cx="224" cy="222" rx="9" ry="13" fill="#f4d3ba" />

      <!-- 眉毛 -->
      <path d="M 122 190 C 128 183 142 183 148 189" fill="none" stroke="#4a4a4f" stroke-width="3.5" stroke-linecap="round" />
      <path d="M 172 189 C 178 183 192 183 198 190" fill="none" stroke="#4a4a4f" stroke-width="3.5" stroke-linecap="round" />

      <!-- 眼睛（眨眼靠上睑色块压下） -->
      <g>
        <ellipse cx="133" cy="214" rx="8" ry="9" fill="#33333a" />
        <circle cx="136" cy="210" r="2.6" fill="#ffffff" opacity="0.9" />
        <rect class="avatar-lid" x="123" y="204" width="20" height="20" fill="#f4d3ba" />
      </g>
      <g>
        <ellipse cx="187" cy="214" rx="8" ry="9" fill="#33333a" />
        <circle cx="190" cy="210" r="2.6" fill="#ffffff" opacity="0.9" />
        <rect class="avatar-lid" x="177" y="204" width="20" height="20" fill="#f4d3ba" />
      </g>

      <!-- 鼻子（小鼻头，带一点体积感，不能是一根细线） -->
      <path d="M 158 224 C 151 234 151 244 158 247 C 164 249 168 245 167 240 C 166 234 164 229 164 224 Z" fill="#e6bda2" />
      <path d="M 154 247 C 158 250 164 249 167 246" fill="none" stroke="#e9c5aa" stroke-width="2" stroke-linecap="round" />

      <!-- 嘴（说话时上下开合） -->
      <g class="avatar-mouth">
        <path d="M 146 262 C 152 270 168 270 174 262" fill="none" stroke="#c98d76" stroke-width="4.5" stroke-linecap="round" />
      </g>

      <!-- 刘海（斜分，压在额头上） -->
      <path
        d="M 100 188 C 104 148 128 130 160 130 C 192 130 216 150 220 188
           C 214 166 206 154 194 148 C 176 163 150 169 138 169
           C 124 169 110 175 100 188 Z"
        fill="#3c3c40"
      />
      <!-- 发缝：一条线就有层次，不用渐变（大屏远看也干净） -->
      <path d="M 156 132 C 148 146 145 158 147 170" fill="none" stroke="#5a5a60" stroke-width="3" stroke-linecap="round" />

      <!-- 讲解员耳麦 -->
      <ellipse cx="224" cy="224" rx="8" ry="11" fill="#dfe3e9" />
      <path d="M 224 233 C 238 250 230 268 200 270" fill="none" stroke="#c9ced6" stroke-width="4" stroke-linecap="round" />
      <circle cx="198" cy="270" r="4.5" fill="#8f96a3" />
    </g>
  </svg>
</template>

<style scoped>
.avatar {
  width: 100%;
  height: 100%;
  display: block;
}

/* 呼吸：整身极小幅上下浮动，避免"立牌"感 */
.avatar-figure {
  transform-box: fill-box;
  transform-origin: bottom center;
  animation: avatar-breathe 5.2s ease-in-out infinite;
}

@keyframes avatar-breathe {
  0%,
  100% {
    transform: translateY(0) scaleY(1);
  }
  50% {
    transform: translateY(3px) scaleY(0.995);
  }
}

/* 眨眼：上睑每 4.6s 压下一次 */
.avatar-lid {
  transform-box: fill-box;
  transform-origin: top center;
  transform: scaleY(0);
  animation: avatar-blink 4.6s infinite;
}

@keyframes avatar-blink {
  0%,
  92%,
  100% {
    transform: scaleY(0);
  }
  95% {
    transform: scaleY(1);
  }
}

.avatar-mouth {
  transform-box: fill-box;
  transform-origin: center;
}

/* 说话：口型快速开合 */
.avatar--speaking .avatar-mouth {
  animation: avatar-talk 0.3s ease-in-out infinite alternate;
}

@keyframes avatar-talk {
  from {
    transform: scaleY(0.45);
  }
  to {
    transform: scaleY(1.35);
  }
}

/* 思考：轻微侧头 */
.avatar--thinking .avatar-figure {
  animation:
    avatar-breathe 5.2s ease-in-out infinite,
    avatar-tilt 2.4s ease-in-out infinite;
}

@keyframes avatar-tilt {
  0%,
  100% {
    rotate: 0deg;
  }
  50% {
    rotate: 2deg;
  }
}

@media (prefers-reduced-motion: reduce) {
  .avatar-figure,
  .avatar-lid,
  .avatar--speaking .avatar-mouth {
    animation: none;
  }
}
</style>
