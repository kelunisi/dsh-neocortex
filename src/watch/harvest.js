/**
 * 只读抓取层：把 MCP 工具包装成普通方法。
 * 这里没有任何写操作；写工具不在 READ_ONLY_TOOLS 白名单里。
 */

export class Harvest {
  constructor(client) {
    this.client = client;
  }

  stop() {
    this.client?.stop?.();
  }

  checkCredential() {
    return this.client.call('bili_check_credential', {});
  }

  search(keyword, { num = 10, order = 'totalrank', page = 1 } = {}) {
    return this.client.call('bili_search', { keyword, num, order, page });
  }

  videoInfo(bvid) {
    return this.client.call('bili_video_info', { bvid });
  }

  subtitle(bvid) {
    return this.client.call('bili_subtitle', { bvid });
  }

  comments(bvid, { num = 30 } = {}) {
    return this.client.call('bili_comments', { bvid, num });
  }

  danmaku(bvid, { num = 100 } = {}) {
    return this.client.call('bili_danmaku', { bvid, num });
  }

  userInfo(uid) {
    return this.client.call('bili_user_info', { uid });
  }

  userVideos(uid, { pn = 1, ps = 30, order = 'pubdate', keyword = '' } = {}) {
    return this.client.call('bili_user_videos', { uid, pn, ps, order, keyword });
  }

  recommend({ ps = 20 } = {}) {
    return this.client.call('bili_recommend', { ps });
  }

  hotVideos({ pn = 1, ps = 20 } = {}) {
    return this.client.call('bili_hot_videos', { pn, ps });
  }

  weeklyHot({ week = 0 } = {}) {
    return this.client.call('bili_weekly_hot', { week });
  }

  rank({ category = 'all', day = 3 } = {}) {
    return this.client.call('bili_rank', { category, day });
  }

  transcribeStart(bvid) {
    return this.client.call('bili_transcribe_start', { bvid });
  }

  transcribeResult(jobId) {
    return this.client.call('bili_transcribe_result', { job_id: jobId });
  }
}
