/** 展区同义词：扩展检索查询（评测驱动迭代） */
const SYN: Record<string, string[]> = {
  光伏: ['光伏', '太阳能', '组件', '电站', '清洗', '积灰', '清洁'],
  清洁: ['清洁', '清洗', '清扫', '除尘', '积灰', '鸟粪'],
  组件: ['组件', '光伏板', '太阳能板', '电池板'],
  风场: ['风场', '风电', '风机', '风力', '风电场'],
  叶片: ['叶片', '叶轮', '风叶', '桨叶'],
  检测: ['检测', '巡检', '检查', '缺陷', '裂纹', '雷击'],
  巡检: ['巡检', '检测', '复检', '检查'],
  无人机: ['无人机', '飞行器', 'UAV', 'drone'],
  培训: ['培训', '教学', '指导', '操作培训'],
  合作: ['合作', '商务', '伙伴', '运维伙伴'],
  预约: ['预约', '预定', '预订', '参观'],
  报告: ['报告', '检测报告', '巡检报告', '作业报告'],
  售后: ['售后', '技术支持', '备件', '服务'],
  安全: ['安全', '须知', '参观须知', '注意事项'],
  闪光灯: ['闪光灯', '拍照', '摄影', '拍摄'],
  裂纹: ['裂纹', '缺陷', '损伤', '涂层'],
  清洗: ['清洗', '清洁', '除尘'],
  塔筒: ['塔筒', '塔架', '风机塔'],
  作业: ['作业', '流程', '模板', '报告'],
  模板: ['模板', '报告', '作业'],
  触摸: ['触摸', '展品', '飞行器', '安全'],
  摸: ['摸', '触摸', '展品', '安全'],
  展品: ['展品', '触摸', '安全'],
};

/**
 * 拆出「原查询」与「扩展词」两部分，供检索器给扩展词降权。
 * 扩展词是**提示**不是要求：它与原查询词同权时，会把「碰巧含这些泛词的无关文档」
 * 抬到正确文档之上（实测：闪光灯→拍摄 把风机拍摄方案抬到展厅须知之上）。
 */
export function expandQueryParts(query: string): { original: string; extras: string[] } {
  const extras: string[] = [];
  for (const [key, alts] of Object.entries(SYN)) {
    if (query.includes(key)) {
      for (const a of alts) {
        if (!query.includes(a) && a !== key) extras.push(a);
      }
    }
  }
  return { original: query, extras };
}

export function expandQueryText(query: string): string {
  const { original, extras } = expandQueryParts(query);
  return extras.length ? `${original} ${extras.join(' ')}` : original;
}
