/** Менеджер агент-браузера (2026-08-26): синглтон, управляющий встроенным в
 *  вьюху агента `<webview>`. Браузер живёт ВНУТРИ вьюхи агента (панель под чатом),
 *  а не в отдельной вкладке — так webview не разрушается при переключении вкладок
 *  (иначе: «Error invoking remote method GUEST_VIEW_MANAGER_CALL»). */

/** Минимальная поверхность `<webview>`, которой пользуется менеджер. */
export interface WebViewEl extends HTMLElement {
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  capturePage: () => Promise<{ toPNG: () => Uint8Array }>;
  getURL: () => string;
  getTitle: () => string;
}

/** Хост браузера (вьюха агента): создаёт webview по запросу и управляет бейджем ожидания. */
export interface BrowserHost {
  ensureWebview: () => WebViewEl;
  setWaiting: (active: boolean) => void;
}

class BrowserManager {
  private wv: WebViewEl | null = null;
  private host: BrowserHost | null = null;
  private domReadyWaiters: Array<() => void> = [];
  private userWaitResolvers: Array<() => void> = [];

  /** Вьюха агента регистрирует себя как хост браузера. */
  registerHost(host: BrowserHost | null): void {
    this.host = host;
    if (!host) {
      this.wv = null;
      this.resolveAll(this.userWaitResolvers);
      this.resolveAll(this.domReadyWaiters);
    }
  }

  private resolveAll(list: Array<() => void>): void {
    if (list.length === 0) return;
    const fns = list.splice(0);
    for (const f of fns) f();
  }

  private assertSupported(): void {
    if (!this.wv || typeof this.wv.executeJavaScript !== 'function') {
      throw new Error('Браузер агента недоступен: <webview> не поддерживается в этой сборке Obsidian.');
    }
  }

  async ensureOpen(): Promise<void> {
    if (this.wv) return;
    if (!this.host) throw new Error('Браузер агента недоступен: вьюха агента не инициализирована.');
    this.wv = this.host.ensureWebview();
    if (typeof this.wv.addEventListener !== 'function') {
      throw new Error('Браузер агента недоступен: <webview> не поддерживается в этой сборке Obsidian.');
    }
    this.wv.addEventListener('dom-ready', () => this.resolveAll(this.domReadyWaiters));
    this.resolveAll(this.domReadyWaiters);
    this.assertSupported();
  }

  private waitDomReady(timeoutMs = 30000): Promise<void> {
    return new Promise((resolve) => {
      const t = window.setTimeout(done, timeoutMs);
      function done(): void {
        window.clearTimeout(t);
        resolve();
      }
      this.domReadyWaiters.push(done);
    });
  }

  async open(url: string): Promise<void> {
    await this.ensureOpen();
    this.assertSupported();
    this.wv!.setAttribute('src', url);
    await this.waitDomReady();
  }

  async execJs<T>(code: string): Promise<T> {
    await this.ensureOpen();
    this.assertSupported();
    return (await this.wv!.executeJavaScript(code)) as T;
  }

  async extractText(): Promise<string> {
    const text = await this.execJs<string>('document.body ? document.body.innerText : ""');
    return (text || '').trim();
  }

  async links(): Promise<string[]> {
    const arr = await this.execJs<string[]>(
      'Array.from(document.querySelectorAll("a[href]")).map(a => (a as HTMLAnchorElement).href).filter(Boolean)',
    );
    return Array.isArray(arr) ? arr : [];
  }

  async screenshot(): Promise<Uint8Array> {
    await this.ensureOpen();
    this.assertSupported();
    const img = await this.wv!.capturePage();
    return img.toPNG();
  }

  /** Ждёт, пока пользователь не нажмёт «Продолжить» (вход/капча/действие на странице). */
  async waitForUser(timeoutMs = 600000): Promise<void> {
    await this.ensureOpen();
    this.host?.setWaiting(true);
    try {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          window.clearTimeout(t);
          resolve();
        };
        const t = window.setTimeout(finish, timeoutMs);
        this.userWaitResolvers.push(finish);
      });
    } finally {
      this.host?.setWaiting(false);
    }
  }

  notifyUserDone(): void {
    this.resolveAll(this.userWaitResolvers);
  }

  get currentUrl(): string {
    return this.wv ? this.wv.getURL() : '';
  }

  get currentTitle(): string {
    return this.wv ? this.wv.getTitle() : '';
  }
}

export const browserManager = new BrowserManager();
