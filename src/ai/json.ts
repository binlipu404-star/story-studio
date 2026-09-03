/** 从模型返回文本中健壮地提取 JSON（容忍 markdown 代码块与前后杂音） */
export function extractJson<T = unknown>(text: string): T {
  if (!text) throw new Error("空响应，无法解析 JSON");
  const trimmed = text.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    /* 继续尝试截取 */
  }

  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const a = candidate.indexOf(open);
    const b = candidate.lastIndexOf(close);
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(candidate.slice(a, b + 1)) as T;
      } catch {
        /* 继续 */
      }
    }
  }
  throw new Error("无法从模型响应中解析出有效 JSON");
}
