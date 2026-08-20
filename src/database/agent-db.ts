import { App } from 'obsidian';
import type { AgentDbData, Dialog, AgentMessage } from '../types/agent';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

const DB_DIR = 'yourbase/sbe_agent';
const DB_PATH = 'yourbase/sbe_agent/chat_history.json';

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
      await this.ensureDataDir();
      await this.app.vault.adapter.write(DB_PATH, JSON.stringify(this.data, null, 2));
    } catch (e: unknown) {
      console.error('LogicTEAM.007: не удалось сохранить историю:', errorMessage(e));
    }
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
    d.messages.push(message);
    d.updated_at = message.created_at;
    if (d.title === 'Новый диалог' && message.role === 'user') {
      const title = (message.content || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (title) d.title = title;
    }
  }
}
