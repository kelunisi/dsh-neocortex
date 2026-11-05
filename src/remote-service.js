import path from 'node:path';
import { createRequire } from 'node:module';

function loadProtocol() {
  const localRequire = createRequire(import.meta.url);
  try { return localRequire('@deepseek-ai/dsh-typert-protocol'); }
  catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND' || !process.resourcesPath) throw error;
    // Electron's Host can resolve built-in packages inside app.asar. A linked
    // external bundle must reuse that copy rather than loading another Cordis.
    const hostRequire = createRequire(path.join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'));
    return hostRequire('@deepseek-ai/dsh-typert-protocol');
  }
}

const { Remote, TypertRemoteService } = loadProtocol();

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

// The current Gateway supports SRC markers. Apply the standard decorator without
// requiring TypeScript syntax in this dependency-light, plain-JavaScript bundle.
function remoteMethod(Type, name) {
  const initializers = [];
  Remote(Type.prototype[name], {
    kind: 'method',
    name,
    private: false,
    static: false,
    addInitializer(initializer) { initializers.push(initializer); },
  });
  const markerReceiver = Object.create(Type.prototype);
  for (const initialize of initializers) initialize.call(markerReceiver);
}

export class NeocortexRemoteService extends TypertRemoteService {
  constructor(ctx, panel) {
    super(ctx, 'neocortex', { namespace: 'neocortex' });
    this.panel = panel;
  }

  state() {
    return json(this.panel.state());
  }

  previewReview(request) {
    return json(this.panel.review.preview(request.id));
  }

  confirmL1(request) {
    return json(this.panel.confirmL1(request, 'web-panel'));
  }

  undo(request) {
    return json(this.panel.undo(request, 'web-panel'));
  }

  acceptReview(request) {
    return json(this.panel.acceptReview(request, 'web-panel'));
  }

  rejectReview(request) {
    return json(this.panel.rejectReview(request, 'web-panel'));
  }

  manualReview() {
    return json(this.panel.manualReview({}, 'web-panel'));
  }

  retryReview() {
    return json(this.panel.retryReview({}, 'web-panel'));
  }

  updateSettings(request) {
    return json(this.panel.updateSettings(request));
  }

  initializeBrain(request) {
    return json(this.panel.initializeBrain(request, 'web-panel'));
  }
}

for (const name of ['state', 'previewReview', 'confirmL1', 'undo', 'acceptReview', 'rejectReview', 'manualReview', 'retryReview', 'updateSettings', 'initializeBrain']) {
  remoteMethod(NeocortexRemoteService, name);
}
