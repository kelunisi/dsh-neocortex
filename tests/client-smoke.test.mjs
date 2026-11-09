import test from 'node:test';
import assert from 'node:assert/strict';

test('CLIENT-01 plugin entry registers the settings tab and the shell overlay', async () => {
  let loaded = null;
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
  await import(`../client.js?smoke=${Date.now()}`);
  globalThis.window = previousWindow;
  assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load');
  assert.equal(typeof loaded.factory, 'function');

  const React = {
    createElement: (...args) => ({ args }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    Fragment: 'Fragment',
  };
  const mod = loaded.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require: ${name}`);
  });
  assert.deepEqual(mod.inject, ['slots', 'locale', 'remote']);

  const injected = [];
  const ctx = {
    effect: (factory) => { try { return factory(); } catch { return undefined; } },
    locale: { register: () => ({}), bind: () => (key) => key },
    remote: { $mount: () => Promise.resolve() },
    get: () => undefined,
    slots: {
      inject: (name, factory) => { injected.push(name); try { return factory(); } catch { return undefined; } },
      register: (definition) => ({ definition }),
    },
  };
  mod.apply(ctx);
  assert.deepEqual(injected, ['settings.plugins.tab', 'shell.overlay']);
});
