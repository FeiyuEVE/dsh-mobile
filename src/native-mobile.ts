/** Mobile feature and compatibility rules applied to DSH React surfaces. */
export const NATIVE_MOBILE_STYLES = `
@media (max-width:720px) {
  html.dsh-native-mobile-active,html.dsh-native-mobile-active body { width:100%; height:100%; overflow:hidden; }
  html.dsh-native-mobile-active { --dsh-mobile-motion-duration:200ms; --dsh-mobile-motion-ease:cubic-bezier(.22,1,.36,1); }
  html.dsh-native-mobile-active :is(a,button,[role="button"],[role="tab"],[tabindex]) { -webkit-tap-highlight-color:transparent; }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [role="treeitem"] { -webkit-tap-highlight-color:transparent; touch-action:manipulation; }
  html.dsh-native-mobile-active[data-dsh-mobile-input="touch"] :is(a,button,[role="button"],[role="tab"],[tabindex]):focus { outline:none !important; }
  html.dsh-native-mobile-active [role="tooltip"] { display:none !important; }
  /* Touch has no persistent hover affordance: keep workspace rows neutral after a tap. */
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] { --dsw-alias-interactive-bg-hover:transparent !important; }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [role="treeitem"]:is(:hover,:active,:focus,[aria-selected="true"]),
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_sessionRow"][class*="_selected"],
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_searchResultRow"][class*="_selected"] { background:transparent !important; outline:0 !important; box-shadow:none !important; }
  /* Sidebar row menus are hover-only on desktop. Touch has no hover, so keep
     the ellipsis action visible and give it a reliable hit target. */
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_rowActions"] { display:inline-flex !important; align-items:center !important; gap:8px !important; }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_sessionRow"] [class*="_time"] { display:none !important; }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_rowActions"] button { box-sizing:border-box !important; width:32px !important; min-width:32px !important; height:32px !important; min-height:32px !important; }
  [data-dsh-mobile-frame] { grid-template-columns:0 minmax(0,1fr) 0 !important; width:100% !important; height:100dvh !important; overflow:hidden !important; }
  [data-dsh-mobile-center] { grid-column:2 !important; width:100vw !important; min-width:0 !important; }
  [data-dsh-mobile-center] > * { min-width:0 !important; }
  [data-dsh-mobile-header] { box-sizing:border-box !important; width:calc(100% - 16px) !important; margin:0 8px !important; min-width:0; padding-top:max(4px,env(safe-area-inset-top)) !important; padding-right:8px !important; padding-left:42px !important; }
  [data-dsh-mobile-header] [class*="_titleRow"] { box-sizing:border-box !important; display:flex !important; align-items:center !important; min-width:0; min-height:32px !important; height:32px !important; gap:6px !important; padding:0 6px !important; }
  [data-dsh-mobile-header] [class*="_titleCluster"] { min-width:0; }
  [data-dsh-mobile-header] [class*="_crumbs"] { min-width:0; overflow:hidden; }
  [data-dsh-mobile-header] [class*="_crumb"] { max-width:46vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  [data-dsh-mobile-header] [class*="_headerActions"] { min-width:0; overflow-x:auto; scrollbar-width:none; }
  [data-dsh-mobile-header] [class*="_headerActions"]::-webkit-scrollbar { display:none; }
  [data-dsh-mobile-header] [class*="_headerUtilities"] { gap:2px !important; }
  [data-dsh-mobile-header] [class*="_sessionLogButton"] { width:40px; min-width:40px; padding:0 !important; overflow:hidden; color:transparent; font-size:0 !important; }
  [data-dsh-mobile-header] [class*="_sessionLogButton"] > * { display:none !important; }
  [data-dsh-mobile-header] [class*="_sessionLogButton"]::after { color:var(--dsw-text, #171a21); content:"Log"; font-size:11px; font-weight:600; }
  html[data-dsh-mobile-language="zh"] [data-dsh-mobile-header] [class*="_sessionLogButton"]::after { content:"日志"; }
  [data-dsh-mobile-header] [class*="_tabs"] { box-sizing:border-box !important; width:max-content !important; max-width:calc(100% - 58px) !important; min-height:28px !important; height:28px !important; margin-top:0 !important; padding-left:6px !important; padding-right:6px !important; overflow-x:auto; scrollbar-width:none; }
  [data-dsh-mobile-header] [class*="_tab"] { padding-bottom:5px !important; }
  [data-dsh-mobile-header] [class*="_tabs"]::-webkit-scrollbar { display:none; }
  [data-dsh-mobile-sidebar] { position:fixed !important; z-index:240 !important; inset:0 auto 0 0 !important; width:0 !important; overflow:visible !important; }
  [data-dsh-mobile-sidebar-root] { position:fixed !important; z-index:241 !important; inset:max(env(safe-area-inset-top),0px) auto 0 0 !important; height:auto !important; transition:width 180ms var(--dsh-mobile-motion-ease),box-shadow 180ms ease !important; }
  [data-dsh-mobile-sidebar][data-open="true"] [data-dsh-mobile-sidebar-root] { width:min(88vw,340px) !important; padding-top:0 !important; box-shadow:18px 0 46px rgb(15 23 42 / 18%); }
  [data-dsh-mobile-sidebar][data-open="true"] [data-dsh-mobile-sidebar-root] [class*="_logoRow"] { height:52px !important; padding:4px 0 4px 4px !important; margin-bottom:4px !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] { width:0 !important; border:0 !important; background:transparent !important; box-shadow:none !important; overflow:visible !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :not(:has([data-dsh-mobile-toggle])) { display:none !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :has([data-dsh-mobile-toggle]) { position:fixed !important; z-index:244 !important; top:env(safe-area-inset-top) !important; left:0 !important; box-sizing:border-box !important; width:50px !important; height:52px !important; padding:4px !important; border:0 !important; background:transparent !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :has([data-dsh-mobile-toggle]) > :not([data-dsh-mobile-toggle]) { display:none !important; }
  [data-dsh-mobile-toggle] { width:44px !important; height:44px !important; min-width:44px !important; min-height:44px !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-toggle] > svg[class*="_railFish"] { transform:translateY(-4px) !important; }
  .dsh-native-mobile-backdrop { position:fixed; z-index:235; inset:env(safe-area-inset-top) 0 0; border:0; background:rgb(15 23 42 / 32%); }
  .dsh-native-mobile-backdrop:not([hidden]) { animation:dsh-mobile-fade-in var(--dsh-mobile-motion-duration) ease-out; }
  .dsh-native-mobile-backdrop[hidden] { display:none; }
  [data-dsh-mobile-details] { position:fixed !important; z-index:250 !important; inset:0 0 0 auto !important; width:min(94vw,460px) !important; max-width:none !important; transform:translateX(100%); transition:transform var(--dsh-mobile-motion-duration) var(--dsh-mobile-motion-ease); background:var(--dsw-bg, #fff); box-shadow:-18px 0 46px rgb(15 23 42 / 18%); }
  [data-dsh-mobile-details][data-open="true"] { transform:translateX(0); }
  [data-dsh-mobile-handle] { display:none !important; }
  [data-dsh-mobile-settings] { flex-direction:column !important; width:100vw !important; height:100dvh !important; max-width:none !important; border-radius:0 !important; animation:dsh-mobile-panel-in var(--dsh-mobile-motion-duration) var(--dsh-mobile-motion-ease); }
  [data-dsh-mobile-settings-nav] { flex:none !important; width:100% !important; padding:max(14px,env(safe-area-inset-top)) 12px 8px !important; gap:10px !important; border-bottom:1px solid var(--dsw-alias-border-subtle,#e8ebef); }
  [data-dsh-mobile-settings-nav] [class*="_navTitle"] { padding:0 8px !important; font-size:18px !important; line-height:28px !important; }
  [data-dsh-mobile-settings-list] { flex-direction:row !important; gap:4px !important; overflow-x:auto !important; scrollbar-width:none; }
  [data-dsh-mobile-settings-list]::-webkit-scrollbar { display:none; }
  [data-dsh-mobile-settings-list] [class*="_navCell"] { flex:0 0 auto !important; min-width:max-content !important; height:44px !important; padding:10px 12px !important; }
  [data-dsh-mobile-settings-list] [aria-current="true"] { border-color:transparent !important; outline:0 !important; box-shadow:none !important; }
  [data-dsh-mobile-settings-content] { flex:1 1 auto !important; width:100% !important; min-height:0 !important; }
  [data-dsh-mobile-settings-header] { height:48px !important; min-height:48px !important; padding:10px 12px 6px !important; }
  [data-dsh-mobile-settings-header] [class*="_close"] { width:36px !important; height:36px !important; }
  [data-dsh-mobile-settings-options] { box-sizing:border-box !important; width:100% !important; padding:4px 16px max(24px,env(safe-area-inset-bottom)) !important; overflow-x:hidden !important; }
  [data-dsh-mobile-settings-options] > * { width:100% !important; min-width:0 !important; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] > [class*="_row"] { flex-direction:column !important; align-items:stretch !important; gap:12px !important; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] [class*="_rowText"] { width:100% !important; padding-right:0 !important; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] [class*="_selector"] { box-sizing:border-box !important; align-self:flex-start !important; justify-content:space-between !important; min-width:0 !important; min-height:44px !important; max-width:100% !important; }
  [data-dsh-mobile-settings-options] :is(input,select,textarea,button) { max-width:100%; }
  [data-dsh-mobile-settings-options] :is(input,select,textarea) { box-sizing:border-box; width:100%; min-width:0; }
  [data-dsh-mobile-settings-options] [class*="_head"] { min-width:0; flex-wrap:wrap; }
  /* Provider names may shrink, but their edit/delete actions remain horizontal
     and retain a full touch target on narrow screens. */
  [data-dsh-mobile-settings-options] [class*="_rowHead"]:has(> [class*="_rowIdentity"]) { flex-wrap:nowrap !important; align-items:center !important; }
  [data-dsh-mobile-settings-options] [class*="_rowIdentity"] { flex:1 1 auto !important; min-width:0 !important; overflow:hidden !important; }
  [data-dsh-mobile-settings-options] [class*="_rowName"] { min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-mobile-settings-options] [class*="_rowActions"] { flex:0 0 auto !important; flex-wrap:nowrap !important; width:max-content !important; min-width:max-content !important; max-width:none !important; }
  [data-dsh-mobile-settings-options] [class*="_rowActions"] button { flex:none !important; width:auto !important; min-width:44px !important; max-width:none !important; min-height:44px !important; padding-inline:10px !important; white-space:nowrap !important; word-break:keep-all !important; writing-mode:horizontal-tb !important; }
  [data-dsh-mobile-settings-content][data-dsh-mobile-view-transition="true"],
  [data-dsh-mobile-view][data-dsh-mobile-view-transition="true"] { animation:dsh-mobile-view-in var(--dsh-mobile-motion-duration) var(--dsh-mobile-motion-ease); }
  [data-dsh-mobile-center] textarea { font-size:16px !important; }
  /* Markdown tables use content-sized columns. Small tables fill the phone;
     wider tables keep readable cells and scroll inside their own region. */
  [data-dsh-mobile-table-scroll] { box-sizing:border-box; width:100%; max-width:100%; overflow-x:auto; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; }
  [data-dsh-mobile-table-scroll] table { display:table !important; width:max-content !important; min-width:100% !important; max-width:none !important; table-layout:auto !important; }
  [data-dsh-mobile-table-scroll] :is(th,td) { box-sizing:border-box; min-width:8ch; max-width:32ch; overflow-wrap:anywhere; word-break:break-word; vertical-align:top; }
  [data-dsh-mobile-center] pre { max-width:100%; overflow-x:auto; }
  [data-dsh-mobile-center] :is(img,video,canvas,svg) { max-width:100%; }
  [data-dsh-mobile-message-scroll] { box-sizing:border-box !important; width:100% !important; padding:8px 10px 20px !important; }
  [data-dsh-mobile-history-loader] { position:relative !important; min-height:1px !important; }
  [data-dsh-mobile-history-loader] button:not(:disabled) { position:absolute !important; width:1px !important; height:1px !important; margin:-1px !important; padding:0 !important; clip-path:inset(50%) !important; opacity:0 !important; overflow:hidden !important; pointer-events:none !important; }
  [data-dsh-mobile-history-loader] button:disabled { min-height:28px !important; padding:4px 12px !important; }
  [data-dsh-mobile-message-column] { box-sizing:border-box !important; width:100% !important; max-width:none !important; margin:0 !important; padding:0 !important; gap:10px !important; }
  [data-dsh-mobile-message-column] > * { width:100% !important; max-width:100% !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] { box-sizing:border-box !important; display:grid !important; grid-template-columns:16px minmax(0,1fr) !important; grid-auto-rows:auto !important; align-items:center !important; column-gap:6px !important; width:100% !important; height:auto !important; min-height:40px !important; padding:4px 0 !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > [class*="_leading"] { grid-column:1 !important; grid-row:1 !important; margin-right:0 !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > [class*="_title"] { grid-column:2 !important; grid-row:1 !important; min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > :is([class*="_sep"],[class*="_separator"]) { display:none !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > :is([class*="_summary"],[class*="_fileLink"]) { grid-column:2 !important; grid-row:2 !important; width:100% !important; min-width:0 !important; max-width:100% !important; overflow:hidden !important; line-height:19px !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > [class*="_summarySuffix"] { grid-column:2 !important; grid-row:3 !important; margin-left:0 !important; }
  [data-dsh-mobile-message-column] [data-context-fields] > * { display:grid !important; grid-template-columns:minmax(72px,30%) minmax(0,1fr) !important; gap:4px 10px !important; }
  [data-dsh-mobile-message-column] [class*="_ioSection"] { grid-template-columns:1fr !important; row-gap:4px !important; }
  [data-dsh-mobile-message-column] [class*="_body"] { max-width:100% !important; overflow-wrap:anywhere; }
  [data-dsh-mobile-center] [data-composer-card] ~ [class*="_root"],
  [data-dsh-mobile-center] [data-composer-card] ~ * [class*="_root"] { box-sizing:border-box !important; width:100% !important; max-width:100% !important; margin-bottom:-6px !important; padding:3px 4px 0 !important; font-size:11px !important; line-height:18px !important; white-space:normal !important; overflow:visible !important; text-overflow:clip !important; }
  [data-dsh-mobile-center] [data-composer-card] ~ [class*="_root"] [class*="_sep"],
  [data-dsh-mobile-center] [data-composer-card] ~ * [class*="_root"] [class*="_sep"] { margin:0 6px !important; }
  /* Message runtime details are inline on desktop. Give the clock/runtime
     label its own wrapping row on narrow screens so TTFT and throughput do
     not push the action buttons or clip at the viewport edge. */
  [data-dsh-mobile-center] [class*="_actions"]:has(> [class*="_timeStart"]),
  [data-dsh-mobile-center] [class*="_actions"]:has(> [class*="_timeEnd"]) { box-sizing:border-box !important; width:100% !important; flex-wrap:wrap !important; justify-content:flex-end !important; height:auto !important; min-height:28px !important; row-gap:2px !important; }
  [data-dsh-mobile-center] [class*="_timeStart"],
  [data-dsh-mobile-center] [class*="_timeEnd"] { box-sizing:border-box !important; flex:1 1 100% !important; order:2 !important; min-width:0 !important; max-width:100% !important; padding:0 !important; line-height:20px !important; text-align:center !important; white-space:normal !important; overflow-wrap:anywhere !important; }
  [data-dsh-mobile-center] [class*="_timeStart"] { box-sizing:border-box !important; flex:1 1 100% !important; order:2 !important; min-width:0 !important; max-width:100% !important; padding:0 !important; line-height:20px !important; text-align:center !important; white-space:normal !important; overflow-wrap:anywhere !important; }
  [data-dsh-mobile-center] [class*="_timeStart"] [class*="_runTimeDot"],
  [data-dsh-mobile-center] [class*="_timeEnd"] [class*="_runTimeDot"] { margin:0 6px !important; }
  /* Keep the context meter's legend rows as readable label/value pairs.
     Generic mobile flex rules can otherwise place the rows side by side and
     break Chinese labels in the middle of a word. */
  [data-dsh-mobile-center] [role="dialog"][aria-label*="上下文"],
  [data-dsh-mobile-center] [role="dialog"][aria-label*="Context"] { width:min(264px,calc(100vw - 32px)) !important; min-width:0 !important; max-width:calc(100vw - 32px) !important; }
  [data-dsh-mobile-center] [role="dialog"][aria-label*="上下文"] [class*="_rows"],
  [data-dsh-mobile-center] [role="dialog"][aria-label*="Context"] [class*="_rows"] { display:block !important; }
  [data-dsh-mobile-center] [role="dialog"][aria-label*="上下文"] [class*="_rows"] > [class*="_row"],
  [data-dsh-mobile-center] [role="dialog"][aria-label*="Context"] [class*="_rows"] > [class*="_row"] { display:flex !important; align-items:center !important; justify-content:space-between !important; width:100% !important; min-width:0 !important; white-space:nowrap !important; }
  [data-dsh-mobile-center] [role="dialog"][aria-label*="上下文"] :is(dt,dd),
  [data-dsh-mobile-center] [role="dialog"][aria-label*="Context"] :is(dt,dd) { white-space:nowrap !important; word-break:keep-all !important; }
  .dsh-mobile-branch-toast,.dsh-mobile-media-toast { position:fixed; z-index:330; top:max(12px,env(safe-area-inset-top)); left:50%; max-width:calc(100vw - 32px); box-sizing:border-box; padding:7px 14px; border:1px solid rgb(15 23 42 / 10%); border-radius:999px; background:rgb(15 23 42 / 92%); color:#fff; font-size:13px; line-height:20px; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0; pointer-events:none; transform:translate(-50%,-8px); transition:opacity 160ms ease,transform 160ms ease; }
  .dsh-mobile-branch-toast[data-visible="true"],.dsh-mobile-media-toast[data-visible="true"] { opacity:1; transform:translate(-50%,0); }
  .dsh-mobile-media-button { box-sizing:border-box; display:grid; place-items:center; width:36px; min-width:36px; height:36px; min-height:36px; padding:0; border:0; border-radius:999px; background:transparent; color:inherit; font-size:20px; line-height:1; }
  .dsh-mobile-media-button:disabled { opacity:.38; }
  .dsh-mobile-media-menu { position:fixed; z-index:325; right:12px; bottom:max(92px,calc(env(safe-area-inset-bottom) + 84px)); left:12px; box-sizing:border-box; display:grid; gap:8px; max-width:420px; margin:0 auto; padding:12px; border:1px solid var(--dsw-alias-border-subtle,rgb(148 163 184 / 28%)); border-radius:18px; background:var(--dsw-bg,#171a21); box-shadow:0 16px 48px rgb(0 0 0 / 28%); }
  .dsh-mobile-media-menu[hidden] { display:none; }
  .dsh-mobile-media-menu button { box-sizing:border-box; width:100%; min-height:48px; padding:10px 14px; border:1px solid var(--dsw-alias-border-subtle,rgb(148 163 184 / 24%)); border-radius:14px; background:var(--dsw-alias-interactive-bg-hover,rgb(148 163 184 / 12%)); color:inherit; font:inherit; text-align:left; }
  [data-dsh-mobile-center] [class*="_composer"] { padding-left:8px !important; padding-right:8px !important; padding-bottom:max(8px,env(safe-area-inset-bottom)) !important; }
  /* The desktop composer intentionally wraps whole toolbar groups. On a phone,
     dynamic model and status labels made that row alternate between one and
     two lines. Keep two stable columns and let only the model label shrink. */
  [data-dsh-mobile-composer-row] { display:grid !important; grid-template-columns:max-content minmax(0,1fr) !important; align-items:center !important; gap:4px 8px !important; }
  [data-dsh-mobile-composer-tools] { display:flex !important; flex-wrap:nowrap !important; width:max-content !important; min-width:0 !important; max-width:max-content !important; gap:6px !important; }
  [data-dsh-mobile-composer-trailing] { display:flex !important; flex-wrap:nowrap !important; width:100% !important; min-width:0 !important; max-width:100% !important; gap:6px !important; margin-left:0 !important; justify-content:flex-end !important; }
  [data-dsh-mobile-composer-model] { flex:1 1 0 !important; width:auto !important; min-width:0 !important; max-width:none !important; }
  [data-dsh-mobile-composer-model-trigger] { box-sizing:border-box !important; width:100% !important; max-width:100% !important; min-width:0 !important; padding-left:6px !important; padding-right:4px !important; }
  [data-dsh-mobile-composer-model-label] { flex:1 1 auto !important; max-width:none !important; min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-mobile-center] [class*="_root"]:has(> [class*="_card"] textarea) { box-sizing:border-box !important; width:100% !important; padding:0 0 8px !important; }
  [data-dsh-mobile-center] [class*="_root"]:has(> [class*="_card"] textarea) > [class=""]:last-child { display:none !important; }
}
@keyframes dsh-mobile-fade-in { from { opacity:0; } }
@keyframes dsh-mobile-panel-in { from { opacity:.72; transform:translateY(6px); } }
@keyframes dsh-mobile-view-in { from { opacity:.58; transform:translateY(5px); } }
@media (max-width:420px) {
  [data-dsh-mobile-header] [class*="_headerActions"] { max-width:42vw; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] [class*="_selector"] { align-self:stretch !important; width:100% !important; }
  [data-dsh-mobile-message-column] [data-context-fields] > * { grid-template-columns:1fr !important; }
}
@media (prefers-reduced-motion:reduce) {
  [data-dsh-mobile-sidebar-root],[data-dsh-mobile-details] { transition:none !important; }
  .dsh-native-mobile-backdrop:not([hidden]),[data-dsh-mobile-settings],
  [data-dsh-mobile-settings-content][data-dsh-mobile-view-transition="true"],
  [data-dsh-mobile-view][data-dsh-mobile-view-transition="true"] { animation:none !important; }
}
`

