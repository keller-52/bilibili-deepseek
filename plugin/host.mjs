import { createApp } from '../src/server.mjs';

export const name = 'bili-duty';
export const inject = ['webServer'];

/**
 * Mount the control panel behind the DSH web server at `/bili-duty/`.
 * The standalone server (`npm start`) keeps serving the same app at `/`.
 */
export function apply(ctx) {
  const app = createApp({ basePath: '/bili-duty', allowFrame: true });

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/bili-duty',
      handler: app,
    }),
    'bili-duty: control panel routes',
  );

  ctx.logger?.info?.('[bili-duty] 控制台已挂载：/bili-duty/');
}
