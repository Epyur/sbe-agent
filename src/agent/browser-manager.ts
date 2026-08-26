/** Менеджер агент-браузера (MVP, 2026-08-26): синглтон, управляющий вкладкой
 *  браузера агента (внутренний `<webview>` Obsidian). Вкладка живёт в sbe-agent
 *  и открывается ТОЛЬКО агентом (тулы browser_*). */

/** Минимальная поверхность `<webview>`, которой пользуется менеджер. */
export interface WebViewEl extends HTMLElement {
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  capturePage: () => Promise<{ toPNG: () => Uint8Array }>;
  getURL: () => string;
  getTitle: () => string;
}

/** Вкладка браузера, как её видит менеджер (без циклической зависимости). */
export interface BrowserViewLike {
  setWaiting(active: boolean): void;
}

class BrowserManager {
  private wv: WebViewEl | null = null;
  private view: BrowserViewLike | null = null;
  private activateFn: (() => Promise<void>) | null = null;
  private domReadyWaiters: Array<() => void> = [];
  private userWaitResolvers: Array<() => void> = [];

  init(opts: { activate: () => Promise<void> }): void {
    this.activateFn = opts.activate;
  }

  setView(view: BrowserViewLike | null): void {
    this.view = view;
  }

  /** Вызывается BrowserView.onOpen после создания <webview>. */
  attachWebview(wv: WebViewEl): void {
    this.wv = wv;
    wv.addEventListener('dom-ready', () => this.resolveAll(this.domReadyWaiters));
    this.resolveAll(this.domReadyWaiters);
  }

  detachWebview(): void {
    this.wv = null;
    // не вешаем ожидающие вызовы (browser_wait и т.п.)
    this.resolveAll(this.userWaitResolvers);
    this.resolveAll(this.domReadyWaiters);
  }

  private resolveAll(list: Array<() => void>): void {
    if (list.length === 0) return;
    const fns = list.splice(0);
    for (const f of fns) f();
  }

  private assertSupported(): void {
    if (!this.wv || typeof this.wv.executeJavaScript !== 'function') {
      throw new Error('Вкладка браузера недоступна: <webview> не поддерживается в этой сборке Obsidian.');
    }
  }

  async ensureOpen(): Promise<void> {
    if (this.wv) return;
    if (this.activateFn) await this.activateFn();
    await new Promise<void>((resolve) => {
      if (this.wv) return resolve();
      const iv = window.setInterval(() => {
        if (this.wv) {
          window.clearInterval(iv);
          resolve();
        }
      }, 200);
      window.setTimeout(() => {
        window.clearInterval(iv);
        resolve();
      }, 15000);
    });
    if (!this.wv) {
      throw new Error('Вкладка браузера не открылась (webview недоступен в этой сборке Obsidian).');
    }
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
    this.view?.setWaiting(true);
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
      this.view?.setWaiting(false);
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