function classToken(element: Element, suffix: string): boolean {
  return Array.from(element.classList).some(value => value.endsWith(suffix))
}

function firstByClassSuffix(root: ParentNode, suffix: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>('[class]')).find(element => classToken(element, suffix))
}

const AUTO_HISTORY_THRESHOLD_PX = 64

export type NativeMobileLanguage = 'it' | 'en' | 'zh'

interface FileDropTarget { dispatchEvent(event: Event): boolean }

function controlledFileDragEvent(type: 'dragover' | 'drop', files: readonly File[], initialDropEffect: DataTransfer['dropEffect']): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  const dataTransfer = {
    dropEffect: initialDropEffect,
    effectAllowed: 'copy',
    files: Object.freeze([...files]),
    types: Object.freeze(['Files']),
  } as unknown as DataTransfer
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

/** Ask the official document dragover listener whether the current composer accepts files. */
export function preflightComposerImageDrop(target: FileDropTarget, files: readonly File[]): boolean {
  if (files.length === 0) return false
  const event = controlledFileDragEvent('dragover', files, 'none')
  target.dispatchEvent(event)
  return event.dataTransfer?.dropEffect === 'copy'
}

/** Dispatch a real drop only after a fresh official-listener preflight; the result is not an attachment ACK. */
export function dispatchComposerImageDrop(target: FileDropTarget, files: readonly File[]): boolean {
  if (!preflightComposerImageDrop(target, files)) return false
  target.dispatchEvent(controlledFileDragEvent('drop', files, 'copy'))
  return true
}

