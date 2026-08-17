/** Mobile layout rules applied to the stock DSH React surface. */
export const NATIVE_MOBILE_STYLES = `
@media (max-width:720px) {
  html.dsh-native-mobile-active,html.dsh-native-mobile-active body { width:100%; height:100%; overflow:hidden; }
  [data-dsh-mobile-frame] { grid-template-columns:0 minmax(0,1fr) 0 !important; width:100% !important; height:100dvh !important; overflow:hidden !important; }
  [data-dsh-mobile-center] { grid-column:2 !important; width:100vw !important; min-width:0 !important; }
  [data-dsh-mobile-center] > * { min-width:0 !important; }
  [data-dsh-mobile-header] { min-width:0; padding-right:12px !important; padding-left:50px !important; }
  [data-dsh-mobile-header] [class*="_titleRow"] { box-sizing:border-box !important; min-width:0; min-height:52px !important; height:52px !important; gap:6px !important; padding:4px 8px !important; }
  [data-dsh-mobile-header] [class*="_titleCluster"] { min-width:0; }
  [data-dsh-mobile-header] [class*="_crumbs"] { min-width:0; overflow:hidden; }
  [data-dsh-mobile-header] [class*="_crumb"] { max-width:46vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  [data-dsh-mobile-header] [class*="_headerActions"] { min-width:0; overflow-x:auto; scrollbar-width:none; }
  [data-dsh-mobile-header] [class*="_headerActions"]::-webkit-scrollbar { display:none; }
  [data-dsh-mobile-header] [class*="_headerUtilities"] { gap:2px !important; }
  [data-dsh-mobile-header] [class*="_sessionLogButton"] { width:40px; min-width:40px; padding:0 !important; overflow:hidden; color:transparent; font-size:0 !important; }
  [data-dsh-mobile-header] [class*="_sessionLogButton"] > * { display:none !important; }
  [data-dsh-mobile-header] [class*="_sessionLogButton"]::after { color:var(--dsw-text, #171a21); content:"日志"; font-size:11px; font-weight:600; }
  [data-dsh-mobile-header] [class*="_tabs"] { min-height:42px; overflow-x:auto; scrollbar-width:none; }
  [data-dsh-mobile-header] [class*="_tabs"]::-webkit-scrollbar { display:none; }
  [data-dsh-mobile-sidebar] { position:fixed !important; z-index:240 !important; inset:0 auto 0 0 !important; width:0 !important; overflow:visible !important; }
  [data-dsh-mobile-sidebar-root] { position:fixed !important; z-index:241 !important; inset:0 auto 0 0 !important; height:100dvh !important; transition:transform 160ms ease !important; }
  [data-dsh-mobile-sidebar][data-open="true"] [data-dsh-mobile-sidebar-root] { width:min(88vw,340px) !important; box-shadow:18px 0 46px rgb(15 23 42 / 18%); }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] { width:0 !important; border:0 !important; background:transparent !important; box-shadow:none !important; overflow:visible !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :not(:has([data-dsh-mobile-toggle])) { display:none !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :has([data-dsh-mobile-toggle]) { position:fixed !important; z-index:244 !important; top:env(safe-area-inset-top) !important; left:0 !important; width:50px !important; height:52px !important; padding:4px !important; border:0 !important; background:transparent !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :has([data-dsh-mobile-toggle]) > :not([data-dsh-mobile-toggle]) { display:none !important; }
  [data-dsh-mobile-toggle] { width:44px !important; height:44px !important; min-width:44px !important; min-height:44px !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-toggle] svg { display:none !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-toggle]::after { width:20px; height:2px; border-radius:2px; background:currentColor; box-shadow:0 -6px 0 currentColor,0 6px 0 currentColor; content:""; }
  .dsh-native-mobile-backdrop { position:fixed; z-index:235; inset:0; border:0; background:rgb(15 23 42 / 32%); }
  .dsh-native-mobile-backdrop[hidden] { display:none; }
  [data-dsh-mobile-details] { position:fixed !important; z-index:250 !important; inset:0 0 0 auto !important; width:min(94vw,460px) !important; max-width:none !important; transform:translateX(100%); transition:transform 160ms ease; background:var(--dsw-bg, #fff); box-shadow:-18px 0 46px rgb(15 23 42 / 18%); }
  [data-dsh-mobile-details][data-open="true"] { transform:translateX(0); }
  [data-dsh-mobile-handle] { display:none !important; }
  [data-dsh-mobile-settings] { flex-direction:column !important; width:100vw !important; height:100dvh !important; max-width:none !important; border-radius:0 !important; }
  [data-dsh-mobile-settings-nav] { flex:none !important; width:100% !important; padding:max(14px,env(safe-area-inset-top)) 12px 8px !important; gap:10px !important; border-bottom:1px solid var(--dsw-alias-border-subtle,#e8ebef); }
  [data-dsh-mobile-settings-nav] [class*="_navTitle"] { padding:0 8px !important; font-size:18px !important; line-height:28px !important; }
  [data-dsh-mobile-settings-list] { flex-direction:row !important; gap:4px !important; overflow-x:auto !important; scrollbar-width:none; }
  [data-dsh-mobile-settings-list]::-webkit-scrollbar { display:none; }
  [data-dsh-mobile-settings-list] [class*="_navCell"] { flex:0 0 auto !important; min-width:max-content !important; height:44px !important; padding:10px 12px !important; }
  [data-dsh-mobile-settings-content] { flex:1 1 auto !important; width:100% !important; min-height:0 !important; }
  [data-dsh-mobile-settings-header] { height:48px !important; min-height:48px !important; padding:10px 12px 6px !important; }
  [data-dsh-mobile-settings-header] [class*="_close"] { width:36px !important; height:36px !important; }
  [data-dsh-mobile-settings-options] { box-sizing:border-box !important; width:100% !important; padding:4px 16px max(24px,env(safe-area-inset-bottom)) !important; overflow-x:hidden !important; }
  [data-dsh-mobile-settings-options] > * { width:100% !important; min-width:0 !important; }
  [data-dsh-mobile-center] textarea { font-size:16px !important; }
  [data-dsh-mobile-center] table { display:block; max-width:100%; overflow-x:auto; }
  [data-dsh-mobile-center] pre { max-width:100%; overflow-x:auto; }
  [data-dsh-mobile-message-scroll] { box-sizing:border-box !important; width:100% !important; padding:12px 16px 20px !important; }
  [data-dsh-mobile-message-column] { box-sizing:border-box !important; width:100% !important; max-width:none !important; margin:0 !important; padding:0 !important; gap:14px !important; }
  [data-dsh-mobile-message-column] > * { width:100% !important; max-width:100% !important; }
  [data-dsh-mobile-center] [class*="_composer"] { padding-left:8px !important; padding-right:8px !important; padding-bottom:max(8px,env(safe-area-inset-bottom)) !important; }
  [data-dsh-mobile-center] [class*="_card"]:has(textarea) [class*="_row"] { display:flex !important; align-items:center !important; gap:4px !important; }
  [data-dsh-mobile-center] [class*="_card"]:has(textarea) [class*="_tools"] { flex:0 0 auto !important; width:auto !important; min-width:0 !important; gap:6px !important; }
  [data-dsh-mobile-center] [class*="_card"]:has(textarea) [class*="_trailing"] { flex:1 1 auto !important; min-width:0 !important; gap:6px !important; }
  [data-dsh-mobile-center] [class*="_card"]:has(textarea) [class*="_trailing"] [class*="_root"]:has(button[aria-label^="选择模型"]) { flex:1 1 auto !important; min-width:0 !important; }
  [data-dsh-mobile-center] [class*="_card"]:has(textarea) button[aria-label^="选择模型"] { width:100% !important; min-width:0 !important; padding-left:6px !important; padding-right:4px !important; }
  [data-dsh-mobile-center] [class*="_card"]:has(textarea) button[aria-label^="选择模型"] [class*="_triggerLabel"] { max-width:78px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  [data-dsh-mobile-center] [class*="_root"]:has(> [class*="_card"] textarea) { box-sizing:border-box !important; width:100% !important; padding:0 0 8px !important; }
  [data-dsh-mobile-center] [class*="_root"]:has(> [class*="_card"] textarea) > [class=""]:last-child { display:none !important; }
  .dsh-native-mobile-attach { display:inline-flex; align-items:center; justify-content:center; flex:0 0 44px; width:44px; height:44px; padding:0; border:0; border-radius:12px; background:transparent; color:var(--dsw-text-secondary,#5e6673); cursor:pointer; }
  .dsh-native-mobile-attach:active { background:var(--dsw-bg-subtle,#f1f3f6); }
  .dsh-native-mobile-attach:focus-visible { outline:2px solid var(--dsw-accent,#4c7eea); outline-offset:2px; }
  .dsh-native-mobile-attach:disabled { cursor:not-allowed; opacity:.38; }
  .dsh-native-mobile-attach svg { width:22px; height:22px; }
  .dsh-native-mobile-sheet-mask { position:fixed; z-index:1080; inset:0; border:0; background:rgb(15 23 42 / 32%); }
  .dsh-native-mobile-sheet-mask[hidden] { display:none; }
  .dsh-native-mobile-sheet { position:fixed; z-index:1081; right:0; bottom:0; left:0; display:flex; flex-direction:column; gap:8px; max-height:min(78dvh,680px); padding:8px 16px max(18px,env(safe-area-inset-bottom)); overflow-y:auto; border-radius:22px 22px 0 0; background:var(--dsw-alias-bg-layer-2,#fff); box-shadow:0 -16px 44px rgb(15 23 42 / 16%); }
  .dsh-native-mobile-sheet[hidden] { display:none; }
  .dsh-native-mobile-sheet__header { position:sticky; z-index:1; top:-8px; display:flex; align-items:center; justify-content:space-between; min-height:48px; padding:8px 0; background:var(--dsw-alias-bg-layer-2,#fff); }
  .dsh-native-mobile-sheet__header strong { font-size:17px; font-weight:600; }
  .dsh-native-mobile-sheet__close { width:44px; height:44px; border:0; border-radius:12px; background:transparent; color:inherit; font-size:24px; }
  .dsh-native-mobile-sheet__path { margin:0 0 4px; overflow-wrap:anywhere; color:var(--dsw-alias-label-secondary,#6b7280); font-size:12px; }
  .dsh-native-mobile-sheet__choice { display:flex; flex-direction:column; align-items:flex-start; gap:2px; width:100%; min-height:56px; padding:10px 14px; border:1px solid var(--dsw-alias-border-subtle,#e2e6eb); border-radius:14px; background:var(--dsw-alias-bg-layer-2,#fff); color:inherit; text-align:left; }
  .dsh-native-mobile-sheet__choice:active { background:var(--dsw-alias-interactive-bg-hover,#f1f3f6); }
  .dsh-native-mobile-sheet__choice small { color:var(--dsw-alias-label-secondary,#6b7280); }
  .dsh-native-mobile-sheet__error { margin:4px 0; color:var(--dsw-alias-status-error,#b42318); font-size:13px; }
}
@media (max-width:420px) {
  [data-dsh-mobile-header] [class*="_headerActions"] { max-width:42vw; }
  [data-dsh-mobile-header] [class*="_titleRow"] { min-height:50px; }
}
@media (prefers-reduced-motion:reduce) {
  [data-dsh-mobile-sidebar-root],[data-dsh-mobile-details] { transition:none !important; }
}
`

