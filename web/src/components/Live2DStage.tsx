import { useEffect, useRef, useState } from 'react';

export type AvatarMood = 'idle' | 'thinking' | 'speaking';

interface Live2DStageProps {
  mood: AvatarMood;
}

/** 职业女讲解员（扁平 SVG），在左栏约 1/3 屏内大尺寸展示 */
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
      const phase = (t - t0) / 120;
      setMouth(0.2 + 0.8 * Math.abs(Math.sin(phase)));
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
      timer = window.setTimeout(loop, 4000 + Math.random() * 2000);
    };
    timer = window.setTimeout(loop, 2500);
    return () => window.clearTimeout(timer);
  }, []);

  const open = mouth;
  const lipRy = 2 + open * 10;
  const lipRx = 9 + open * 3;

  return (
    <div className="stage" data-mood={mood} aria-label="AI 虚拟讲解员">
      <div className={`hostess hostess--${mood}`}>
        <svg
          className="hostess-svg"
          viewBox="0 0 320 480"
          preserveAspectRatio="xMidYMax meet"
          role="img"
          aria-hidden="true"
        >
          {/* 身体 / 西装 */}
          <path
            d="M96 300c-28 16-44 48-48 96-2 28 2 56 8 72h208c6-16 10-44 8-72-4-48-20-80-48-96-22-12-48-18-64-18s-42 6-64 18z"
            fill="#2b2b2e"
          />
          {/* 白衬衫领口 */}
          <path
            d="M138 292c8 24 14 36 22 36s14-12 22-36c-6-4-14-6-22-6s-16 2-22 6z"
            fill="#f7f7f8"
          />
          {/* 绿丝巾 */}
          <path d="M160 328c-4 14-4 28 0 40 10-4 16-16 18-28-6-2-12-6-18-12z" fill="#3db882" />
          <path d="M160 328c4 14 4 28 0 40-10-4-16-16-18-28 6-2 12-6 18-12z" fill="#5ecf9a" />

          {/* 手臂 */}
          <path d="M96 310c-24 18-40 48-42 84 0 6 8 10 14 6 10-6 16-34 24-54 4-10 8-20 10-28z" fill="#2b2b2e" />
          <path d="M224 310c24 18 40 48 42 84 0 6-8 10-14 6-10-6-16-34-24-54-4-10-8-20-10-28z" fill="#2b2b2e" />
          <ellipse cx="70" cy="408" rx="11" ry="15" fill="#e8c4b0" />
          <ellipse cx="250" cy="408" rx="11" ry="15" fill="#e8c4b0" />

          {/* 后发 */}
          <path
            d="M92 200c-4-72 28-140 68-140s72 68 68 140c6 36 14 78 16 110 2 20-8 34-20 32-10-2-12-18-10-34 4-32 2-60-4-82-4-14-16-24-34-28h-40c-18 4-30 14-34 28-6 22-8 50-4 82 2 16 0 32-10 34-12 2-22-12-20-32 2-32 10-74 16-110z"
            fill="#242428"
          />

          {/* 颈 */}
          <ellipse cx="160" cy="268" rx="18" ry="24" fill="#e8c4b0" />

          {/* 脸 */}
          <ellipse cx="160" cy="188" rx="58" ry="68" fill="#f3d4c0" />

          {/* 刘海 */}
          <path
            d="M108 180c4-54 28-88 52-88s48 34 52 88c-8-24-22-38-38-42-4 16-14 28-28 32-14 4-28 10-38 10z"
            fill="#242428"
          />
          <path d="M118 166c12-10 28-20 42-18 14 2 28 12 38 28-12-6-24-8-38-6-14 2-28 6-42 10z" fill="#333338" />

          {/* 侧发 */}
          <path d="M104 190c-2 24 0 48 4 66 2 8-4 12-12 8-16-10-22-34-18-58 2-14 8-20 16-20 4 0 8 2 10 4z" fill="#242428" />
          <path d="M216 190c2 24 0 48-4 66-2 8 4 12 12 8 16-10 22-34 18-58-2-14-8-20-16-20-4 0-8 2-10 4z" fill="#242428" />

          {/* 眉 / 眼 / 唇 */}
          <path d="M128 168c8-6 18-8 26-4" stroke="#242428" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          <path d="M166 164c8-4 18-2 26 4" stroke="#242428" strokeWidth="2.4" fill="none" strokeLinecap="round" />

          <g className={`hostess-eyes ${blink ? 'is-blink' : ''}`}>
            {mood === 'thinking' ? (
              <>
                <path d="M128 194c7-7 17-7 24-1" stroke="#2b2b2e" strokeWidth="2.6" fill="none" strokeLinecap="round" />
                <path d="M172 193c7-6 17-6 24 1" stroke="#2b2b2e" strokeWidth="2.6" fill="none" strokeLinecap="round" />
              </>
            ) : (
              <>
                <ellipse cx="140" cy="196" rx="9" ry="10.5" fill="#2b2b2e" />
                <ellipse cx="184" cy="196" rx="9" ry="10.5" fill="#2b2b2e" />
                <circle cx="143.5" cy="192.5" r="2.6" fill="#fff" />
                <circle cx="187.5" cy="192.5" r="2.6" fill="#fff" />
              </>
            )}
          </g>

          <ellipse cx="128" cy="214" rx="9" ry="5" fill="#e8a090" opacity="0.4" />
          <ellipse cx="192" cy="214" rx="9" ry="5" fill="#e8a090" opacity="0.4" />

          {mood === 'speaking' ? (
            <ellipse cx="160" cy="228" rx={lipRx} ry={lipRy} fill="#c45c5c" />
          ) : mood === 'thinking' ? (
            <path d="M148 230c4 3 14 3 18 0" stroke="#c45c5c" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          ) : (
            <path d="M144 226c7 8 25 8 32 0" stroke="#c45c5c" strokeWidth="2.6" fill="none" strokeLinecap="round" />
          )}

          {mood === 'thinking' && (
            <g fill="#3db882">
              <circle cx="250" cy="150" r="4" className="dot d1" />
              <circle cx="266" cy="134" r="5" className="dot d2" />
              <circle cx="282" cy="118" r="6" className="dot d3" />
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
