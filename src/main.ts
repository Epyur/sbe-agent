import { Plugin, WorkspaceLeaf } from 'obsidian';
import { AgentDatabase } from './database/agent-db';
import { AgentView, SBE_AGENT_VIEW_TYPE } from './ui/agent-view';
import { AgentSettingsTab } from './ui/settings-tab';
import { publishService, unpublishService, getService } from '../../sbe-core/src/bridge';
import type { SbeAgentApi, SbeLlmApi, SbeApstoreApi } from '../../sbe-core/src/types';
import type { SourceAvailability } from './types/agent';
import { AgentToolContext, AgentAttachment, createTools } from './agent/tools-registry';
import { request, assertOk } from './agent/http';
import { errorMessage } from '../../sbe-core/src/utils/errors';

export interface SbeAgentSettings {
  apiUrl: string;
  userName: string;
  model: string;
}

const DEFAULT_SETTINGS: SbeAgentSettings = {
  apiUrl: 'https://epyur.fvds.ru',
  userName: '',
  model: '',
};

const SOURCE_DEFS: Array<{ appId: string; name: string }> = [
  { appId: 'mailer', name: 'Письма' },
  { appId: 'documents', name: 'Документы' },
  { appId: 'lab', name: 'ЛИМС' },
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
    };
  }

  /** LLM из центра sbe-llm (completeJson для JSON-протокола тулов). */
  async getLlm(): Promise<Pick<SbeLlmApi, 'completeJson'>> {
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
}

export type { AgentToolContext, AgentAttachment, SbeApstoreApi };