/** Apply the resolved locale independently from the document's possibly different lang attribute. */
export function applyNativeMobileLanguageMarker(root: Pick<HTMLElement, 'dataset'>, language: NativeMobileLanguage): () => void {
  const previous = root.dataset.dshMobileLanguage
  root.dataset.dshMobileLanguage = language
  return () => {
    if (root.dataset.dshMobileLanguage !== language) return
    if (previous === undefined) delete root.dataset.dshMobileLanguage
    else root.dataset.dshMobileLanguage = previous
  }
}

/** Resolve the supported language used by native-mobile controls. */
export function resolveNativeMobileLanguage(
  preference: string,
  documentLanguage: string,
  browserLanguages: readonly string[],
): NativeMobileLanguage {
  return [preference, documentLanguage, ...browserLanguages]
    .map(value => value.trim().toLowerCase().split(/[-_]/u)[0])
    .find((value): value is NativeMobileLanguage => value === 'it' || value === 'en' || value === 'zh') ?? 'en'
}

/** Whether a user-driven scroll moved upward into the automatic history-loading zone. */
export function shouldAutoLoadEarlier(previousTop: number, currentTop: number): boolean {
  return currentTop <= AUTO_HISTORY_THRESHOLD_PX && currentTop < previousTop - 0.5
}

