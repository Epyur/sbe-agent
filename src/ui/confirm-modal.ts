import { App, Modal, Setting } from 'obsidian';

/** Модалка подтверждения для операций, требующих явного согласия пользователя
 *  (например, установка скила из непроверенного источника — вариант B ревью B6). */
export class ConfirmModal extends Modal {
  private message: string;
  private confirmLabel: string;
  private onResult: (ok: boolean) => void;

  constructor(app: App, message: string, confirmLabel: string, onResult: (ok: boolean) => void) {
    super(app);
    this.message = message;
    this.confirmLabel = confirmLabel;
    this.onResult = onResult;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Подтверждение' });
    contentEl.createDiv({ text: this.message });
    new Setting(contentEl)
      .addButton(btn => btn.setButtonText('Отмена').onClick(() => {
        this.onResult(false);
        this.close();
      }))
      .addButton(btn => btn.setButtonText(this.confirmLabel).setCta().onClick(() => {
        this.onResult(true);
        this.close();
      }));
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
