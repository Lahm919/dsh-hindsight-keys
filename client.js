/**
 * dsh-hindsight-keys — browser half.
 *
 * Exposes the host-served control panel (GET /api/hindsight-keys/panel) in TWO
 * places so it is impossible to miss, both embedding the same iframe:
 *
 *   1. `settings.section`  -> its OWN entry in the Settings navigation list.
 *      This is the primary entry point ("Hindsight API Key 池").
 *   2. `settings.plugins.tab` -> a tab inside the Settings "内置插件" page,
 *      next to the read-only plugin inventory.
 *
 * Everything the panel needs is same-origin JSON under /api/hindsight-keys/*,
 * so no data plumbing is needed here and the plugin's secrets never reach this
 * bundle.
 *
 * Contract (mirrors @deepseek-ai/dsh-client-ui-settings-plugins):
 *   - `exports.inject` is a SERVICE-NAME ARRAY (cordis fiber hard deps). The
 *     runtime makes ctx.slots available before apply() is called.
 *   - apply(ctx) calls ctx.slots.inject(...) DIRECTLY. The client ctx has no
 *     `ctx.inject([...], cb)` method (Builtin exposes get/on/provide/effect
 *     only); wrapping in ctx.inject silently no-ops and nothing mounts.
 *   - A list slot registration needs an `id: string`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-hindsight-keys',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var PANEL_URL = '/api/hindsight-keys/panel'
    var SECTION_SLOT = 'settings.section'
    var TAB_SLOT = 'settings.plugins.tab'
    var ENTRY_ID = 'hindsight-keys'
    var TITLE = 'Hindsight API Key 池'

    var react = require('react')

    function HindsightKeysPanel() {
      var h = react.createElement
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%', minHeight: 620 } },
        h(
          'div',
          { style: { fontSize: 12, opacity: 0.75 } },
          '在多路 OpenCode Go key 之间轮转 Hindsight 的 LLM 调用。改动写入 hindsight env 后重启 daemon 生效。',
        ),
        h('iframe', {
          src: PANEL_URL,
          title: TITLE,
          style: {
            width: '100%',
            height: 700,
            border: '1px solid rgba(127,127,127,0.25)',
            borderRadius: 10,
            background: 'transparent',
          },
        }),
        h(
          'div',
          { style: { fontSize: 11, opacity: 0.6 } },
          '也可以直接打开 ',
          h('a', { href: PANEL_URL, target: '_blank', rel: 'noreferrer' }, PANEL_URL),
        ),
      )
    }

    /** Services required by this Client half (cordis fiber inject). */
    var inject = ['slots']

    function apply(ctx) {
      // 1) Own Settings navigation entry.
      ctx.slots.inject(SECTION_SLOT, function () {
        return ctx.slots.register(
          {
            name: SECTION_SLOT,
            id: ENTRY_ID,
            order: 40,
            label: function () { return TITLE },
          },
          HindsightKeysPanel,
        )
      })

      // 2) Tab inside the "内置插件" page.
      ctx.slots.inject(TAB_SLOT, function () {
        return ctx.slots.register(
          {
            name: TAB_SLOT,
            id: ENTRY_ID,
            order: 40,
            label: function () { return TITLE },
          },
          HindsightKeysPanel,
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
