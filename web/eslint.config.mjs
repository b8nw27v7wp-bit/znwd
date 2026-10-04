// @ts-check
//
// P2-C：前端 ESLint 门禁。只看 `web/src` 下的 .ts/.vue（npm run lint = eslint .，
// 由下面各段的 files 白名单圈定范围）。
//
// 取舍（有意为之，改规则前先读）：
//   · 错误级只留「真问题」：未使用变量、重复键、明显 bug 类（typescript-eslint recommended）。
//   · 风格类一律不开（引号/分号/缩进、模板排版）：仓库没有 prettier，是手写风格，
//     开风格规则等于逼着大面积机械重写业务代码，与「不为过规则重写」的约定冲突。
//   · no-undef 不在 ESLint 开：未定义变量由 vue-tsc 类型检查抓（npm run build / CI 必跑），
//     ESLint 再开一遍要维护浏览器全局变量表，收益为零还容易误报。
//   · @typescript-eslint/no-explicit-any 降为 off：现有代码在 API/存储边界有少量 any 断言，
//     升 error 要改的是业务与测试的类型语义，不是修 bug——留给 vue-tsc 的 strict 兜底。
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';

// TS 与 Vue 共用的「真问题」覆盖段（recommended 之上的调整）
const rules = {
  // any：边界断言既有事实，见文件头注释；关掉不等于放任新增，review 里看
  '@typescript-eslint/no-explicit-any': 'off',
  // 未使用变量：error，但 `_` 前缀是约定俗成的占位（解构丢弃、接口空实现）
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
};

export default tseslint.config(
  // 产物与另跑的环境不进 lint：dist/coverage 是构建产物，__live__ 是真机集成用例（走 vitest.live.config.ts）
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'src/__live__/**'] },

  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules,
  },

  {
    files: ['src/**/*.vue'],
    extends: [...pluginVue.configs['flat/essential']],
    // 只要 essential 层（真问题）：strongly-recommended/recommended 全是模板排版风格规则，按取舍不开
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parserOptions: {
        // <script> 按 TS 解析（默认是 espree，吃不下 TS 语法）
        parser: tseslint.parser,
      },
    },
    rules,
  },
);
