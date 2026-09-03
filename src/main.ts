import { Plugin, WorkspaceLeaf } from 'obsidian';
import { AgentDatabase } from './database/agent-db';
import { AgentView, SBE_AGENT_VIEW_TYPE } from './ui/agent-view';
import { AgentSettingsTab } from './ui/settings-tab';
import { ConfirmModal } from './ui/confirm-modal';
import { publishService, unpublishService, getService } from '../../sbe-core/src/bridge';
import type { SbeAgentApi, SbeLlmApi, SbeApstoreApi } from '../../sbe-core/src/types';
import type { SourceAvailability } from './types/agent';
import { AgentToolContext, AgentAttachment, createTools } from './agent/tools-registry';
import { SYSTEM_PROMPT_PATH, SYSTEM_PROMPT_TEMPLATE } from './agent/system-prompt';
import { request, assertOk } from './agent/http';
import { errorMessage } from '../../sbe-core/src/utils/errors';

export interface SbeAgentSettings {
  apiUrl: string;
  userName: string;
  model: string;
  /** Максимальное число шагов агента (вызовов тулов за один ответ). */
  maxIterations: number;
  /** Версия, для которой уже опубликована новость в «Новости» ЦУП. */
  lastAnnouncedVersion: string;
}

const DEFAULT_SETTINGS: SbeAgentSettings = {
  apiUrl: 'https://epyur.fvds.ru',
  userName: '',
  model: '',
  maxIterations: 15,
  lastAnnouncedVersion: '',
};

const SOURCE_DEFS: Array<{ appId: string; name: string }> = [
  { appId: 'mailer', name: 'Письма' },
  { appId: 'documents', name: 'Документы' },
  { appId: 'contacts', name: 'Контакты' },
  { appId: 'lab', name: 'ЛИМС' },
  { appId: 'photo', name: 'Фотобанк' },
];

export default class SbeAgentPlugin extends Plugin {
  settings!: SbeAgentSettings;
  agentDb!: AgentDatabase;
  private userEmail = '';
  private sources: SourceAvailability[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();
    this.agentDb = new AgentDatabase(this.app);
    await this.agentDb.init();
    await this.ensureSystemPromptFile();

    try {
      const apstore = await getService('sbe-apstore');
      const status = apstore.auth.getStatus();
      this.userEmail = (status.email || '').trim();
    } catch (e: unknown) {
      console.warn('LogicTEAM.007: не удалось получить email из ЦУП:', errorMessage(e));
    }

    this.registerView(
      SBE_AGENT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new AgentView(leaf, this),
    );

    this.addSettingTab(new AgentSettingsTab(this.app, this));

    publishService<SbeAgentApi>('sbe-agent', {
      open: async () => {
        await this.activateView();
      },
    }, {
      version: this.manifest.version,
      name: this.manifest.name,
    });

    // Новость об обновлении — один раз на версию (канал «Новости» ЦУП).
    void this.announceOnce();
  }

