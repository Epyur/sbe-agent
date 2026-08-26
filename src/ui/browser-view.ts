import { ItemView, WorkspaceLeaf } from 'obsidian';
import { browserManager, WebViewEl } from '../agent/browser-manager';

export const BROWSER_VIEW_TYPE = 'sbe-agent-browser-view';

/** Вкладка агент-браузера: внутренний <webview> (partition persist:agent).
 *  Открывается только агентом (тулы browser_*); ручной навигации нет. */
export class BrowserView extends ItemView {
  private frame: WebViewEl | null = null;
  private waitBanner: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return BROWSER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Агент: браузер';
  }

  getIcon(): string {
    return 'globe';
  }

  async onOpen(): Promise<void> {
    browserManager.setView(this);
    this.contentEl.empty();
    this.contentEl.addClass('tn-ag-browser');

    // Бейдж ожидания: агент ждёт действия пользователя (вход/капча/действие).
    this.waitBanner = this.contentEl.createDiv({ cls: 'tn-ag-browser-wait' });
    this.waitBanner.createSpan({ text: '⏳ Агент ждёт вашего действия в браузере. Выполните вход/действие и нажмите «Продолжить».' });
    const cont = this.waitBanner.createEl('button', { text: 'Продолжить', cls: 'tn-btn tn-btn-primary' });
    cont.addEventListener('click', () => browserManager.notifyUserDone());
    this.waitBanner.hide();

    // Webview.
    const wv = document.createElement('webview') as unknown as WebViewEl;
    wv.setAttribute('partition', 'persist:agent');
    wv.setAttribute('allowpopups', '');
    wv.addClass('tn-ag-browser-frame');
    this.contentEl.appendChild(wv);
    this.frame = wv;
    browserManager.attachWebview(wv);
  }

  /** Включает/выключает бейдж ожидания (по вызову browser_wait). */
  setWaiting(active: boolean): void {
    if (!this.waitBanner) return;
    if (active) {
      this.waitBanner.show();
    } else {
      this.waitBanner.hide();
    }
  }

  async onClose(): Promise<void> {
    browserManager.setView(null);
    browserManager.detachWebview();
    this.contentEl.empty();
    this.frame = null;
    this.waitBanner = null;
    return super.onClose();
  }
}
