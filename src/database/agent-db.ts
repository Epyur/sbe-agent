import { App } from 'obsidian';
import type { AgentDbData, Dialog, AgentMessage } from '../types/agent';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

const DB_DIR = 'yourbase/sbe_agent';
const DB_PATH = 'yourbase/sbe_agent/chat_history.json';

/** Лимиты истории: глубина по диалогам и возраст (ревью безопасности 2026-08-25, п. B1). */
const MAX_DIALOGS = 100;
const RETENTION_DAYS = 90;

/** Подписанные S3-ссылки содержат ключ доступа — в историю не попадают. */
const SIGNED_URL_RE = /https?:\/\/[^\s"'<>]*(?:X-Amz-Signature|[?&]sig=)[^\s"'<>]*/gi;

/** Убирает из текста подписанную часть S3-ссылок (?X-Amz-…). */
function sanitizeForHistory(text: string): string {
  return (text || '').replace(SIGNED_URL_RE, (m) => `${m.split('?')[0]}?…`);
}

/** Локальная история диалогов агента. */
export class AgentDatabase {
  private app: App;
  private data: AgentDbData = { dialogs: [] };

  constructor(app: App) {
    this.app = app;
  }

  async init(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(DB_PATH);
      if (exists) {
        const parsed = JSON.parse(await adapter.read(DB_PATH)) as Partial<AgentDbData>;
        this.data = {
          dialogs: Array.isArray(parsed.dialogs) ? parsed.dialogs : [],
        };
      }
    } catch (e: unknown) {
      console.error('LogicTEAM.007: не удалось прочитать историю:', errorMessage(e));
    }
  }

  private async ensureDataDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(DB_DIR);
    if (!exists) {
      await adapter.mkdir(DB_DIR);
    }
  }

  async save(): Promise<void> {
    try {
      this.prune();
      await this.ensureDataDir();
      // Подписанные ссылки (ключ доступа + срок жизни ~48 ч) в файл истории не пишутся.
      const payload: AgentDbData = {
        dialogs: this.data.dialogs.map((d) => ({
          ...d,
          messages: d.messages.map(({ link, ...rest }) => rest as AgentMessage),
        })),
      };
      await this.app.vault.adapter.write(DB_PATH, JSON.stringify(payload, null, 2));
    } catch (e: unknown) {
      console.error('LogicTEAM.007: не удалось сохранить историю:', errorMessage(e));
    }
  }

  /** Ограничение истории: диалоги старше RETENTION_DAYS удаляются, хвост ограничен MAX_DIALOGS. */
  private prune(): void {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    this.data.dialogs = this.data.dialogs
      .filter((d) => new Date(d.updated_at || d.created_at || 0).getTime() >= cutoff)
      .slice(0, MAX_DIALOGS);
  }

  getDialogs(): Dialog[] {
    return this.data.dialogs;
  }

  getDialog(id: string): Dialog | undefined {
    return this.data.dialogs.find(d => d.id === id);
  }

  /** Новый пустой диалог. */
  createDialog(): Dialog {
    const now = new Date().toISOString();
    const dialog: Dialog = {
      id: 'd' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      title: 'Новый диалог',
      messages: [],
      created_at: now,
      updated_at: now,
    };
    this.data.dialogs.unshift(dialog);
    return dialog;
  }

  deleteDialog(id: string): void {
    this.data.dialogs = this.data.dialogs.filter(d => d.id !== id);
  }

  addMessage(dialogId: string, message: AgentMessage): void {
    const d = this.getDialog(dialogId);
    if (!d) return;
    // Подписанные S3-ссылки в контенте маскируются (срок жизни ~48 ч + ключ в подписи).
    const stored: AgentMessage = { ...message, content: sanitizeForHistory(message.content || '') };
    d.messages.push(stored);
    d.updated_at = stored.created_at;
    if (d.title === 'Новый диалог' && stored.role === 'user') {
      const title = (stored.content || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (title) d.title = title;
    }
  }
}
