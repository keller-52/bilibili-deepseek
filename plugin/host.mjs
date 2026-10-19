import { createApp } from '../src/server.mjs';
import { registerBiliTools } from './tools.mjs';

export const name = 'bili-duty';
export const inject = ['webServer', 'tools'];

/**
 * Mount the control panel behind the DSH web server at `/bili-duty/` and
 * register the read-only B站 tools for the agent.
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

  const port = Number(process.env.BILI_DUTY_CDP_PORT || 9222);
  try {
    const names = registerBiliTools(ctx, { port });
    ctx.logger?.info?.(`[bili-duty] 只读工具已注册：${names.join(', ')}`);
  } catch (error) {
    // The control panel must stay usable even if a future DSH tool schema
    // changes; the failure is logged instead of taking the whole plugin down.
    // BILI_DUTY_STRICT_TOOLS=1 turns registration failures into boot failures
    // for plugin development and compatibility checks.
    if (process.env.BILI_DUTY_STRICT_TOOLS === '1') throw error;
    ctx.logger?.warn?.(`[bili-duty] 只读工具注册失败：${error.message}`);
  }

  ctx.logger?.info?.('[bili-duty] 控制台已挂载：/bili-duty/');
}