interface ComposerMediaOrigin {
  readonly generation: number
  readonly href: string
  readonly composer: object | null
  readonly sessionRoot: object | null
  readonly sessionId: string | null
}

/** Check that an asynchronous picker result still belongs to its originating session and composer. */
export function isComposerMediaOriginCurrent(
  origin: ComposerMediaOrigin,
  current: ComposerMediaOrigin & { readonly disposed: boolean; readonly composerConnected: boolean },
): boolean {
  return !current.disposed
    && origin.generation === current.generation
    && origin.href === current.href
    && origin.composer !== null
    && current.composerConnected
    && origin.composer === current.composer
    && origin.sessionRoot !== null
    && origin.sessionRoot === current.sessionRoot
    && origin.sessionId !== null
    && origin.sessionId === current.sessionId
}

/** Add mobile semantics without replacing feature trees. */
export function installNativeMobileSurface(): () => void {
  document.documentElement.classList.add('dsh-native-mobile-active')
  let localePreference = ''
  try { localePreference = window.localStorage.getItem('dsh-mobile-control-locale') ?? '' } catch { /* Storage may be unavailable. */ }
  const browserLanguages = navigator.languages.length > 0 ? navigator.languages : [navigator.language]
  const language = resolveNativeMobileLanguage(localePreference, document.documentElement.lang, browserLanguages)
  const restoreLanguageMarker = applyNativeMobileLanguageMarker(document.documentElement, language)
  const label = (italian: string, english: string, chinese: string): string => language === 'it' ? italian : language === 'zh' ? chinese : english
  const setInputMode = (mode: 'keyboard' | 'touch'): void => {
    document.documentElement.dataset.dshMobileInput = mode
  }
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') setInputMode('touch')
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab' || event.key.startsWith('Arrow')) setInputMode('keyboard')
  }
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  const backdrop = document.createElement('button')
  backdrop.type = 'button'
  backdrop.className = 'dsh-native-mobile-backdrop'
  backdrop.lang = language
  backdrop.hidden = true
  backdrop.setAttribute('aria-label', label('Chiudi navigazione area di lavoro', 'Close workspace navigation', '关闭工作区导航'))
  document.body.append(backdrop)
  const branchToast = document.createElement('div')
  branchToast.className = 'dsh-mobile-branch-toast'
  branchToast.lang = language
  branchToast.setAttribute('role', 'status')
  branchToast.setAttribute('aria-live', 'polite')
  document.body.append(branchToast)
  const mediaToast = document.createElement('div')
  mediaToast.className = 'dsh-mobile-media-toast'
  mediaToast.lang = language
  mediaToast.setAttribute('role', 'status')
  mediaToast.setAttribute('aria-live', 'polite')
  document.body.append(mediaToast)
  const mediaButton = document.createElement('button')
  mediaButton.type = 'button'
  mediaButton.className = 'dsh-mobile-media-button'
  mediaButton.lang = language
  mediaButton.textContent = '📎'
  mediaButton.setAttribute('aria-label', label('Allega immagine', 'Attach image', '附加图片'))
  mediaButton.setAttribute('aria-haspopup', 'dialog')
  mediaButton.setAttribute('aria-expanded', 'false')
  mediaButton.disabled = true
  const mediaMenu = document.createElement('div')
  mediaMenu.id = 'dsh-mobile-media-menu'
  mediaMenu.className = 'dsh-mobile-media-menu'
  mediaMenu.lang = language
  mediaMenu.setAttribute('role', 'dialog')
  mediaMenu.setAttribute('aria-label', label('Aggiungi immagine', 'Add image', '添加图片'))
  mediaMenu.hidden = true
  mediaButton.setAttribute('aria-controls', mediaMenu.id)
  const fileButton = document.createElement('button')
  fileButton.type = 'button'
  fileButton.textContent = label('Scegli screenshot o immagine', 'Choose screenshot or image', '选择截图或图片')
  const cameraButton = document.createElement('button')
  cameraButton.type = 'button'
  cameraButton.textContent = label('Scatta una foto', 'Take a photo', '拍摄照片')
  mediaMenu.append(fileButton, cameraButton)
  document.body.append(mediaMenu)
  let branchToastTimer = 0
  let mediaToastTimer = 0
  const showMediaToast = (message: string): void => {
    mediaToast.textContent = message
    mediaToast.dataset.visible = 'true'
    if (mediaToastTimer !== 0) window.clearTimeout(mediaToastTimer)
    mediaToastTimer = window.setTimeout(() => {
      mediaToast.removeAttribute('data-visible')
      mediaToastTimer = 0
    }, 2200)
  }
  const closeMediaMenu = (restoreFocus = false): void => {
    const wasOpen = !mediaMenu.hidden
    mediaMenu.hidden = true
    mediaButton.setAttribute('aria-expanded', 'false')
    if (restoreFocus && wasOpen && mediaButton.isConnected && !mediaButton.disabled) mediaButton.focus({ preventScroll: true })
  }
  let mediaRequestGeneration = 0
  let disposed = false
  const preflightFile = new File([], 'dsh-mobile-preflight.png', { type: 'image/png' })
  const canAcceptComposerDrop = (): boolean => preflightComposerImageDrop(document, [preflightFile])
  const mediaPickerAbortController = new AbortController()
  const browserPickerCleanups = new Set<() => void>()
  const sessionTokens = new WeakMap<Element, string>()
  let nextSessionToken = 0
  type MediaRequestContext = ComposerMediaOrigin & { readonly composer: Element | null; readonly sessionRoot: Element | null }
  const currentSessionOrigin = (): { readonly sessionRoot: Element | null; readonly sessionId: string | null } => {
    const dedicatedRoot = mediaButton.closest('[data-dsh-mobile-session]')
    const dedicatedId = dedicatedRoot?.getAttribute('data-dsh-mobile-session')
    if (dedicatedRoot !== null && typeof dedicatedId === 'string' && dedicatedId !== '') {
      return { sessionRoot: dedicatedRoot, sessionId: dedicatedId }
    }
    const selectedRow = document.querySelector<Element>('[role="treeitem"][aria-selected="true"]')
    if (selectedRow === null) return { sessionRoot: null, sessionId: null }
    let token = sessionTokens.get(selectedRow)
    if (token === undefined) { token = `stock-${String(++nextSessionToken)}`; sessionTokens.set(selectedRow, token) }
    const identity = selectedRow.getAttribute('data-session-id')
      ?? selectedRow.getAttribute('aria-label')
      ?? selectedRow.textContent?.trim()
      ?? ''
    return { sessionRoot: selectedRow, sessionId: `${token}:${identity}` }
  }
  const mediaRequestContext = (): MediaRequestContext => {
    const session = currentSessionOrigin()
    return {
      generation: ++mediaRequestGeneration,
      href: window.location.href,
      composer: mediaButton.closest('[data-composer-card]'),
      ...session,
    }
  }
  const mediaRequestIsCurrent = (context: MediaRequestContext): boolean => {
    const session = currentSessionOrigin()
    const composer = mediaButton.closest('[data-composer-card]')
    return isComposerMediaOriginCurrent(context, {
      generation: mediaRequestGeneration,
      href: window.location.href,
      composer,
      sessionRoot: session.sessionRoot,
      sessionId: session.sessionId,
      disposed,
      composerConnected: context.composer?.isConnected === true,
    })
  }
  const deliverImages = (files: readonly File[], context: ReturnType<typeof mediaRequestContext>): void => {
    if (files.length === 0 || !mediaRequestIsCurrent(context)) return
    dispatchComposerImageDrop(document, files)
  }
  const launchBrowserPicker = (camera: boolean, context: ReturnType<typeof mediaRequestContext>): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif'
    if (camera) input.capture = 'environment'
    input.hidden = true
    const signal = mediaPickerAbortController.signal
    let cleanupTimer = 0
    let watchdogTimer = 0
    let cleaned = false
    const scheduleCleanup = (): void => {
      if (!cleaned && cleanupTimer === 0) cleanupTimer = window.setTimeout(cleanup, 1000)
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') scheduleCleanup()
    }
    const onChange = (): void => {
      if (cleaned) return
      const files = input.files === null ? [] : [...input.files]
      cleanup()
      deliverImages(files, context)
    }
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      if (cleanupTimer !== 0) window.clearTimeout(cleanupTimer)
      if (watchdogTimer !== 0) window.clearTimeout(watchdogTimer)
      cleanupTimer = 0
      watchdogTimer = 0
      input.removeEventListener('change', onChange)
      input.removeEventListener('cancel', cleanup)
      window.removeEventListener('focus', scheduleCleanup)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      signal.removeEventListener('abort', cleanup)
      browserPickerCleanups.delete(cleanup)
      input.remove()
    }
    input.addEventListener('change', onChange)
    input.addEventListener('cancel', cleanup)
    window.addEventListener('focus', scheduleCleanup)
    document.addEventListener('visibilitychange', onVisibilityChange)
    signal.addEventListener('abort', cleanup, { once: true })
    watchdogTimer = window.setTimeout(cleanup, 300_000)
    browserPickerCleanups.add(cleanup)
    if (signal.aborted) { cleanup(); return }
    try {
      document.body.append(input)
      input.click()
    } catch {
      cleanup()
      if (mediaRequestIsCurrent(context)) showMediaToast(label('Impossibile aprire il selettore immagini', 'Could not open the image picker', '无法打开图片选择器'))
    }
  }
  const pickImage = (camera: boolean): void => {
    if (!canAcceptComposerDrop()) {
      mediaButton.disabled = true
      closeMediaMenu(true)
      return
    }
    closeMediaMenu(true)
    const context = mediaRequestContext()
    const bridge = window.__DSH_MOBILE_NATIVE__
    if (bridge === undefined) {
      launchBrowserPicker(camera, context)
      return
    }
    const action = camera ? 'camera.capture' : 'files.pick'
    const input = camera ? {} : { accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }
    void Promise.resolve().then(() => bridge.invoke(action, input)).then(value => {
      if (!mediaRequestIsCurrent(context)) return
      if (value instanceof File) deliverImages([value], context)
      else showMediaToast(label('Il file selezionato non è utilizzabile', 'The selected file is unavailable', '所选文件不可用'))
    }).catch((error: unknown) => {
      if (!mediaRequestIsCurrent(context)) return
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
      if (code === 'cancelled') return
      showMediaToast(code === 'payload_too_large'
        ? label('L’immagine supera il limite di 8 MiB', 'The image exceeds the 8 MiB limit', '图片超过 8 MiB 限制')
        : label('Impossibile aggiungere l’immagine', 'Could not attach the image', '无法附加图片'))
    })
  }
  mediaButton.addEventListener('click', event => {
    event.stopPropagation()
    if (mediaMenu.hidden) {
      if (!canAcceptComposerDrop()) { mediaButton.disabled = true; closeMediaMenu(); return }
      mediaMenu.hidden = false
      mediaButton.setAttribute('aria-expanded', 'true')
      fileButton.focus({ preventScroll: true })
    } else {
      closeMediaMenu(true)
    }
  })
  fileButton.addEventListener('click', () => { pickImage(false) })
  cameraButton.addEventListener('click', () => { pickImage(true) })
  const closeMediaMenuOnOutsideClick = (event: MouseEvent): void => {
    if (mediaMenu.hidden || !(event.target instanceof Node)) return
    if (!mediaMenu.contains(event.target) && !mediaButton.contains(event.target)) closeMediaMenu()
  }
  const handleMediaMenuKeyboard = (event: KeyboardEvent): void => {
    if (mediaMenu.hidden) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMediaMenu(true)
      return
    }
    if (event.key !== 'Tab') return
    const first = fileButton
    const last = cameraButton
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus({ preventScroll: true })
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus({ preventScroll: true })
    }
  }
  document.addEventListener('click', closeMediaMenuOnOutsideClick)
  document.addEventListener('keydown', handleMediaMenuKeyboard, true)
  const showBranchToast = (): void => {
    const header = document.querySelector<HTMLElement>('[data-dsh-mobile-header]')
    const title = header === null ? undefined : header.querySelector<HTMLElement>('[class*="_crumbCurrent"]')?.textContent?.trim()
    const prefix = label('Ramo corrente', 'Current branch', '当前分支')
    branchToast.textContent = title === undefined ? prefix : `${prefix}: ${title}`
    branchToast.dataset.visible = 'true'
    if (branchToastTimer !== 0) window.clearTimeout(branchToastTimer)
    branchToastTimer = window.setTimeout(() => {
      branchToast.removeAttribute('data-visible')
      branchToastTimer = 0
    }, 1600)
  }
  const onBranchClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const branch = event.target.closest<HTMLButtonElement>('button[aria-label*="分支"],button[aria-label*="Branch"],button[aria-label*="branch"],button[aria-label*="Ramo"],button[aria-label*="ramo"]')
    if (branch === null || branch.hasAttribute('disabled') || branch.getAttribute('aria-disabled') === 'true') return
    window.setTimeout(showBranchToast, 80)
  }
  document.addEventListener('click', onBranchClick, true)
  let frame: HTMLElement | undefined
  let sidebar: HTMLElement | undefined
  let sidebarRoot: HTMLElement | undefined
  let toggle: HTMLButtonElement | undefined
  let viewArea: HTMLElement | undefined
  let scheduled = 0
  let transitionFrame = 0
  let transitionRestartFrame = 0
  let transitionTimer = 0
  let transitionTarget: HTMLElement | undefined
  let historyScroller: HTMLElement | undefined
  let historyPreviousTop = 0
  const historyLoadButton = (): HTMLButtonElement | undefined => {
    const loader = historyScroller === undefined ? undefined : firstByClassSuffix(historyScroller, '_older')
    return loader?.querySelector<HTMLButtonElement>('button') ?? undefined
  }
  const onHistoryScroll = (): void => {
    if (historyScroller === undefined) return
    const currentTop = Math.max(0, historyScroller.scrollTop)
    const shouldLoad = shouldAutoLoadEarlier(historyPreviousTop, currentTop)
    historyPreviousTop = currentTop
    if (!shouldLoad) return
    const button = historyLoadButton()
    if (button === undefined || button.disabled || button.getAttribute('aria-disabled') === 'true') return
    button.click()
  }
  const bindHistoryScroller = (next: HTMLElement | undefined): void => {
    if (historyScroller === next) return
    historyScroller?.removeEventListener('scroll', onHistoryScroll)
    historyScroller = next
    historyPreviousTop = next?.scrollTop ?? 0
    historyScroller?.addEventListener('scroll', onHistoryScroll, { passive: true })
  }
  const animateNavigation = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const trigger = event.target.closest<HTMLElement>('button,a,[role="tab"],[aria-selected]')
    if (trigger === null || trigger.hasAttribute('disabled') || trigger.getAttribute('aria-disabled') === 'true') return
    if (trigger.getAttribute('aria-selected') === 'true' || trigger.getAttribute('aria-current') === 'true') return
    const settingsNavigation = trigger.closest('[data-dsh-mobile-settings-list]') !== null
    const conversationNavigation = trigger.matches('[role="tab"]')
    const sidebarNavigation = trigger.closest('[data-dsh-mobile-sidebar-root]') !== null
      && trigger.closest('[data-dsh-mobile-toggle]') === null
    if (!settingsNavigation && !conversationNavigation && !sidebarNavigation) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (transitionFrame !== 0) cancelAnimationFrame(transitionFrame)
    if (transitionRestartFrame !== 0) cancelAnimationFrame(transitionRestartFrame)
    transitionFrame = requestAnimationFrame(() => {
      transitionFrame = 0
      const target = settingsNavigation
        ? document.querySelector<HTMLElement>('[data-dsh-mobile-settings-content]')
        : viewArea
      if (target === null || target === undefined) return
      transitionTarget?.removeAttribute('data-dsh-mobile-view-transition')
      target.removeAttribute('data-dsh-mobile-view-transition')
      transitionRestartFrame = requestAnimationFrame(() => {
        transitionRestartFrame = 0
        transitionTarget = target
        target.dataset.dshMobileViewTransition = 'true'
        if (transitionTimer !== 0) clearTimeout(transitionTimer)
        transitionTimer = window.setTimeout(() => {
          target.removeAttribute('data-dsh-mobile-view-transition')
          if (transitionTarget === target) transitionTarget = undefined
          transitionTimer = 0
        }, 240)
      })
    })
  }
  document.addEventListener('click', animateNavigation)
  let boundComposer: Element | null = null
  let boundSessionRoot: Element | null = null
  let boundSessionId: string | null = null
  const syncMediaBinding = (composer: Element | null): void => {
    const session = currentSessionOrigin()
    if (composer === boundComposer && session.sessionRoot === boundSessionRoot && session.sessionId === boundSessionId) return
    boundComposer = composer
    boundSessionRoot = session.sessionRoot
    boundSessionId = session.sessionId
    mediaRequestGeneration += 1
    closeMediaMenu()
  }

  const sync = (): void => {
    scheduled = 0
    frame = firstByClassSuffix(document, '_frame')
    const dedicatedCenter = document.querySelector<HTMLElement>('.dshm-main') ?? undefined
    if (frame !== undefined) frame.dataset.dshMobileFrame = 'true'
    sidebar = frame === undefined
      ? document.querySelector<HTMLElement>('.dshm-drawer') ?? undefined
      : firstByClassSuffix(frame, '_sidebarCol')
    const center = frame === undefined ? dedicatedCenter : firstByClassSuffix(frame, '_centerCol')
    const details = frame === undefined ? undefined : firstByClassSuffix(frame, '_detailsCol')
    const handle = frame === undefined ? undefined : firstByClassSuffix(frame, '_handle')
    if (center === undefined) {
      bindHistoryScroller(undefined)
      mediaButton.disabled = true
      closeMediaMenu()
      mediaButton.remove()
      return
    }
    if (center !== undefined) {
      center.dataset.dshMobileCenter = 'true'
      center.querySelector<HTMLElement>('header')?.setAttribute('data-dsh-mobile-header', 'true')
      viewArea = firstByClassSuffix(center, '_viewArea')
      if (viewArea !== undefined) viewArea.dataset.dshMobileView = 'true'
      const conversation = center.querySelector<HTMLElement>('[data-conversation-scroll]')
      bindHistoryScroller(conversation ?? undefined)
      const historyLoader = conversation === null ? undefined : firstByClassSuffix(conversation, '_older')
      if (historyLoader !== undefined) {
        historyLoader.dataset.dshMobileHistoryLoader = 'true'
        historyLoader.setAttribute('aria-live', 'polite')
        const button = historyLoader.querySelector<HTMLButtonElement>('button')
        if (button !== null) {
          button.tabIndex = -1
          if (button.disabled) button.removeAttribute('aria-hidden')
          else button.setAttribute('aria-hidden', 'true')
        }
      }
      const messageColumn = conversation === null ? undefined : firstByClassSuffix(conversation, '_column')
      const messageScroll = messageColumn?.parentElement
      if (messageColumn !== undefined && messageScroll !== null && messageScroll !== undefined && classToken(messageScroll, '_scroll')) {
        messageColumn.dataset.dshMobileMessageColumn = 'true'
        messageScroll.dataset.dshMobileMessageScroll = 'true'
      }
      for (const table of center.querySelectorAll<HTMLTableElement>('table')) {
        const parent = table.parentElement
        if (parent?.dataset.dshMobileTableScroll === 'true') continue
        const wrapper = document.createElement('div')
        wrapper.dataset.dshMobileTableScroll = 'true'
        table.before(wrapper)
        wrapper.append(table)
      }
      const composerCard = center.querySelector<HTMLElement>('[data-composer-card]')
      const composerRow = composerCard?.querySelector<HTMLElement>(':scope > [data-input-scroll]')?.nextElementSibling
      if (!(composerRow instanceof HTMLElement)) {
        syncMediaBinding(null)
        mediaButton.disabled = true
        mediaButton.title = label('Apri prima una sessione', 'Open a session first', '请先打开会话')
        closeMediaMenu()
        mediaButton.remove()
      }
      if (composerRow instanceof HTMLElement) {
        composerRow.dataset.dshMobileComposerRow = 'true'
        const groups = Array.from(composerRow.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
        const composerTools = groups[0]
        const composerTrailing = groups.at(-1)
        if (composerTools !== undefined) {
          composerTools.dataset.dshMobileComposerTools = 'true'
          if (mediaButton.parentElement !== composerTools) composerTools.append(mediaButton)
          syncMediaBinding(composerCard ?? null)
          const composerInput = composerCard?.querySelector<HTMLTextAreaElement>('textarea')
          const composerBusy = composerCard?.getAttribute('aria-busy') === 'true'
            || composerInput?.disabled === true
            || composerInput?.readOnly === true
          const attachmentBlocked = !canAcceptComposerDrop()
          mediaButton.disabled = conversation === null || currentSessionOrigin().sessionId === null || composerBusy || attachmentBlocked
          mediaButton.title = composerBusy
            ? label('Attendi il completamento della risposta', 'Wait for the response to finish', '请等待回复完成')
            : attachmentBlocked
              ? label('Allegati immagine non disponibili', 'Image attachments are unavailable', '图片附件不可用')
              : mediaButton.disabled
                ? label('Apri prima una sessione', 'Open a session first', '请先打开会话')
                : label('Allega screenshot, immagine o foto', 'Attach screenshot, image, or photo', '附加截图、图片或照片')
          if (mediaButton.disabled) closeMediaMenu()
        }
        if (composerTrailing !== undefined && composerTrailing !== composerTools) {
          composerTrailing.dataset.dshMobileComposerTrailing = 'true'
          const modelTrigger = composerTrailing.querySelector<HTMLButtonElement>('button[aria-label^="选择模型"],button[aria-label^="Select model"],button[aria-label^="Seleziona modello"]')
          if (modelTrigger !== null) {
            modelTrigger.dataset.dshMobileComposerModelTrigger = 'true'
            modelTrigger.parentElement?.setAttribute('data-dsh-mobile-composer-model', 'true')
            modelTrigger.querySelector<HTMLElement>('[class*="_triggerLabel"]')?.setAttribute('data-dsh-mobile-composer-model-label', 'true')
          }
        }
      }
    }
    if (handle !== undefined) handle.dataset.dshMobileHandle = 'true'
    if (details !== undefined) {
      details.dataset.dshMobileDetails = 'true'
      const lastColumn = frame?.style.gridTemplateColumns.trim().split(/\s+/).at(-1)
      details.dataset.open = String(lastColumn !== undefined && lastColumn !== '0px' && lastColumn !== '0')
    }
    const settings = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(dialog => {
      const directNav = Array.from(dialog.children).find(child => child instanceof HTMLElement && classToken(child, '_nav'))
      return directNav !== undefined
    })
    if (settings !== undefined) {
      settings.dataset.dshMobileSettings = 'true'
      const nav = Array.from(settings.children).find(child => child instanceof HTMLElement && classToken(child, '_nav')) as HTMLElement | undefined
      const content = Array.from(settings.children).find(child => child instanceof HTMLElement && classToken(child, '_content')) as HTMLElement | undefined
      if (nav !== undefined) {
        nav.dataset.dshMobileSettingsNav = 'true'
        firstByClassSuffix(nav, '_navList')?.setAttribute('data-dsh-mobile-settings-list', 'true')
      }
      if (content !== undefined) {
        content.dataset.dshMobileSettingsContent = 'true'
        firstByClassSuffix(content, '_header')?.setAttribute('data-dsh-mobile-settings-header', 'true')
        firstByClassSuffix(content, '_options')?.setAttribute('data-dsh-mobile-settings-options', 'true')
      }
    }
    if (sidebar === undefined) return
    sidebar.dataset.dshMobileSidebar = 'true'
    toggle = firstByClassSuffix(sidebar, '_toggle') as HTMLButtonElement | undefined
    let candidate = toggle?.parentElement
    while (candidate !== undefined && candidate !== null && candidate !== sidebar && !classToken(candidate, '_root')) candidate = candidate.parentElement
    sidebarRoot = candidate !== sidebar && candidate !== null ? candidate : undefined
    if (sidebarRoot === undefined) return
    sidebarRoot.dataset.dshMobileSidebarRoot = 'true'
    for (const brand of sidebarRoot.querySelectorAll<HTMLElement>('[class*="_fallbackBrandName"]')) {
      if (brand.textContent?.trim() === 'DSH Local Build') brand.textContent = 'DeepSeek Harness'
    }
    if (toggle !== undefined) toggle.dataset.dshMobileToggle = 'true'
    const collapsed = classToken(sidebarRoot, '_collapsed')
    sidebar.dataset.open = String(!collapsed)
    backdrop.hidden = collapsed
  }
  const schedule = (): void => { if (scheduled === 0) scheduled = requestAnimationFrame(sync) }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'disabled', 'readonly', 'aria-busy', 'aria-selected', 'data-dsh-mobile-session'] })
  backdrop.addEventListener('click', () => { if (sidebar?.dataset.open === 'true') toggle?.click() })
  sync()
  return () => {
    disposed = true
    mediaRequestGeneration += 1
    mediaPickerAbortController.abort()
    restoreLanguageMarker()
    for (const cleanup of [...browserPickerCleanups]) cleanup()
    observer.disconnect()
    document.removeEventListener('click', onBranchClick, true)
    document.removeEventListener('click', closeMediaMenuOnOutsideClick)
    document.removeEventListener('keydown', handleMediaMenuKeyboard, true)
    if (branchToastTimer !== 0) window.clearTimeout(branchToastTimer)
    if (mediaToastTimer !== 0) window.clearTimeout(mediaToastTimer)
    branchToast.remove()
    mediaToast.remove()
    mediaMenu.remove()
    mediaButton.remove()
    if (scheduled !== 0) cancelAnimationFrame(scheduled)
    if (transitionFrame !== 0) cancelAnimationFrame(transitionFrame)
    if (transitionRestartFrame !== 0) cancelAnimationFrame(transitionRestartFrame)
    if (transitionTimer !== 0) clearTimeout(transitionTimer)
    transitionTarget?.removeAttribute('data-dsh-mobile-view-transition')
    historyScroller?.removeEventListener('scroll', onHistoryScroll)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('click', animateNavigation)
    backdrop.remove()
    document.documentElement.classList.remove('dsh-native-mobile-active')
    delete document.documentElement.dataset.dshMobileInput
  }
}
