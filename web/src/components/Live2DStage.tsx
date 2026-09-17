import { useEffect, useRef, useState } from 'react';

export type AvatarMood = 'idle' | 'thinking' | 'speaking';

interface Live2DStageProps {
  mood: AvatarMood;
}

/**
 * Live2D 占位舞台：
 * - 有官方 Cubism 模型时可替换为 pixi-live2d-display 渲染层
 * - 当前用 CSS 几何头像 + 口型动画，保证无版权模型也能演示完整链路
 */
export function Live2DStage({ mood }: Live2DStageProps) {
  const [mouth, setMouth] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (mood !== 'speaking') {
      setMouth(0);
      return;
    }
    let t0 = performance.now();
    const tick = (t: number) => {
      const phase = (t - t0) / 120;
      const open = 0.35 + 0.65 * Math.abs(Math.sin(phase));
      setMouth(open);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mood]);

  const bounce =
    mood === 'speaking' ? 2 : mood === 'thinking' ? 1 : 0;

  return (
    <div className="stage" data-mood={mood} aria-label="虚拟接待员形象">
      <div className="stage-badge">
        {mood === 'speaking'
          ? '正在朗读'
          : mood === 'thinking'
            ? '思考中'
            : '待机'}
      </div>
      <div className={`avatar bounce-${bounce}`}>
        <div className="avatar-glow" />
        <div className="avatar-head">
          <div className="avatar-hair" />
          <div className="avatar-face">
            <div className="eye left" />
            <div className="eye right" />
            <div className="blush left" />
            <div className="blush right" />
            <div
              className="mouth"
              style={{ height: `${8 + mouth * 18}px` }}
            />
          </div>
        </div>
        <div className="avatar-body">
          <div className="avatar-collar" />
        </div>
      </div>
      <p className="stage-caption">AI 虚拟接待员 · Live2D 就绪</p>
      <p className="stage-hint">
        可将 Cubism 模型放入 public/live2d 后替换此占位层
      </p>
    </div>
  );
}
