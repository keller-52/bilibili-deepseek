import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { apply } from '../plugin/host.mjs';

test('host half registers the /bili-duty prefix on webServer', async () => {
  let registered = null;
  const ctx = {
    webServer: {
      register(options) {
        registered = options;
        return () => {};
      },
    },
    effect(fn) {
      return fn();
    },
    logger: { info() {} },
  };

  apply(ctx);
  assert.equal(registered.kind, 'prefix');
  assert.equal(registered.path, '/bili-duty');
  assert.equal(typeof registered.handler, 'function');

  const server = http.createServer(registered.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/bili-duty/api/health`);
    assert.equal((await health.json()).ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('client half registers a settings section and renders an iframe', () => {
  let definition = null;
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  };

  const source = readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { window, URLSearchParams });

  assert.equal(definition.id, 'bili-duty');
  assert.equal(typeof definition.factory, 'function');

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
  };
  const plugin = definition.factory((name) => {
    assert.equal(name, 'react');
    return React;
  });
  assert.equal(plugin.inject.length, 1);
  assert.equal(plugin.inject[0], 'slots');

  let section = null;
  const slots = {
    inject(name, callback) {
      assert.equal(name, 'settings.section');
      callback();
    },
    register(value, render) {
      section = { ...value, render };
    },
  };
  plugin.apply({ get: (name) => (name === 'slots' ? slots : undefined) });
  assert.equal(section.id, 'bili-duty');
  assert.equal(section.label, 'B 站');

  const panel = section.render();
  assert.equal(panel.type, 'div');
  const iframe = panel.children.find((child) => child && child.type === 'iframe');
  assert.equal(iframe.props.src, '/bili-duty/?embed=1');
});
