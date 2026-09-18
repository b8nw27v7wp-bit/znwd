import { useEffect, useRef, useState } from 'react';

export type AvatarMood = 'idle' | 'thinking' | 'speaking';

interface Live2DStageProps {
  mood: AvatarMood;
}

/**
 * 豆包风格二维形象（扁平 SVG）
 * 可后续替换为真实 Live2D：见 public/live2d/README.md
 */
export function Live2DStage({ mood }: Live2DStageProps) {
  const [mouth, setMouth] = useState(0);
  const [blink, setBlink] = useState(false);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (mood !== 'speaking') {
      setMouth(0);
      return;
    }
    const t0 = performance.now();
    const tick = (t: number) => {
      const phase = (t - t0) / 110;
      const open = 0.2 + 0.8 * Math.abs(Math.sin(phase));
      setMouth(open);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mood]);

  useEffect(() => {
    let timer: number;
    const loop = () => {
      setBlink(true);
      window.setTimeout(() => setBlink(false), 120);
      timer = window.setTimeout(loop, 3200 + Math.random() * 2400);
    };
    timer = window.setTimeout(loop, 2000);
    return () => window.clearTimeout(timer);
  }, []);

  // 口型：0 关，1 全开
  const mouthOpen = mouth;
  const mouthRy = 3 + mouthOpen * 16;
  const mouthRx = 10 + mouthOpen * 4;

  return (
    <div className="stage" data-mood={mood} aria-label="AI 虚拟讲解员">
      <div className={`mascot mascot--${mood}`}>
        <svg
          className="mascot-svg"
          viewBox="0 0 240 280"
          role="img"
          aria-hidden="true"
        >
          {/* 地面软影 */}
          <ellipse cx="120" cy="262" rx="58" ry="10" fill="#e8e8ed" opacity="0.7" />

          {/* 身体（豆包式圆润壳体） */}
          <g className="mascot-body">
            <ellipse cx="120" cy="200" rx="72" ry="58" fill="#5ecf9a" />
            <ellipse cx="120" cy="188" rx="54" ry="40" fill="#7fdcb3" />
            {/* 腹部浅色 */}
            <ellipse cx="120" cy="208" rx="36" ry="28" fill="#e9faf3" />
          </g>

          {/* 手臂 */}
          <ellipse cx="52" cy="188" rx="16" ry="22" fill="#5ecf9a" transform="rotate(-18 52 188)" />
          <ellipse cx="188" cy="188" rx="16" ry="22" fill="#5ecf9a" transform="rotate(18 188 188)" />

          {/* 头 */}
          <g className="mascot-head">
            {/* 外轮廓软圆头 */}
            <ellipse cx="120" cy="108" rx="78" ry="72" fill="#fff6eb" />
            {/* 顶部小芽/天线，豆包辨识点 */}
            <path
              d="M120 38c0-10 10-18 18-14 2 8-4 16-12 18l-6-4z"
              fill="#3db882"
            />
            <circle cx="138" cy="28" r="7" fill="#2fb577" />
            <ellipse cx="120" cy="40" rx="8" ry="10" fill="#5ecf9a" />

            {/* 耳侧装饰 */}
            <ellipse cx="48" cy="112" rx="12" ry="16" fill="#f0d9c4" />
            <ellipse cx="192" cy="112" rx="12" ry="16" fill="#f0d9c4" />

            {/* 脸颊腮红 */}
            <ellipse cx="72" cy="124" rx="12" ry="7" fill="#f7b8a8" opacity="0.75" />
            <ellipse cx="168" cy="124" rx="12" ry="7" fill="#f7b8a8" opacity="0.75" />

            {/* 眼睛 */}
            <g className={`mascot-eyes ${blink ? 'is-blink' : ''}`}>
              {mood === 'thinking' ? (
                <>
                  <path
                    d="M78 108c6-8 18-8 24 0"
                    stroke="#2b2b2e"
                    strokeWidth="4"
                    fill="none"
                    strokeLinecap="round"
                  />
                  <path
                    d="M138 108c6-8 18-8 24 0"
                    stroke="#2b2b2e"
                    strokeWidth="4"
                    fill="none"
                    strokeLinecap="round"
                  />
                </>
              ) : (
                <>
                  <ellipse cx="90" cy="110" rx="11" ry="13" fill="#2b2b2e" />
                  <ellipse cx="150" cy="110" rx="11" ry="13" fill="#2b2b2e" />
                  <circle cx="94" cy="105" r="3.5" fill="#ffffff" />
                  <circle cx="154" cy="105" r="3.5" fill="#ffffff" />
                  <circle cx="86" cy="114" r="1.6" fill="#ffffff" opacity="0.7" />
                  <circle cx="146" cy="114" r="1.6" fill="#ffffff" opacity="0.7" />
                </>
              )}
            </g>

            {/* 口型 / 表情 */}
            {mood === 'speaking' ? (
              <ellipse
                cx="120"
                cy="136"
                rx={mouthRx}
                ry={mouthRy}
                fill="#c45c5c"
              />
            ) : mood === 'thinking' ? (
              <path
                d="M108 136c4 6 20 6 24 0"
                stroke="#c45c5c"
                strokeWidth="3.5"
                fill="none"
                strokeLinecap="round"
              />
            ) : (
              <path
                d="M104 132c6 10 26 10 32 0"
                stroke="#c45c5c"
                strokeWidth="4"
                fill="none"
                strokeLinecap="round"
              />
            )}

            {/* 思考点 */}
            {mood === 'thinking' && (
              <g className="mascot-dots" fill="#3db882">
                <circle cx="196" cy="72" r="4" className="dot d1" />
                <circle cx="210" cy="58" r="5" className="dot d2" />
                <circle cx="224" cy="44" r="6" className="dot d3" />
              </g>
            )}
          </g>
        </svg>
      </div>
    </div>
  );
}
