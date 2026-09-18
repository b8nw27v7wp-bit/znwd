import { useEffect, useRef, useState } from 'react';

export type AvatarMood = 'idle' | 'thinking' | 'speaking';

interface Live2DStageProps {
  mood: AvatarMood;
}

/** 成熟职业女讲解员（扁平 SVG），可后续替换正式 Live2D */
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
      setMouth(0.15 + 0.85 * Math.abs(Math.sin(phase)));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mood]);

  useEffect(() => {
    let timer: number;
    const loop = () => {
      setBlink(true);
      window.setTimeout(() => setBlink(false), 130);
      timer = window.setTimeout(loop, 3600 + Math.random() * 2200);
    };
    timer = window.setTimeout(loop, 2200);
    return () => window.clearTimeout(timer);
  }, []);

  const mouthOpen = mouth;
  const mouthRy = 2.2 + mouthOpen * 9;
  const mouthRx = 7 + mouthOpen * 3;

  return (
    <div className="stage" data-mood={mood} aria-label="AI 虚拟讲解员">
      <div className={`mascot mascot--${mood}`}>
        <svg className="mascot-svg" viewBox="0 0 280 420" role="img" aria-hidden="true">
          <ellipse cx="140" cy="404" rx="70" ry="10" fill="#e8e8ed" opacity="0.65" />

          {/* 长发（后层） */}
          <path
            d="M70 160c0-70 30-120 70-120s70 50 70 120c8 40 18 90 22 140 2 28-8 48-22 48-10 0-14-16-12-36 6-40 4-70-2-92-4-12-14-20-28-22h-56c-14 2-24 10-28 22-6 22-8 52-2 92 2 20-2 36-12 36-14 0-24-20-22-48 4-50 14-100 22-140z"
            fill="#2c2c30"
          />

          {/* 脖子 */}
          <ellipse cx="140" cy="210" rx="16" ry="22" fill="#e8c4b0" />

          {/* 职业着装：深色西装 + 绿色丝巾 */}
          <path
            d="M78 230c-18 8-34 28-38 70-4 36 0 70 4 94h192c4-24 8-58 4-94-4-42-20-62-38-70-20-8-42-12-62-12s-42 4-62 12z"
            fill="#2b2b2e"
          />
          <path
            d="M110 228c10 28 20 40 30 40s20-12 30-40c-8-4-18-6-30-6s-22 2-30 6z"
            fill="#f5f5f7"
          />
          <path
            d="M140 268c-6 10-8 22-6 36 12-4 20-16 24-30-6 0-12-2-18-6z"
            fill="#3db882"
          />
          <path
            d="M140 268c6 10 8 22 6 36-12-4-20-16-24-30 6 0 12-2 18-6z"
            fill="#5ecf9a"
          />

          {/* 手臂 */}
          <path
            d="M72 240c-20 14-34 40-36 72 0 8 8 12 14 8 8-4 14-28 22-48 4-10 8-20 12-28z"
            fill="#2b2b2e"
          />
          <path
            d="M208 240c20 14 34 40 36 72 0 8-8 12-14 8-8-4-14-28-22-48-4-10-8-20-12-28z"
            fill="#2b2b2e"
          />
          <ellipse cx="48" cy="322" rx="10" ry="14" fill="#e8c4b0" />
          <ellipse cx="232" cy="322" rx="10" ry="14" fill="#e8c4b0" />

          {/* 脸 */}
          <ellipse cx="140" cy="148" rx="52" ry="62" fill="#f3d4c0" />

          {/* 刘海 */}
          <path
            d="M88 140c2-48 24-78 52-78 28 0 50 30 52 78-8-22-20-34-36-38-6 14-18 24-34 28-16 4-28 8-34 10z"
            fill="#2c2c30"
          />
          <path
            d="M96 128c10-8 28-20 44-18 16 2 32 12 42 28-12-6-26-8-42-6-16 2-30 6-44 12z"
            fill="#3a3a40"
          />

          {/* 鬓发 */}
          <path d="M90 150c-4 20-4 40 0 56 2 8-4 14-12 10-14-8-20-30-18-52 2-14 8-22 18-22 6 0 10 4 12 8z" fill="#2c2c30" />
          <path d="M190 150c4 20 4 40 0 56-2 8 4 14 12 10 14-8 20-30 18-52-2-14-8-22-18-22-6 0-10 4-12 8z" fill="#2c2c30" />

          {/* 眉毛 */}
          <path d="M108 132c8-6 18-8 26-4" stroke="#2c2c30" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          <path d="M146 128c8-4 18-2 26 4" stroke="#2c2c30" strokeWidth="2.2" fill="none" strokeLinecap="round" />

          {/* 眼睛 */}
          <g className={`mascot-eyes ${blink ? 'is-blink' : ''}`}>
            {mood === 'thinking' ? (
              <>
                <path d="M108 154c6-7 16-7 22-1" stroke="#2b2b2e" strokeWidth="2.4" fill="none" strokeLinecap="round" />
                <path d="M150 153c6-6 16-6 22 1" stroke="#2b2b2e" strokeWidth="2.4" fill="none" strokeLinecap="round" />
              </>
            ) : (
              <>
                <ellipse cx="118" cy="156" rx="8" ry="9" fill="#2b2b2e" />
                <ellipse cx="162" cy="156" rx="8" ry="9" fill="#2b2b2e" />
                <circle cx="121" cy="153" r="2.4" fill="#ffffff" />
                <circle cx="165" cy="153" r="2.4" fill="#ffffff" />
              </>
            )}
          </g>

          {/* 鼻影 */}
          <path d="M140 168c2 6 2 10 0 12" stroke="#d9b49a" strokeWidth="1.5" fill="none" strokeLinecap="round" />

          {/* 口红 / 口型 */}
          {mood === 'speaking' ? (
            <ellipse cx="140" cy="186" rx={mouthRx} ry={mouthRy} fill="#c45c5c" />
          ) : mood === 'thinking' ? (
            <path d="M130 188c4 4 16 4 20 0" stroke="#c45c5c" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          ) : (
            <path d="M126 186c6 7 22 7 28 0" stroke="#c45c5c" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          )}

          {/* 淡妆腮红 */}
          <ellipse cx="108" cy="172" rx="8" ry="4.5" fill="#e8a090" opacity="0.45" />
          <ellipse cx="172" cy="172" rx="8" ry="4.5" fill="#e8a090" opacity="0.45" />

          {/* 耳环 */}
          <circle cx="88" cy="168" r="3" fill="#5ecf9a" />
          <circle cx="192" cy="168" r="3" fill="#5ecf9a" />

          {/* 思考点 */}
          {mood === 'thinking' && (
            <g fill="#3db882">
              <circle cx="230" cy="120" r="3.5" className="dot d1" />
              <circle cx="244" cy="106" r="4.5" className="dot d2" />
              <circle cx="258" cy="92" r="5.5" className="dot d3" />
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
