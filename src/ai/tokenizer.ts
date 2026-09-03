const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g;

/** 粗略 token 估算：CJK 按 1 token/字，其余按 4 字符/token。偏保守，适合分章留余量。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) || []).length;
  const other = text.replace(CJK_RE, "").length;
  return cjk + Math.ceil(other / 4);
}
