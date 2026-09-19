import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 加载 server/.env（不覆盖已存在的进程环境变量）。
 *
 * 注意：任何要读环境变量决定行为的入口都必须先调用它——服务进程、标定脚本、评测脚本。
 * 此前只有 index.ts 加载，导致 calibrate / eval 跑的是**代码默认阈值**而不是线上 .env 的值，
 * 于是「verify 通过」与「线上实际配置」可能不是同一套参数。
 */
export async function loadDotEnv(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(here, '../../.env');
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // .env 可选：缺失时全部走代码默认值
  }
}
