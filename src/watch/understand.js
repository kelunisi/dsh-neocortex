/**
 * 模型判读：一条视频一次问答，只允许输出 JSON。
 * 这里不写会话、不落智脑；只把结果交给 report / 队列。
 */

export const MAX_SUBTITLE_CHARS = 8000;

export function resolveModelRoute(ctx, config = {}) {
  if (config.provider && config.model) {
    return {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      source: 'config',
    };
  }
  const defaults = ctx?.get?.('agentDefaultModel');
  const selection = defaults?.currentSelection?.();
  if (selection?.provider && selection?.model) {
    // 部署默认里的 reasoningEffort 是给主对话用的；喂养判读是轻量辅助请求，
    // 不继承它，让适配器用模型自己的默认值。
    return { provider: selection.provider, model: selection.model, source: 'deployment-default' };
  }
  throw new Error('没有可用的模型路由：请在喂养设置里填 provider/model，或配置部署默认模型。');
}

export function normalizeSubtitle(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return result.map((item) => (typeof item === 'string' ? item : item?.text ?? item?.content ?? '')).filter(Boolean).join('\n');
  for (const key of ['subtitle', 'text', 'body', 'content', 'plain']) {
    if (typeof result[key] === 'string' && result[key].trim()) return result[key];
  }
  if (Array.isArray(result.subtitles)) return normalizeSubtitle(result.subtitles);
  if (Array.isArray(result.body)) return normalizeSubtitle(result.body);
  return '';
}

export function buildUnderstandingPrompt({ criteria, video, subtitle }) {
  const persona = criteria.persona || '一个需要持续吸收可落地知识的人';
  const directions = (criteria.directions || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  const system = [
    '你是智脑"喂养"模块的判读员。任务：判断一条 B 站视频是否包含值得入库的"知识点"。',
    '只输出一个 JSON 对象，不要 Markdown 代码块，不要额外解释。',
    'JSON 格式：{"worth":true|false,"confidence":0到1,"reason":"一句话判据","points":["要点1","要点2","要点3"],"topics":["主题1"]}',
    '要求：points 最多 3 条、每条不超过 60 字；worth=false 时 points 可为空；判据要具体，不要写"内容不错"这类空话。',
  ].join('\n');
  const text = subtitle && subtitle.trim()
    ? subtitle.trim().slice(0, MAX_SUBTITLE_CHARS)
    : '（没有字幕，只有标题与简介；请降低置信度，最高 0.5）';
  const user = [
    `【人设】${persona}`,
    directions ? `【关注方向】\n${directions}` : '',
    `【视频】${video.title}`,
    `【UP】${video.author || '未知'} ｜ 时长 ${video.duration || '未知'} ｜ 播放 ${video.play ?? 0}`,
    video.description ? `【简介】${video.description.slice(0, 800)}` : '',
    `【字幕/正文】\n${text}`,
    '【输出】只给 JSON。',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/** Pull the first JSON object out of a model reply (tolerates fences and prose). */
export function extractJudgement(text) {
  if (typeof text !== 'string') return null;
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

export function normalizeJudgement(value, video) {
  if (!value || typeof value !== 'object') {
    return { worth: null, confidence: 0, reason: '模型返回无法解析为 JSON', points: [], topics: [], raw: String(value ?? '').slice(0, 300) };
  }
  const points = Array.isArray(value.points)
    ? value.points.map((item) => String(item).trim()).filter(Boolean).slice(0, 3)
    : [];
  const topics = Array.isArray(value.topics)
    ? value.topics.map((item) => String(item).trim()).filter(Boolean).slice(0, 4)
    : [];
  const confidence = Number(value.confidence);
  return {
    worth: typeof value.worth === 'boolean' ? value.worth : null,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reason: String(value.reason || '').slice(0, 300),
    points,
    topics,
    bvid: video?.bvid,
  };
}

/**
 * One LLM call; returns the text. Honours the caller's abort signal.
 */
export async function callModel({ llm, route, system, user, signal, maxTokens = 900 }) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }];
  let text = '';
  let finished = false;
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    system,
    messages,
    maxTokens,
    signal,
  })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    if (chunk?.type === 'finish') {
      finished = true;
      const kind = chunk.reason?.kind;
      if (kind === 'error' || kind === 'aborted') {
        const failure = chunk.reason?.failure || {};
        const error = new Error(`模型调用失败：${failure.code || kind}${failure.message ? ` ${failure.message}` : ''}`);
        error.code = failure.code || kind;
        throw error;
      }
    }
  }
  if (!finished) {
    const error = new Error('模型流没有以 finish 结束');
    error.code = 'NO_FINISH';
    throw error;
  }
  return text;
}

export async function understandVideo({ ctx, llm, route, criteria, video, subtitle, signal }) {
  const { system, user } = buildUnderstandingPrompt({ criteria, video, subtitle });
  const text = await callModel({ llm, route, system, user, signal });
  const judgement = normalizeJudgement(extractJudgement(text), video);
  judgement.subtitleMissing = !subtitle || !subtitle.trim();
  judgement.replyPreview = text.slice(0, 500);
  return judgement;
}
