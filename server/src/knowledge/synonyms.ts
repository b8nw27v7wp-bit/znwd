/** 展区同义词：扩展检索查询 */
const SYN: Record<string, string[]> = {
  光伏: ['光伏', '太阳能', '组件', '电站', '清洗'],
  清洁: ['清洁', '清洗', '清扫', '除尘'],
  风场: ['风场', '风电', '风机', '风力'],
  叶片: ['叶片', '叶轮', '风叶'],
  检测: ['检测', '巡检', '检查', '缺陷'],
  无人机: ['无人机', '飞行器', 'UAV', 'drone'],
  培训: ['培训', '教学', '指导'],
  合作: ['合作', '商务', '伙伴'],
  预约: ['预约', '预定', '预订'],
  报告: ['报告', '检测报告', '巡检报告'],
};

export function expandQueryText(query: string): string {
  const extras: string[] = [];
  for (const [key, alts] of Object.entries(SYN)) {
    if (query.includes(key)) {
      for (const a of alts) {
        if (!query.includes(a) && a !== key) extras.push(a);
      }
    }
  }
  return extras.length ? `${query} ${extras.join(' ')}` : query;
}

export const SYNONYM_MAP = SYN;
