import { App, PluginSettingTab, Setting } from 'obsidian';
import type SbeAgentPlugin from '../main';

export class AgentSettingsTab extends PluginSettingTab {
  plugin: SbeAgentPlugin;

  constructor(app: App, plugin: SbeAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setHeading()
      .setName('Сервер');

    new Setting(containerEl)
      .setName('Адрес сервера (apiUrl)')
      .setDesc('База URL agent-service и plugin-services, например https://epyur.fvds.ru. JWT берётся из ЦУП СБЕ.')
      .addText(text => text
        .setPlaceholder('https://epyur.fvds.ru')
        .setValue(this.plugin.settings.apiUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setHeading()
      .setName('Агент');

    new Setting(containerEl)
      .setName('Имя пользователя')
      .setDesc('Используется в контексте агента (например, «Помощник Иванова И.И.»). По умолчанию пусто.')
      .addText(text => text
        .setPlaceholder('И.И. Иванов')
        .setValue(this.plugin.settings.userName)
        .onChange(async (value) => {
          this.plugin.settings.userName = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Модель LLM')
      .setDesc('Модель агента. Пусто — используется модель по умолчанию центра sbe-llm.')
      .addText(text => text
        .setPlaceholder('(по умолчанию sbe-llm)')
        .setValue(this.plugin.settings.model)
        .onChange(async (value) => {
          this.plugin.settings.model = value.trim();
          await this.plugin.saveSettings();
        }));

    const info = containerEl.createDiv({ cls: 'tn-ag-meta' });
    info.setText('Источники данных и права отображаются в сайдбаре агента. Доступ к данным — по ролям соответствующих плагинов (сервер проверяет JWT).');
  }
}
