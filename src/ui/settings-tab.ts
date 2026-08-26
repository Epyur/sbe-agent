import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type SbeAgentPlugin from '../main';
import { request } from '../agent/http';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import { listGlobalSkills, GlobalSkillFile } from '../agent/skills-service';
import { parseSkillDescription } from '../agent/tools/skills-tools';

export class AgentSettingsTab extends PluginSettingTab {
  plugin: SbeAgentPlugin;
  private globalSkillsEl: HTMLElement | null = null;

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
      .setDesc('Число вызовов инструментов за один ответ (по умолчанию 15). Увеличьте для сложных многошаговых задач, например полнотекстового чтения больших документов.')
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

    // Глобальные скилы — только администратор agent (Блок B6, белый список).
    void this.renderGlobalSkills();
  }

  private async isAgentAdmin(): Promise<boolean> {
    try {
      const token = await this.plugin.buildToolContext().getToken('agent');
      const res = await request({
        url: `${this.plugin.settings.apiUrl}/api/agent/permissions/me`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }, 30000);
      if (res.status !== 200) return false;
      const me = JSON.parse(res.text) as { role?: string };
      return me.role === 'admin';
    } catch (e: unknown) {
      console.warn('LogicTEAM.007: не удалось проверить роль администратора:', errorMessage(e));
      return false;
    }
  }

  private async renderGlobalSkills(): Promise<void> {
    if (!(await this.isAgentAdmin())) return;
    const { containerEl } = this;
    if (this.globalSkillsEl) this.globalSkillsEl.remove();
    const el = containerEl.createDiv();
    this.globalSkillsEl = el;

    new Setting(el)
      .setHeading()
      .setName('Глобальные скилы')
      .setDesc('Утверждённые администратором скилы (белый список): хранятся на сервере, агент использует их без скачивания с GitHub; при установке такого скила подтверждение не запрашивается.');

    let pathInput = '';
    new Setting(el)
      .setName('Загрузить скил на сервер')
      .setDesc('Путь к папке скила в вольте (должна содержать SKILL.md). Имя скила — имя папки (латиницей).')
      .addText(text => text
        .setPlaceholder('yourbase/sbe_agent/skills/my-skill')
        .onChange(v => { pathInput = v.trim(); }))
      .addButton(btn => btn.setButtonText('Загрузить').setCta().onClick(async () => {
        const err = await this.uploadGlobalSkill(pathInput);
        if (err) {
          new Notice(`Ошибка загрузки скила: ${err}`);
        } else {
          new Notice('Скил загружен на сервер.');
        }
        await this.renderGlobalSkillsList();
      }));

    new Setting(el)
      .setName('Загрузить все локальные скилы')
      .setDesc('Просканирует yourbase/sbe_agent/skills/ и зальёт на сервер каждую папку с SKILL.md (существующие глобальные скилы перезапишет).')
      .addButton(btn => btn.setButtonText('Загрузить все').setCta().onClick(async () => {
        await this.uploadAllLocalSkills();
      }));

    await this.renderGlobalSkillsList();
  }

  /** Заливает на сервер ВСЕ локальные скилы (папки с SKILL.md в skills/). */
  private async uploadAllLocalSkills(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      const skillsRoot = 'yourbase/sbe_agent/skills';
      if (!(await adapter.exists(skillsRoot))) {
        new Notice('Папка yourbase/sbe_agent/skills не найдена.');
        return;
      }
      const listed = await adapter.list(skillsRoot);
      const ok: string[] = [];
      const fail: string[] = [];
      for (const folder of listed.folders) {
        const skillMd = `${folder}/SKILL.md`;
        if (!(await adapter.exists(skillMd))) continue;
        const name = folder.split('/').pop() || '';
        const err = await this.uploadGlobalSkill(folder);
        if (err) fail.push(`${name}: ${err}`);
        else ok.push(name);
      }
      new Notice(`Загружено на сервер: ${ok.length}${fail.length ? `; ошибки: ${fail.join('; ')}` : ''}.`);
      await this.renderGlobalSkillsList();
    } catch (e: unknown) {
      new Notice(`Ошибка загрузки: ${errorMessage(e)}`);
    }
  }

  private async renderGlobalSkillsList(): Promise<void> {
    if (!this.globalSkillsEl) return;
    const old = this.globalSkillsEl.querySelector('.tn-ag-skill-list');
    if (old) old.remove();
    const listEl = this.globalSkillsEl.createDiv({ cls: 'tn-ag-skill-list' });
    const skills = await listGlobalSkills(this.plugin.buildToolContext());
    if (skills.length === 0) {
      listEl.createDiv({ text: 'Глобальных скилов пока нет.', cls: 'tn-ag-meta' });
      return;
    }
    for (const s of skills) {
      const row = listEl.createDiv({ cls: 'tn-ag-skill-row' });
      row.createSpan({ text: `${s.name}${s.description ? ` — ${s.description}` : ''}` });
      const del = row.createEl('button', { text: '✖', cls: 'tn-ag-icon-btn' });
      del.setAttribute('aria-label', `Удалить глобальный скил ${s.name}`);
      del.addEventListener('click', () => void this.deleteGlobalSkill(s.name));
    }
  }

  private async uploadGlobalSkill(folderPath: string): Promise<string> {
    const path = (folderPath || '').trim().replace(/\/+$/, '');
    if (!path) return 'Укажите путь к папке скила';
    const name = (path.split('/').pop() || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return 'Имя папки некорректно (латиница/цифры/._-)';
    const adapter = this.app.vault.adapter;
    const skillMd = `${path}/SKILL.md`;
    try {
      if (!(await adapter.exists(skillMd))) return `В папке нет SKILL.md: ${skillMd}`;
      const content = await adapter.read(skillMd);
      const files: GlobalSkillFile[] = [];
      const listed = await adapter.list(path);
      let total = content.length;
      for (const f of listed.files) {
        const fn = (f.split('/').pop() || '').trim();
        if (!fn || fn.toLowerCase() === 'skill.md') continue;
        if (files.length >= 50) break;
        const fileContent = await adapter.read(f);
        total += fileContent.length;
        if (total > 8 * 1024 * 1024) return 'Скил слишком большой (суммарно более 8 МБ)';
        files.push({ name: fn, content: fileContent });
      }
      const token = await this.plugin.buildToolContext().getToken('agent');
      const res = await request({
        url: `${this.plugin.settings.apiUrl}/api/agent/skills`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, description: parseSkillDescription(content), content, files }),
      }, 30000);
      if (res.status !== 200) {
        let msg = `HTTP ${res.status}`;
        try { msg = (JSON.parse(res.text) as { error?: string }).error || msg; } catch { /* ignore */ }
        return msg;
      }
      return '';
    } catch (e: unknown) {
      return errorMessage(e);
    }
  }

  private async deleteGlobalSkill(name: string): Promise<void> {
    try {
      const token = await this.plugin.buildToolContext().getToken('agent');
      await request({
        url: `${this.plugin.settings.apiUrl}/api/agent/skills/${encodeURIComponent(name)}`,
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }, 30000);
    } catch (e: unknown) {
      new Notice(`Ошибка удаления скила: ${errorMessage(e)}`);
    }
    await this.renderGlobalSkillsList();
  }
}