function classToken(element: Element, suffix: string): boolean {
  return Array.from(element.classList).some(value => value.endsWith(suffix))
}

function firstByClassSuffix(root: ParentNode, suffix: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>('[class]')).find(element => classToken(element, suffix))
}

function composerCard(textarea: HTMLTextAreaElement): HTMLElement | undefined {
  let candidate: HTMLElement | null = textarea.parentElement
  while (candidate !== null && !classToken(candidate, '_card')) candidate = candidate.parentElement
  return candidate ?? undefined
}

function paperclipIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(namespace, 'path')
  path.setAttribute('d', 'm21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.7 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9')
  svg.append(path)
  return svg
}

/** Add mobile semantics to the stock DSH layout without replacing its React tree. */
export function installNativeMobileSurface(): () => void {
  document.documentElement.classList.add('dsh-native-mobile-active')
  const backdrop = document.createElement('button')
  backdrop.type = 'button'
  backdrop.className = 'dsh-native-mobile-backdrop'
  backdrop.hidden = true
  backdrop.setAttribute('aria-label', '关闭工作区导航')
  document.body.append(backdrop)
  let frame: HTMLElement | undefined
  let sidebar: HTMLElement | undefined
  let sidebarRoot: HTMLElement | undefined
  let toggle: HTMLButtonElement | undefined
  let scheduled = 0
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'image/*'
  fileInput.multiple = true
  fileInput.hidden = true
  fileInput.setAttribute('aria-hidden', 'true')
  const attach = document.createElement('button')
  attach.type = 'button'
  attach.className = 'dsh-native-mobile-attach'
  attach.setAttribute('aria-label', '添加图片')
  attach.setAttribute('title', '添加图片')
  attach.append(paperclipIcon())
  document.body.append(fileInput)
  const sheetMask = document.createElement('button')
  sheetMask.type = 'button'
  sheetMask.className = 'dsh-native-mobile-sheet-mask'
  sheetMask.hidden = true
  sheetMask.setAttribute('aria-label', '关闭图片选择')
  const sheet = document.createElement('section')
  sheet.className = 'dsh-native-mobile-sheet'
  sheet.hidden = true
  sheet.setAttribute('aria-label', '添加图片')
  document.body.append(sheetMask, sheet)

  const handFilesToComposer = (files: readonly File[]): void => {
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-dsh-mobile-center] textarea')
    if (textarea === null || files.length === 0) return
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: Object.freeze({
        files,
        items: Object.freeze(files.map(file => Object.freeze({
          kind: 'file',
          type: file.type,
          getAsFile: () => file,
        }))),
        getData: () => '',
      }),
    })
    textarea.dispatchEvent(paste)
  }

  const closeSheet = (): void => {
    sheet.hidden = true
    sheetMask.hidden = true
    sheet.replaceChildren()
  }
  const sheetHeader = (title: string): void => {
    const header = document.createElement('header')
    header.className = 'dsh-native-mobile-sheet__header'
    const heading = document.createElement('strong')
    heading.textContent = title
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'dsh-native-mobile-sheet__close'
    close.setAttribute('aria-label', '关闭')
    close.textContent = '×'
    close.addEventListener('click', closeSheet)
    header.append(heading, close)
    sheet.append(header)
  }
  const choice = (title: string, detail: string, action: () => void): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dsh-native-mobile-sheet__choice'
    const label = document.createElement('span')
    label.textContent = title
    const hint = document.createElement('small')
    hint.textContent = detail
    button.append(label, hint)
    button.addEventListener('click', action)
    return button
  }
  const showSheet = (): void => {
    sheet.hidden = false
    sheetMask.hidden = false
  }
  const openComputerImages = async (path?: string): Promise<void> => {
    sheet.replaceChildren()
    sheetHeader('电脑图片')
    const progress = document.createElement('p')
    progress.className = 'dsh-native-mobile-sheet__path'
    progress.textContent = '正在读取电脑目录…'
    sheet.append(progress)
    showSheet()
    try {
      const suffix = path === undefined ? '' : `?path=${encodeURIComponent(path)}`
      const response = await fetch(`/mobile-access/computer-images${suffix}`, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(`读取失败（${String(response.status)}）`)
      const listing = await response.json() as {
        readonly path: string
        readonly parent?: string
        readonly entries: readonly { readonly kind: 'directory' | 'image'; readonly name: string; readonly path: string }[]
      }
      progress.textContent = listing.path
      if (listing.parent !== undefined) sheet.append(choice('返回上一级', listing.parent, () => { void openComputerImages(listing.parent) }))
      for (const entry of listing.entries) {
        if (entry.kind === 'directory') {
          sheet.append(choice(entry.name, '文件夹', () => { void openComputerImages(entry.path) }))
          continue
        }
        const row = choice(entry.name, '添加这张电脑图片', () => {
          row.disabled = true
          void fetch(`/mobile-access/computer-image?path=${encodeURIComponent(entry.path)}`, { credentials: 'same-origin', cache: 'no-store' })
            .then(async response => {
              if (!response.ok) throw new Error(`读取失败（${String(response.status)}）`)
              const blob = await response.blob()
              handFilesToComposer([new File([blob], entry.name, { type: blob.type })])
              closeSheet()
            })
            .catch(error => {
              row.disabled = false
              progress.className = 'dsh-native-mobile-sheet__error'
              progress.textContent = error instanceof Error ? error.message : String(error)
            })
        })
        sheet.append(row)
      }
    } catch (error) {
      progress.className = 'dsh-native-mobile-sheet__error'
      progress.textContent = error instanceof Error ? error.message : String(error)
    }
  }
  const openAttachmentSources = (): void => {
    sheet.replaceChildren()
    sheetHeader('添加图片')
    sheet.append(
      choice('从手机选择', '相册、相机或手机存储', () => { closeSheet(); fileInput.click() }),
      choice('从电脑选择', '在手机页面浏览电脑中的图片', () => { void openComputerImages() }),
    )
    showSheet()
  }
  attach.addEventListener('click', openAttachmentSources)
  sheetMask.addEventListener('click', closeSheet)
  fileInput.addEventListener('change', () => {
    handFilesToComposer([...(fileInput.files ?? [])])
    fileInput.value = ''
  })

  const sync = (): void => {
    scheduled = 0
    frame = firstByClassSuffix(document, '_frame')
    if (frame === undefined) return
    frame.dataset.dshMobileFrame = 'true'
    sidebar = firstByClassSuffix(frame, '_sidebarCol')
    const center = firstByClassSuffix(frame, '_centerCol')
    const details = firstByClassSuffix(frame, '_detailsCol')
    const handle = firstByClassSuffix(frame, '_handle')
    if (center !== undefined) {
      center.dataset.dshMobileCenter = 'true'
      center.querySelector<HTMLElement>('header')?.setAttribute('data-dsh-mobile-header', 'true')
      const conversation = center.querySelector<HTMLElement>('[data-conversation-scroll]')
      const messageColumn = conversation === null ? undefined : firstByClassSuffix(conversation, '_column')
      const messageScroll = messageColumn?.parentElement
      if (messageColumn !== undefined && messageScroll !== null && messageScroll !== undefined && classToken(messageScroll, '_scroll')) {
        messageColumn.dataset.dshMobileMessageColumn = 'true'
        messageScroll.dataset.dshMobileMessageScroll = 'true'
      }
    }
    if (handle !== undefined) handle.dataset.dshMobileHandle = 'true'
    if (details !== undefined) {
      details.dataset.dshMobileDetails = 'true'
      const lastColumn = frame.style.gridTemplateColumns.trim().split(/\s+/).at(-1)
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
    const textarea = center?.querySelector<HTMLTextAreaElement>('textarea')
    const card = textarea === null || textarea === undefined ? undefined : composerCard(textarea)
    const tools = card === undefined ? undefined : firstByClassSuffix(card, '_tools')
    attach.disabled = textarea === undefined || textarea === null || textarea.disabled || textarea.readOnly
    if (tools !== undefined && attach.parentElement !== tools) tools.append(attach)
    if (sidebar === undefined) return
    sidebar.dataset.dshMobileSidebar = 'true'
    toggle = firstByClassSuffix(sidebar, '_toggle') as HTMLButtonElement | undefined
    let candidate = toggle?.parentElement
    while (candidate !== undefined && candidate !== null && candidate !== sidebar && !classToken(candidate, '_root')) candidate = candidate.parentElement
    sidebarRoot = candidate !== sidebar && candidate !== null ? candidate : undefined
    if (sidebarRoot === undefined) return
    sidebarRoot.dataset.dshMobileSidebarRoot = 'true'
    if (toggle !== undefined) toggle.dataset.dshMobileToggle = 'true'
    const collapsed = classToken(sidebarRoot, '_collapsed')
    sidebar.dataset.open = String(!collapsed)
    backdrop.hidden = collapsed
  }
  const schedule = (): void => { if (scheduled === 0) scheduled = requestAnimationFrame(sync) }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
  backdrop.addEventListener('click', () => { if (sidebar?.dataset.open === 'true') toggle?.click() })
  sync()
  return () => {
    observer.disconnect()
    if (scheduled !== 0) cancelAnimationFrame(scheduled)
    backdrop.remove()
    attach.remove()
    fileInput.remove()
    sheet.remove()
    sheetMask.remove()
    document.documentElement.classList.remove('dsh-native-mobile-active')
  }
}