  onunload(): void {
    unpublishService('sbe-agent');
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData() as Partial<SbeAgentSettings>) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(SBE_AGENT_VIEW_TYPE)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeaf(false);
    await leaf.setViewState({ type: SBE_AGENT_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  getEmail(): string {
    return this.userEmail;
  }

  /** Контекст тулов: доступ к данным через JWT пользователя (права проверяет сервер). */
  buildToolContext(): AgentToolContext {
    return {
      getApiUrl: () => this.settings.apiUrl,
      getToken: async (appId: string) => {
        const apstore = await getService('sbe-apstore');
        return apstore.auth.getToken(appId);
      },
      getEmail: () => this.getEmail(),
      getUserName: () => this.settings.userName,
      getSources: () => this.sources,
      readVaultText: async (path: string) => this.app.vault.adapter.read(path),
      writeVaultFile: async (path: string, data: ArrayBuffer | string) => {
        await this.ensureVaultDir(path.substring(0, path.lastIndexOf('/')));
        const adapter = this.app.vault.adapter;
        if (typeof data === 'string') {
          await adapter.write(path, data);
        } else {
          await adapter.writeBinary(path, data);
        }
      },
      listVaultDir: async (path: string) => {
        const adapter = this.app.vault.adapter;
        try {
          if (!(await adapter.exists(path))) return [];
          const listed = await adapter.list(path);
          return listed.files;
        } catch (e: unknown) {
          console.warn('LogicTEAM.007: listVaultDir error:', errorMessage(e));
          return [];
        }
      },
      listVaultTree: async (path: string) => {
        const adapter = this.app.vault.adapter;
        const out: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          try {
            if (!(await adapter.exists(dir))) return;
            const listed = await adapter.list(dir);
            out.push(...listed.files);
            for (const folder of listed.folders) {
              await walk(folder);
            }
          } catch (e: unknown) {
            console.warn('LogicTEAM.007: listVaultTree error:', errorMessage(e));
          }
        };
        await walk(path);
        return out;
      },
      vaultExists: async (path: string) => {
        try {
          return await this.app.vault.adapter.exists(path);
        } catch (e: unknown) {
          console.warn('LogicTEAM.007: vaultExists error:', errorMessage(e));
          return false;
        }
      },
      confirmUser: (message: string) => {
        return new Promise<boolean>((resolve) => {
          const modal = new ConfirmModal(this.app, message, 'Установить', resolve);
          modal.open();
        });
      },
    };
  }

  /** Создаёт файл контекста агента в вольте, если его ещё нет (редактируется пользователем). */
  private async ensureSystemPromptFile(): Promise<void> {
    const ctx = this.buildToolContext();
    try {
      if (!(await ctx.vaultExists(SYSTEM_PROMPT_PATH))) {
        await ctx.writeVaultFile(SYSTEM_PROMPT_PATH, SYSTEM_PROMPT_TEMPLATE);
        console.log(`LogicTEAM.007: создан редактируемый контекст агента: ${SYSTEM_PROMPT_PATH}`);
      }
    } catch (e: unknown) {
      console.warn('LogicTEAM.007: не удалось создать контекст агента:', errorMessage(e));
    }
  }

  private async ensureVaultDir(dirPath: string): Promise<void> {    const adapter = this.app.vault.adapter;
    const parts = (dirPath || '').split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      try {
        if (!(await adapter.exists(cur))) {
          await adapter.mkdir(cur);
        }
      } catch (e: unknown) {
        console.warn('LogicTEAM.007: ensureVaultDir error:', errorMessage(e));
      }
    }
  }

  /** LLM из центра sbe-llm (completeJson для JSON-протокола тулов, complete — сырой текст). */
  async getLlm(): Promise<Pick<SbeLlmApi, 'complete' | 'completeJson'>> {
    return getService('sbe-llm');
  }

  /** Доступность источников по правам пользователя (permissions/me каждого app). */
  async refreshSources(): Promise<void> {
    const list: SourceAvailability[] = [
      { appId: 'tasks', name: 'Задачи', available: true, role: 'локально' },
    ];
    for (const def of SOURCE_DEFS) {
      try {
        const token = await getService('sbe-apstore').then(a => a.auth.getToken(def.appId));
        const res = await request({
          url: `${this.settings.apiUrl}/api/${def.appId}/permissions/me`,
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        }, 30000);
        assertOk(res, def.name);
        const me = JSON.parse(res.text) as { role: string; hasAccess: boolean };
        list.push({
          appId: def.appId,
          name: def.name,
          available: !!me.hasAccess,
          role: me.role || '',
        });
      } catch (e: unknown) {
        console.warn(`LogicTEAM.007: источник ${def.appId} недоступен:`, errorMessage(e));
        list.push({ appId: def.appId, name: def.name, available: false, role: '' });
      }
    }
    this.sources = list;
  }

  getSources(): SourceAvailability[] {
    return this.sources;
  }

  /** Публикация новости в канал «Новости» ЦУП — один раз на версию. */
  private async announceOnce(): Promise<void> {
    if (this.settings.lastAnnouncedVersion === this.manifest.version) return;
    try {
      const apstore = await getService('sbe-apstore');
      await apstore.announceUpdate({
        appId: this.manifest.id,
        appName: this.manifest.name,
        version: this.manifest.version,
        summary: 'Исправлен поиск заявок ЛИМС и фотографий — теперь агент всегда смотрит актуальные данные на сервере, а не устаревший локальный кэш. Также добавлен поиск по контактам.',
      });
      this.settings.lastAnnouncedVersion = this.manifest.version;
      await this.saveSettings();
    } catch (e: unknown) {
      console.warn('LogicTEAM.007: не удалось опубликовать новость об обновлении:', errorMessage(e));
    }
  }
}

export type { AgentToolContext, AgentAttachment, SbeApstoreApi };
