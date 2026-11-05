window.__ModuleLoader__.load({
  id: 'dsh-neocortex',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const zh = {
      tab: '智脑', title: '智脑记忆', subtitle: 'Markdown 为权威，账本用于召回解释与生命周期。',
      refresh: '刷新', overview: '记忆总览', review: '周回顾', settings: '参数设置',
      memories: '近况记忆', pending: 'L1 待确认', l2: 'L2 只读审计', queue: '待处理队列', undo: '可撤销操作',
      emptyMemories: '暂无近况记忆。新的有效条目会在写入后出现在这里。',
      emptyPending: '暂无待确认的 L1 推断。', emptyL2: '本周尚无 L2 审计记录。', emptyQueue: '待处理队列为空。',
      emptyReviews: '本周暂无待处理候选项。', emptyUndo: '暂无可撤销的取代操作。',
      quota: '今日写入', exemptions: '明确豁免', queueCount: '队列', reviewCount: '待审候选',
      score: '分数', recency: '新近度', uses: '完成轮次使用', age: '天数', source: '来源',
      confirm: '确认到正式规则', confirmed: '已确认', reject: '拒绝', accept: '接受', preview: '预览', undoAction: '撤销',
      runReview: '立即执行周回顾', retryReview: '重试失败回顾', runStatus: '本周运行状态', notRun: '尚未运行',
      save: '保存参数', saved: '参数已保存，历史使用计数未修改。', loading: '正在读取真实脑库…',
      readonly: '只读：此处不提供 L2 写入或确认操作。', noDemo: '当前列表来自实际脑库与本地账本；空列表不会填充演示内容。',
      setupTitle: '初始化智脑', setupNote: '首次使用需要先建立或接管一个智脑目录；动作只影响所选目录，不会覆盖已有文件。',
      setupCurrent: '当前脑库', setupMissing: '目录不存在', setupEmpty: '空目录', setupUnrecognized: '非空但缺少智脑特征', setupNotDir: '路径不是目录',
      setupNew: '新建智脑', setupTakeover: '使用已有智脑', setupUpgrade: '升级补齐骨架', setupDirPlaceholder: '目录路径，留空用默认',
      setupStart: '执行', setupDoneNew: '新建完成', setupDoneTakeover: '接管完成', setupDoneUpgrade: '补齐完成', setupRestart: '重启插件后生效',
    };
    const en = {
      tab: 'Neocortex', title: 'Neocortex Memory', subtitle: 'Markdown is authoritative; the ledger explains recall and lifecycle.',
      refresh: 'Refresh', overview: 'Memories', review: 'Weekly review', settings: 'Settings',
      memories: 'Recent memories', pending: 'L1 pending confirmation', l2: 'L2 read-only audit', queue: 'Pending queue', undo: 'Undoable operations',
      emptyMemories: 'No recent memories yet.', emptyPending: 'No inferred L1 items await confirmation.', emptyL2: 'No L2 audit records this week.', emptyQueue: 'The pending queue is empty.',
      emptyReviews: 'No pending review candidates this week.', emptyUndo: 'No replacement can be undone.',
      quota: 'Writes today', exemptions: 'Explicit exemptions', queueCount: 'Queue', reviewCount: 'Review candidates',
      score: 'Score', recency: 'Recency', uses: 'Completed-turn uses', age: 'Age in days', source: 'Source',
      confirm: 'Confirm as formal rule', confirmed: 'Confirmed', reject: 'Reject', accept: 'Accept', preview: 'Preview', undoAction: 'Undo',
      runReview: 'Run weekly review', retryReview: 'Retry failed review', runStatus: 'This week', notRun: 'Not run yet',
      save: 'Save settings', saved: 'Settings saved; historical usage counts were not changed.', loading: 'Reading the actual brain…',
      readonly: 'Read-only: L2 has no write or confirmation action here.', noDemo: 'Lists come from the real brain and local ledger; empty states never use demo data.',
      setupTitle: 'Brain setup', setupNote: 'First use requires creating or taking over a brain directory; actions only touch the chosen directory and never overwrite existing files.',
      setupCurrent: 'Current brain', setupMissing: 'Directory missing', setupEmpty: 'Empty directory', setupUnrecognized: 'Non-empty but no brain markers', setupNotDir: 'Path is not a directory',
      setupNew: 'Create new brain', setupTakeover: 'Use existing brain', setupUpgrade: 'Upgrade skeleton', setupDirPlaceholder: 'Directory path; blank uses default',
      setupStart: 'Run', setupDoneNew: 'Created', setupDoneTakeover: 'Taken over', setupDoneUpgrade: 'Upgraded', setupRestart: 'Restart the plugin to take effect',
    };

    const jsonCodec = {
      mode: 'strict',
      typeSymbol: 'dsh-neocortex#JsonValue',
      create: () => ({ parse: (value) => value }),
      jsonSchema: {},
    };
    const requestParameter = { name: 'request', wire: 'request', source: 'json', codec: jsonCodec };
    const methods = {
      state: false, previewReview: true, confirmL1: true, undo: true,
      acceptReview: true, rejectReview: true, manualReview: false, retryReview: false,
      updateSettings: true, initializeBrain: true,
    };
    const TYPERT_REMOTE = {
      package: 'dsh-neocortex',
      descriptors: Object.entries(methods).map(([method, hasRequest]) => ({
        id: `dsh-neocortex#neocortex/${method}`,
        service: 'neocortex', namespace: 'neocortex', method,
        invocation: { kind: 'direct' },
        parameters: hasRequest ? [requestParameter] : [],
        result: jsonCodec,
      })),
    };

    const css = `
      .nc-panel{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;max-width:1100px;padding:4px 0 32px}
      .nc-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}
      .nc-title{font-size:22px;font-weight:650;margin:0 0 4px}.nc-subtitle{color:var(--dsw-alias-label-secondary);margin:0}
      .nc-nav{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:16px}
      .nc-nav button{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:9px 13px;cursor:pointer}
      .nc-nav button[data-active=true]{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
      .nc-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:18px}
      .nc-stat,.nc-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px}
      .nc-stat strong{display:block;font-size:22px}.nc-stat span{color:var(--dsw-alias-label-secondary);font-size:12px}
      .nc-section{margin:20px 0}.nc-section h3{font-size:15px;margin:0 0 9px}.nc-note,.nc-empty{color:var(--dsw-alias-label-secondary);padding:10px 0}
      .nc-card{margin:8px 0}.nc-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.nc-card-text{white-space:pre-wrap;overflow-wrap:anywhere}
      .nc-meta{display:flex;flex-wrap:wrap;gap:10px;color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:8px}
      .nc-path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.nc-hash{font-size:11px;opacity:.8}
      .nc-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.nc-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:6px 11px;cursor:pointer}
      .nc-btn[data-primary=true]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
      .nc-btn:disabled{opacity:.5;cursor:not-allowed}.nc-error{color:var(--dsw-alias-state-error-primary);padding:10px 0;white-space:pre-wrap}.nc-success{color:var(--dsw-alias-state-success-primary);padding:10px 0}
      .nc-setting{display:grid;grid-template-columns:minmax(190px,1fr) 100px;gap:12px;align-items:center;margin:12px 0}.nc-setting small{display:block;color:var(--dsw-alias-label-secondary)}
      .nc-setting-control{display:flex;align-items:center;gap:9px}.nc-range{width:100%;accent-color:var(--dsw-alias-brand-primary)}.nc-setting-output{min-width:36px;text-align:right;font-variant-numeric:tabular-nums}
      .nc-input{width:100%;box-sizing:border-box;margin:10px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:7px 10px;font:inherit}
      .nc-preview{white-space:pre-wrap;max-height:300px;overflow:auto;background:var(--dsw-alias-bg-base);border-radius:7px;padding:10px;font-size:12px}
      @media(max-width:720px){.nc-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.nc-header{display:block}.nc-header .nc-btn{margin-top:10px}}
    `;

    function Button(props) {
      return h('button', { className: 'nc-btn', 'data-primary': props.primary || undefined, disabled: props.disabled, onClick: props.onClick, type: 'button' }, props.children);
    }
    function Empty({ children }) { return h('div', { className: 'nc-empty' }, children); }
    function Section({ title, children, note }) {
      return h('section', { className: 'nc-section' }, h('h3', null, title), note ? h('div', { className: 'nc-note' }, note) : null, children);
    }

    function createPanel(call, t) {
      return function NeocortexPanel() {
        const [state, setState] = useState(null);
        const [view, setView] = useState('overview');
        const [error, setError] = useState('');
        const [message, setMessage] = useState('');
        const [busy, setBusy] = useState(false);
        const [preview, setPreview] = useState(null);
        const [draft, setDraft] = useState({});
        const [setupMode, setSetupMode] = useState('new');
        const [setupDir, setSetupDir] = useState('');

        const load = async () => {
          try {
            const value = await call('state');
            setState(value);
            setDraft(Object.fromEntries(Object.keys(value.settingRanges).map((key) => [key, value.settings[key]])));
            setError('');
          }
          catch (cause) { setError(cause?.message || String(cause)); }
        };
        useEffect(() => { load(); }, []);
        const act = async (method, request) => {
          setBusy(true); setMessage(''); setError('');
          try { const result = await call(method, request); await load(); return result; }
          catch (cause) { setError(cause?.message || String(cause)); throw cause; }
          finally { setBusy(false); }
        };
        const safely = (operation) => () => { Promise.resolve(operation()).catch(() => {}); };
        const runReview = safely(async () => { await act('manualReview'); setMessage(t('review') + ' ✓'); });
        const retryReview = safely(async () => { await act('retryReview'); setMessage(t('review') + ' ✓'); });

        if (!state) return h('div', { className: 'nc-panel' }, h('style', null, css), error ? h('div', { className: 'nc-error' }, error) : t('loading'));
        const pendingReviews = state.reviews.filter((item) => item.status === 'pending');
        const reviewRun = state.reviewRun;
        const cards = [
          [t('quota'), `${state.quota.total} / ${state.quota.limit}`],
          [t('exemptions'), `${state.quota.exemptions} / ${state.quota.exemptionLimit}`],
          [t('queueCount'), `${state.queue.items.length} / ${state.queue.limit}`],
          [t('reviewCount'), String(pendingReviews.length)],
        ];

        const setup = state.setup;
        const setupKey = setup && setup.status !== 'initialized' ? `setup${setup.status[0].toUpperCase()}${setup.status.slice(1)}` : '';
        const setupCard = setup && setup.status !== 'initialized' ? h(Section, { title: t('setupTitle'), note: t('setupNote') },
          h('div', { className: 'nc-card' },
            h('div', { className: 'nc-meta nc-path' }, `${t('setupCurrent')}: ${setup.brainRoot} — ${t(setupKey) || setup.status}`),
            h('div', { className: 'nc-actions' },
              h(Button, { primary: setupMode === 'new', disabled: busy, onClick: () => setSetupMode('new') }, t('setupNew')),
              h(Button, { primary: setupMode === 'takeover', disabled: busy, onClick: () => setSetupMode('takeover') }, t('setupTakeover')),
              h(Button, { primary: setupMode === 'upgrade', disabled: busy, onClick: () => setSetupMode('upgrade') }, t('setupUpgrade'))),
            h('input', { className: 'nc-input', 'aria-label': t('setupDirPlaceholder'), placeholder: `${t('setupDirPlaceholder')} (${setup.defaultDir})`, value: setupDir, onChange: (event) => setSetupDir(event.target.value) }),
            h('div', { className: 'nc-actions' },
              h(Button, { primary: true, disabled: busy, onClick: safely(async () => {
                const result = await act('initializeBrain', { mode: setupMode, targetDir: setupDir.trim() || setup.defaultDir });
                if (['initialized', 'takeover-ready', 'upgraded', 'nothing-to-do'].includes(result.status)) {
                  const doneKey = result.status === 'initialized' ? 'setupDoneNew' : result.status === 'takeover-ready' ? 'setupDoneTakeover' : 'setupDoneUpgrade';
                  setMessage(`${t(doneKey)} · ${t('setupRestart')}`);
                }
              }) }, t('setupStart'))))) : null;

        const overview = h(React.Fragment, null,
          setupCard,
          h('div', { className: 'nc-stats' }, cards.map(([label, value]) => h('div', { className: 'nc-stat', key: label }, h('strong', null, value), h('span', null, label)))),
          h(Section, { title: t('memories') }, state.memories.length === 0 ? h(Empty, null, t('emptyMemories')) : state.memories.slice(0, 30).map((item) =>
            h('article', { className: 'nc-card', key: item.id },
              h('div', { className: 'nc-card-text' }, item.text),
              h('div', { className: 'nc-meta' },
                h('span', null, `${item.scene || '通用'} · ${item.status}`),
                h('span', null, `${t('score')}: ${Number(item.explanation.score).toFixed(3)}`),
                h('span', null, `${t('recency')}: ${Number(item.explanation.recency).toFixed(3)}`),
                h('span', null, `${t('uses')}: ${item.explanation.useCount}`),
                h('span', null, `${t('age')}: ${Number(item.explanation.ageDays || 0).toFixed(1)}`)),
              h('div', { className: 'nc-meta nc-path' }, item.path)))),
          h(Section, { title: t('pending') }, state.l1Pending.length === 0 ? h(Empty, null, t('emptyPending')) : state.l1Pending.map((item) =>
            h('article', { className: 'nc-card', key: item.id },
              h('div', { className: 'nc-card-text' }, item.text), h('div', { className: 'nc-meta nc-path' }, item.sourcePath),
              h('div', { className: 'nc-actions' }, h(Button, { primary: true, disabled: busy, onClick: safely(async () => { await act('confirmL1', { id: item.id, expectedHash: item.sha256 }); setMessage(t('confirmed')); }) }, t('confirm')))))),
          h(Section, { title: t('l2'), note: t('readonly') }, state.l2Audit.length === 0 ? h(Empty, null, t('emptyL2')) : state.l2Audit.map((item) =>
            h('article', { className: 'nc-card', key: item.path }, h('div', null, item.title), h('div', { className: 'nc-meta nc-path' }, item.path), h('div', { className: 'nc-meta nc-hash' }, `SHA-256 ${item.sha256}`)))),
          h(Section, { title: t('queue') }, state.queue.items.length === 0 ? h(Empty, null, t('emptyQueue')) : state.queue.items.map((item) =>
            h('article', { className: 'nc-card', key: item.id }, h('div', null, item.text), h('div', { className: 'nc-meta' }, `${item.reason} · ${item.queuedAt}`)))),
          h(Section, { title: t('undo') }, state.tombstones.length === 0 ? h(Empty, null, t('emptyUndo')) : state.tombstones.map((item) =>
            h('article', { className: 'nc-card', key: item.id }, h('div', { className: 'nc-path' }, item.targetPath),
              h('div', { className: 'nc-actions' }, h(Button, { disabled: busy, onClick: safely(async () => { await act('undo', { id: item.id }); setMessage(t('undoAction') + ' ✓'); }) }, t('undoAction')))))),
        );

        const reviews = h(React.Fragment, null,
          h(Section, { title: t('runStatus') },
            h('div', { className: 'nc-card' }, h('div', null, reviewRun ? `${reviewRun.status} · ${reviewRun.trigger}` : t('notRun')),
              h('div', { className: 'nc-actions' },
                h(Button, { primary: true, disabled: busy, onClick: runReview }, t('runReview')),
                reviewRun?.status === 'failed' ? h(Button, { disabled: busy, onClick: retryReview }, t('retryReview')) : null))),
          h(Section, { title: t('review') }, state.reviews.length === 0 ? h(Empty, null, t('emptyReviews')) : state.reviews.map((item) =>
            h('article', { className: 'nc-card', key: item.id },
              h('div', { className: 'nc-card-head' }, h('div', { className: 'nc-card-text' }, item.text), h('span', null, item.status)),
              h('div', { className: 'nc-meta' }, `${item.type} · ${item.createdAt}`),
              item.status === 'pending' ? h('div', { className: 'nc-actions' },
                h(Button, { disabled: busy, onClick: safely(async () => { const result = await call('previewReview', { id: item.id }); setPreview(result); }) }, t('preview')),
                h(Button, { primary: true, disabled: busy, onClick: safely(async () => { await act('acceptReview', { id: item.id }); setMessage(t('accept') + ' ✓'); }) }, t('accept')),
                h(Button, { disabled: busy, onClick: safely(async () => { await act('rejectReview', { id: item.id }); setMessage(t('reject') + ' ✓'); }) }, t('reject'))) : null))),
          preview ? h(Section, { title: t('preview') }, h('pre', { className: 'nc-preview' }, JSON.stringify(preview, null, 2))) : null,
        );

        const labels = {
          halfLifeDays: ['回忆半衰期（天）', 'Recall half-life'],
          firstInjectionMaxItems: ['首次注入最多条目', 'First-injection item budget'],
          firstInjectionMaxChars: ['首次注入字符预算', 'First-injection character budget'],
          generalSleepDays: ['通用沉睡阈值（天）', 'General sleep threshold'],
          revivalWindowDays: ['复活窗口（天）', 'Revival window'],
          revivalThreshold: ['复活所需命中次数', 'Revival hit threshold'],
        };
        const settings = h(Section, { title: t('settings') }, Object.keys(labels).map((key) =>
          h('label', { className: 'nc-setting', key }, h('span', null, t('tab') === '智脑' ? labels[key][0] : labels[key][1], h('small', null, `${state.settingRanges[key][0]}–${state.settingRanges[key][1]}`)),
            h('div', { className: 'nc-setting-control' },
              h('input', { className: 'nc-range', 'aria-label': t('tab') === '智脑' ? labels[key][0] : labels[key][1], type: 'range', min: state.settingRanges[key][0], max: state.settingRanges[key][1], step: key === 'firstInjectionMaxChars' ? 10 : 1, value: draft[key] ?? state.settingRanges[key][0], onChange: (event) => setDraft({ ...draft, [key]: Number(event.target.value) }) }),
              h('output', { className: 'nc-setting-output' }, String(draft[key] ?? ''))))),
          h(Button, { primary: true, disabled: busy, onClick: safely(async () => { await act('updateSettings', draft); setMessage(t('saved')); }) }, t('save')));

        return h('div', { className: 'nc-panel', 'data-neocortex-panel': 'true' },
          h('style', null, css),
          h('header', { className: 'nc-header' }, h('div', null, h('h2', { className: 'nc-title' }, t('title')), h('p', { className: 'nc-subtitle' }, t('subtitle'))), h(Button, { disabled: busy, onClick: safely(load) }, t('refresh'))),
          h('div', { className: 'nc-note' }, t('noDemo')),
          h('nav', { className: 'nc-nav', 'aria-label': t('tab') }, [['overview', t('overview')], ['review', t('review')], ['settings', t('settings')]].map(([id, label]) => h('button', { key: id, type: 'button', 'data-active': view === id, onClick: () => setView(id) }, label))),
          error ? h('div', { className: 'nc-error', role: 'alert' }, error) : null,
          message ? h('div', { className: 'nc-success', role: 'status' }, message) : null,
          view === 'overview' ? overview : view === 'review' ? reviews : settings);
      };
    }

    return {
      inject: ['slots', 'locale', 'remote'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('neocortex', { zh, en }), 'neocortex: dictionaries');
        const mounted = ctx.remote.$mount(TYPERT_REMOTE);
        ctx.effect(() => mounted, 'neocortex: remote');
        const t = ctx.locale.bind('neocortex');
        const call = async (method, request) => {
          await mounted;
          const service = ctx.get('remote.neocortex');
          if (!service) throw new Error('Neocortex Remote service is unavailable');
          const result = await service[method](...(request === undefined ? [] : [request]));
          if (!result.ok) throw result.error;
          return result.value;
        };
        const Panel = createPanel(call, t);
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab', id: 'neocortex', order: 30,
          label: () => t('tab'), locale: 'neocortex',
        }, Panel));
      },
    };
  },
});
