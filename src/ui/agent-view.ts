import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type SbeAgentPlugin from '../main';
import type { Dialog, AgentMessage } from '../types/agent';
import { AgentEngine } from '../agent/agent-engine';
import { createTools, AgentAttachment } from '../agent/tools-registry';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

export const SBE_AGENT_VIEW_TYPE = 'sbe-agent-view';

export class AgentView extends ItemView {
  plugin: SbeAgentPlugin;
  private rootEl!: HTMLElement;
  private navEl!: HTMLElement;
  private dialogsEl!: HTMLElement;
  private sourcesEl!: HTMLElement;
  private collapseLabel!: HTMLElement;
  private pageTitleEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private chatEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private attachChipEl!: HTMLElement;
  private attachInput!: HTMLInputElement;
  private collapsed = false;
  private currentDialogId: string | null = null;
  private attachment: AgentAttachment | null = null;
  private running = false;
  private workingEl: HTMLElement | null = null;
  private workingStatusEl: HTMLElement | null = null;
  private workingStatusText = '';
  private engine: AgentEngine | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: SbeAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SBE_AGENT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'LogicTEAM.007';
  }

  getIcon(): string {
    return 'bot';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.addClass('tn-ag-container');
    this.rootEl = container.createDiv({ cls: 'tn-ag-app' });

    await this.plugin.refreshSources();
    this.buildShell();
    this.renderPage();
  }

  refresh(): void {
    this.renderPage();
  }

  // ---- Каркас ----

  private buildShell(): void {
    const topbar = this.rootEl.createDiv({ cls: 'tn-ag-topbar' });
    topbar.createDiv({ cls: 'tn-ag-module-title', text: 'LogicTEAM.007' });
    topbar.createDiv({ cls: 'tn-ag-crumb', text: 'Универсальный ИИ-агент' });
    const spacer = topbar.createDiv({ cls: 'tn-ag-spacer' });
    spacer.empty();
    const newBtn = topbar.createEl('button', { text: '＋ Новый диалог', cls: 'tn-ag-create' });
    newBtn.addEventListener('click', () => this.newDialog());

    const main = this.rootEl.createDiv({ cls: 'tn-ag-main' });
    const sidebar = main.createDiv({ cls: 'tn-ag-sidebar' });

    const collapseBtn = sidebar.createDiv({ cls: 'tn-ag-collapse' });
    collapseBtn.createSpan({ text: '▧' });
    this.collapseLabel = collapseBtn.createSpan({ cls: 'tn-ag-collapse-lbl', text: 'Свернуть' });
    collapseBtn.addEventListener('click', () => this.toggleCollapse());

    this.navEl = sidebar.createDiv({ cls: 'tn-ag-nav' });
    this.buildNav();

    const content = main.createDiv({ cls: 'tn-ag-content' });
    this.pageTitleEl = content.createEl('h1', { cls: 'tn-ag-page-title' });
    this.bodyEl = content.createDiv({ cls: 'tn-ag-body' });
  }

  private buildNav(): void {
    this.navEl.empty();

    const dialogsGroup = this.navEl.createEl('button', { cls: 'tn-ag-grp' });
    dialogsGroup.createSpan({ cls: 'tn-ag-grp-ico', text: '💬' });
    dialogsGroup.createSpan({ cls: 'tn-ag-grp-lbl', text: 'Диалоги' });
    dialogsGroup.createSpan({ cls: 'tn-ag-grp-chev', text: '▶' });
    dialogsGroup.addEventListener('click', () => {
      dialogsGroup.classList.toggle('open');
      dialogsGroup.classList.toggle('active');
    });
    dialogsGroup.classList.add('open', 'active');
    this.dialogsEl = this.navEl.createDiv({ cls: 'tn-ag-submenu tn-ag-dialogs-nav' });
    this.renderDialogs();

    const sourcesGroup = this.navEl.createEl('button', { cls: 'tn-ag-grp' });
    sourcesGroup.createSpan({ cls: 'tn-ag-grp-ico', text: '🗄️' });
    sourcesGroup.createSpan({ cls: 'tn-ag-grp-lbl', text: 'Источники' });
    sourcesGroup.createSpan({ cls: 'tn-ag-grp-chev', text: '▶' });
    sourcesGroup.addEventListener('click', () => {
      sourcesGroup.classList.toggle('open');
      sourcesGroup.classList.toggle('active');
    });
    sourcesGroup.classList.add('open');
    this.sourcesEl = this.navEl.createDiv({ cls: 'tn-ag-submenu tn-ag-sources-nav' });
    this.renderSources();
  }

  private renderDialogs(): void {
    this.dialogsEl.empty();
    const dialogs = this.plugin.agentDb.getDialogs();
    if (dialogs.length === 0) {
      this.dialogsEl.createDiv({ cls: 'tn-ag-nav-empty' }).setText('Диалогов нет');
      return;
    }
    for (const d of dialogs) {
      const item = this.dialogsEl.createEl('div', { cls: 'tn-ag-dialog-item' });
      item.classList.toggle('active', d.id === this.currentDialogId);
      const title = item.createDiv({ cls: 'tn-ag-dialog-title', text: d.title });
      title.addEventListener('click', () => {
        this.currentDialogId = d.id;
        this.renderDialogs();
        this.renderChat();
      });
      const del = item.createEl('button', { cls: 'tn-ag-dialog-del', text: '✖' });
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.plugin.agentDb.deleteDialog(d.id);
        if (this.currentDialogId === d.id) this.currentDialogId = null;
        void this.plugin.agentDb.save();
        this.renderDialogs();
        this.renderChat();
      });
    }
  }

  private renderSources(): void {
    this.sourcesEl.empty();
    const sources = this.plugin.getSources();
    for (const s of sources) {
      const row = this.sourcesEl.createEl('label', { cls: 'tn-ag-source' });
      const dot = row.createSpan({ cls: `tn-ag-source-dot ${s.available ? 'ok' : 'no'}` });
      dot.setText(s.available ? '●' : '○');
      const text = row.createSpan({ cls: 'tn-ag-source-name', text: s.name });
      const role = row.createSpan({ cls: 'tn-ag-source-role' });
      if (s.available && s.role) role.setText(s.role);
      else if (!s.available) role.setText('нет доступа');
    }
  }

  private toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.rootEl.classList.toggle('collapsed', this.collapsed);
    if (this.collapseLabel) {
      this.collapseLabel.setText(this.collapsed ? 'Развернуть' : 'Свернуть');
    }
  }

  // ---- Страница ----

  private renderPage(): void {
    if (!this.currentDialogId) {
      const first = this.plugin.agentDb.getDialogs()[0];
      if (first) this.currentDialogId = first.id;
    }
    if (!this.currentDialogId) {
      const d = this.plugin.agentDb.createDialog();
      this.currentDialogId = d.id;
      void this.plugin.agentDb.save();
    }
    this.renderDialogs();
    this.renderSources();
    this.renderChat();
  }

  private newDialog(): void {
    const d = this.plugin.agentDb.createDialog();
    this.currentDialogId = d.id;
    void this.plugin.agentDb.save();
    this.renderDialogs();
    this.renderChat();
  }

  private get currentDialog(): Dialog | null {
    return this.currentDialogId ? this.plugin.agentDb.getDialog(this.currentDialogId) || null : null;
  }

  // ---- Чат ----

  private renderChat(): void {
    const dialog = this.currentDialog;
    this.pageTitleEl.setText(dialog ? dialog.title : 'LogicTEAM.007');
    this.bodyEl.empty();

    if (!dialog) {
      this.bodyEl.createDiv({ cls: 'tn-ag-empty', text: 'Нет диалога' });
      return;
    }

    this.chatEl = this.bodyEl.createDiv({ cls: 'tn-ag-chat' });
    const messages = this.chatEl.createDiv({ cls: 'tn-ag-messages' });
    for (const m of dialog.messages) {
      this.renderMessage(messages, m);
    }

    // индикатор работы агента (что делает сейчас)
    this.workingEl = messages.createDiv({ cls: 'tn-ag-working' });
    const spinner = this.workingEl.createSpan({ cls: 'tn-ag-working-spin' });
    spinner.setText('');
    this.workingStatusEl = this.workingEl.createSpan({ cls: 'tn-ag-working-text' });
    this.workingEl.hidden = true;
    if (this.running) {
      this.workingEl.hidden = false;
      this.workingStatusEl.setText(this.workingStatusText || 'Агент думает…');
    }

    messages.scrollTop = messages.scrollHeight;
    this.scrollChatToBottom();

    const inputRow = this.bodyEl.createDiv({ cls: 'tn-ag-input-row' });
    this.attachChipEl = inputRow.createDiv({ cls: 'tn-ag-attach-chip' });
    this.attachChipEl.hidden = true;

    this.attachInput = inputRow.createEl('input', {
      attr: { type: 'file' },
      cls: 'tn-ag-file-input',
    });
    this.attachInput.style.display = 'none';

    const attachBtn = inputRow.createEl('button', { text: '📎', cls: 'tn-ag-attach-btn', attr: { title: 'Прикрепить файл' } });
    attachBtn.addEventListener('click', () => {
      this.attachInput.value = '';
      this.attachInput.click();
    });

    this.inputEl = inputRow.createEl('textarea', { cls: 'tn-ag-input' });
    this.inputEl.placeholder = 'Спросите агента… (например: «найди задачи по проекту X и сделай выгрузку в Excel»)';
    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void this.send();
      }
    });

    const sendBtn = inputRow.createEl('button', { text: '➤', cls: 'tn-ag-send-btn', attr: { title: 'Отправить' } });
    sendBtn.addEventListener('click', () => { void this.send(); });

    this.attachInput.addEventListener('change', () => {
      const file = this.attachInput.files && this.attachInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        this.attachment = { name: file.name, data: reader.result as ArrayBuffer };
        this.renderAttachChip();
      };
      reader.readAsArrayBuffer(file);
    });
  }

  private renderAttachChip(): void {
    if (!this.attachChipEl) return;
    this.attachChipEl.empty();
    if (!this.attachment) {
      this.attachChipEl.hidden = true;
      return;
    }
    this.attachChipEl.hidden = false;
    this.attachChipEl.createSpan({ text: `📎 ${this.attachment.name}` });
    const x = this.attachChipEl.createEl('button', { text: '✖', cls: 'tn-ag-chip-x' });
    x.addEventListener('click', () => {
      this.attachment = null;
      this.renderAttachChip();
    });
  }

  private renderMessage(container: HTMLElement, m: AgentMessage): void {
    if (m.role === 'tool') {
      const toolMsg = container.createDiv({ cls: `tn-ag-msg tn-ag-tool ${m.toolOk ? 'ok' : 'err'}` });
      const head = toolMsg.createDiv({ cls: 'tn-ag-tool-head' });
      head.createDiv({ cls: 'tn-ag-tool-label' }).setText(`${m.toolOk ? '🛠' : '⚠'} ${m.tool || 'тул'} ${m.toolOk ? '' : '(ошибка)'}`);
      if (m.link) {
        const a = head.createEl('a', { cls: 'tn-ag-download', attr: { href: m.link.url, target: '_blank', rel: 'noopener' } });
        a.setText(m.link.label);
      }
      const pre = toolMsg.createEl('pre', { cls: 'tn-ag-tool-text' });
      pre.setText(m.content);
      this.renderCopyBtn(toolMsg, m.content);
      return;
    }
    const msg = container.createDiv({ cls: `tn-ag-msg ${m.role === 'user' ? 'user' : 'assistant'}` });
    const textEl = msg.createDiv({ cls: 'tn-ag-msg-text' });
    this.renderTextWithLinks(textEl, m.content);
    if (m.role === 'assistant') {
      this.renderCopyBtn(msg, m.content);
    }
    if (m.files && m.files.length > 0) {
      msg.createDiv({ cls: 'tn-ag-msg-files' }).setText(`📎 ${m.files.join(', ')}`);
    }
  }

  private URL_RE = /https?:\/\/[^\s<>"']+/g;

  /** Рендерит текст с активными ссылками (без innerHTML и без MarkdownRenderer).
   *  Для S3-ссылок на сгенерированные файлы показывает короткий ярлык «⬇ Скачать файл …». */
  private renderTextWithLinks(container: HTMLElement, text: string): void {
    const parts = text.split(this.URL_RE);
    const urls = text.match(this.URL_RE) || [];
    let idx = 0;
    for (const part of parts) {
      if (part) {
        container.createSpan().setText(part);
      }
      if (idx < urls.length) {
        let url = urls[idx];
        url = url.replace(/[.,;:!?)]+$/, '');
        const a = container.createEl('a', { attr: { href: url, target: '_blank', rel: 'noopener' } });
        a.setText(this.linkLabel(url));
        idx++;
      }
    }
  }

  private linkLabel(url: string): string {
    const fmtMatch = url.match(/\.(docx|xlsx|pdf|json)(?:\?|$)/);
    if (fmtMatch) {
      const fmt = { docx: 'Word', xlsx: 'Excel', pdf: 'PDF', json: 'JSON' }[fmtMatch[1] as 'docx' | 'xlsx' | 'pdf' | 'json'];
      return `⬇ Скачать файл ${fmt}`;
    }
    if (url.length > 60) {
      return url.slice(0, 60) + '…';
    }
    return url;
  }

  private renderCopyBtn(parent: HTMLElement, text: string): void {
    const btn = parent.createEl('button', { cls: 'tn-ag-copy', attr: { title: 'Копировать' } });
    btn.setText('⧉');
    btn.addEventListener('click', () => { void this.copyText(text); });
  }

  private async copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice('Скопировано в буфер обмена');
    } catch (e: unknown) {
      // fallback для окружений без clipboard API
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        new Notice('Скопировано в буфер обмена');
      } catch (e2: unknown) {
        new Notice(`Не удалось скопировать: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private addMessage(message: AgentMessage): void {
    const dialog = this.currentDialog;
    if (!dialog) return;
    this.plugin.agentDb.addMessage(dialog.id, message);
    void this.plugin.agentDb.save();
    this.renderDialogs();
    this.renderChat();
    this.scrollChatToBottom();
  }

  /** Прокрутка чата к последнему сообщению (после отрисовки и layout). */
  private scrollChatToBottom(): void {
    const target = (this.chatEl?.querySelector('.tn-ag-messages') as HTMLElement | null) ?? this.chatEl ?? null;
    if (!target) return;
    window.requestAnimationFrame(() => {
      target.scrollTop = target.scrollHeight;
      window.requestAnimationFrame(() => {
        target.scrollTop = target.scrollHeight;
      });
    });
  }

  private async getEngine(): Promise<AgentEngine | null> {
    if (this.engine) return this.engine;
    try {
      const llm = await this.plugin.getLlm();
      this.engine = new AgentEngine(
        {
          complete: (system, user, opts) => llm.complete(system, user, opts),
          completeJson: (system, user, opts) => llm.completeJson(system, user, opts),
        },
        createTools(),
        this.plugin.buildToolContext(),
        this.plugin.settings.maxIterations || 15,
      );
      return this.engine;
    } catch (e: unknown) {
      new Notice(`Агент недоступен: ${errorMessage(e)}. Установите и включите плагин sbe-llm.`);
      return null;
    }
  }

  private async send(): Promise<void> {
    if (this.running) return;
    const text = this.inputEl ? this.inputEl.value.trim() : '';
    if (!text && !this.attachment) {
      new Notice('Введите сообщение или прикрепите файл');
      return;
    }

    const engine = await this.getEngine();
    if (!engine) return;

    this.running = true;
    const files = this.attachment ? [this.attachment.name] : undefined;
    this.addMessage({ role: 'user', content: text || '(файл прикреплён)', files, created_at: new Date().toISOString() });
    const attachment = this.attachment;
    this.attachment = null;
    this.renderAttachChip();
    if (this.inputEl) this.inputEl.value = '';

    try {
      this.workingStatusText = 'Агент думает…';
      this.showWorking(this.workingStatusText);
      await engine.run({
        dialog: this.currentDialog as Dialog,
        userMessage: text,
        attachment,
        model: this.plugin.settings.model || undefined,
        onProgress: (status) => {
          this.workingStatusText = status;
          this.showWorking(status);
        },
        onToolResult: (message) => this.addMessage(message),
        onAssistant: (text2) => {
          this.finishWorking();
          this.addMessage({ role: 'assistant', content: text2, created_at: new Date().toISOString() });
        },
      });
    } catch (e: unknown) {
      this.finishWorking();
      new Notice(`Ошибка агента: ${e instanceof Error ? e.message : String(e)}`);
      this.addMessage({ role: 'assistant', content: `Ошибка: ${e instanceof Error ? e.message : String(e)}`, created_at: new Date().toISOString() });
    } finally {
      this.finishWorking();
    }
  }

  private showWorking(status: string): void {
    this.workingStatusText = status;
    if (this.workingEl) {
      this.workingEl.hidden = false;
      if (this.workingStatusEl) this.workingStatusEl.setText(status);
    }
    this.scrollChatToBottom();
  }

  private finishWorking(): void {
    this.running = false;
    if (this.workingEl) this.workingEl.hidden = true;
    this.scrollChatToBottom();
  }
}
