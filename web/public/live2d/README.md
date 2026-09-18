# 虚拟形象

当前前端使用 **豆包风格二维 SVG** 形象（`web/src/components/Live2DStage.tsx`），无需外部资源。

## 形象特征

- 奶油色圆润头部 + 绿色豆形身体  
- 大眼高光、腮红、顶部小芽  
- 状态：待机呼吸 / 思考摇头+三点 / 朗读口型  

## 替换为正式 Live2D（可选）

1. 取得 Cubism 4 模型授权文件。  
2. 将 `*.model3.json` 及资源放入本目录。  
3. 在 `Live2DStage.tsx` 用 `pixi.js` + `@pixi-live2d-display` 渲染。  
4. 保持 `AvatarMood = idle | thinking | speaking` 接口，将 mood 映射到动作/口型参数。

仓库不附带商业 Live2D 模型，避免版权风险。
