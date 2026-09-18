import { useEffect, useRef, useState } from 'react';

export type AvatarMood = 'idle' | 'thinking' | 'speaking';

interface Live2DStageProps {
  mood: AvatarMood;
}

/**
 * 虚拟形象占位舞台（程序化绘制的几何讲解员）。
 * 有授权模型时替换本组件即可；界面不显示技术提示与状态徽标。
 */
export function Live2DStage({ mood }: Live2DStageProps) {
  const [mouth, setMouth] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (mood !== 'speaking') {
      setMouth(0);
      return;
    }
    const t0 = performance.now();
    const tick = (t: number) => {
      const phase = (t - t0) / 120;
      const open = 0.35 + 0.65 * Math.abs(Math.sin(phase));
      setMouth(open);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mood]);

  const bounce = mood === 'speaking' ? 2 : mood === 'thinking' ? 1 : 0;

  return (
    <div className="stage" data-mood={mood} aria-label="AI 虚拟讲解员">
      <div className={`avatar bounce-${bounce}`}>
        <div className="avatar-glow" />
        <div className="avatar-head">
          <div className="avatar-hair" />
          <div className="avatar-face">
            <div className="eye left" />
            <div className="eye right" />
            <div className="blush left" />
            <div className="blush right" />
            <div className="mouth" style={{ height: `${8 + mouth * 18}px` }} />
          </div>
        </div>
        <div className="avatar-body">
          <div className="avatar-collar" />
        </div>
      </div>
    </div>
  );
}
