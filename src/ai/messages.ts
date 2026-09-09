// ============================================================
// 消息序规范化（v6.1）：system 消息必须置顶
//
// DeepSeek 官方端点严格校验「System message must be at the beginning」，
// 中间夹一条 system 就 400（sub2api 类网关宽松，掩盖了这个问题）。
// 而多处组装天然产生中后部 system：RP 楼层里的系统条（flow/rp）、
// 滚动摘要条（flow/rp v2）、访谈选材块（InterviewPage）、chatJSON 修复重试。
// 与其逐处叮嘱调用方，不如在 fetch 薄壳统一收口——所有出网消息过这一道。
// ============================================================

/**
 * 把散落/后置的 system 消息前移，并入首位 system 连段（保持它们的相对顺序）；
 * 非 system 消息的相对顺序与全部附加字段原样保留。
 * 合规输入（system 已全在 leading 连段）返回**原数组引用**——零拷贝零行为变化。
 */
export function hoistSystemMessages<T extends { role: string }>(msgs: T[]): T[] {
  let firstNonSystem = 0;
  while (firstNonSystem < msgs.length && msgs[firstNonSystem].role === "system") firstNonSystem++;
  // leading 连段之外是否还有 system？没有 → 已合规，原样返回
  if (!msgs.slice(firstNonSystem).some((m) => m.role === "system")) return msgs;
  const head = msgs.slice(0, firstNonSystem);
  const rest = msgs.slice(firstNonSystem);
  const lateSystems = rest.filter((m) => m.role === "system");
  const others = rest.filter((m) => m.role !== "system");
  return [...head, ...lateSystems, ...others];
}
