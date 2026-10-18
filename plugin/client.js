// bili-duty — DSH client half.
//
// Client bundles are self-registering scripts (not ESM):
//   window.__ModuleLoader__.load({ id: '<package name>', factory })
// The settings section is injected through the `slots` service.
window.__ModuleLoader__.load({
  id: 'bili-duty',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const PANEL_URL = '/bili-duty/?embed=1';

    function Panel() {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 12,
              color: 'var(--dsw-alias-label-tertiary, #8b98a5)',
            },
          },
          h('span', null, '扫码登录、私信白名单、参数、审计都在这里；数据只落在本机。'),
          h(
            'a',
            {
              href: PANEL_URL,
              target: '_blank',
              rel: 'noreferrer',
              style: { marginLeft: 'auto', color: 'var(--dsw-alias-link, #00aeec)' },
            },
            '在新标签页打开',
          ),
        ),
        h('iframe', {
          src: PANEL_URL,
          title: 'bili-duty 控制台',
          style: {
            width: '100%',
            height: 'calc(100vh - 220px)',
            minHeight: 560,
            border: '1px solid rgba(128, 128, 128, 0.18)',
            borderRadius: 12,
            background: '#0b0f14',
          },
        }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return;
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'bili-duty', order: 34, label: 'B 站' },
            Panel,
          ),
        );
      },
    };
  },
});
