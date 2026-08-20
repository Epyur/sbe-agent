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

    new Setting(containerEl)
      .setName('Максимум шагов агента')
      .setDesc('Число вызовов инструментов за один ответ (по умолчанию 15). Увеличьте для сложных многошаговых задач.')
      .addText(text => text
        .setPlaceholder('15')
        .setValue(String(this.plugin.settings.maxIterations || 15))
        .onChange(async (value) => {
          const n = parseInt(value, 10);
          if (Number.isFinite(n) && n > 0 && n <= 100) {
            this.plugin.settings.maxIterations = n;
            await this.plugin.saveSettings();
          }
        }));

    const info = containerEl.createDiv({ cls: 'tn-ag-meta' });
    info.setText('Системный контекст агента можно редактировать в заметке yourbase/sbe_agent/agent_context.md. Источники данных и права отображаются в сайдбаре агента; доступ к данным — по ролям соответствующих плагинов.');
  }
}
