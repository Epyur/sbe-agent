/** Типы плагина LogicTEAM.007 (sbe-agent). */

export type AgentRole = 'user' | 'assistant' | 'tool';

export interface AgentMessage {
  role: AgentRole;
  content: string;
  /** Имена прикреплённых файлов (для сообщений пользователя). */
  files?: string[];
  /** Имя тула (для role='tool') и результат его исполнения. */
  tool?: string;
  toolOk?: boolean;
  /** Активная ссылка для кнопки (скачивание файла). */
  link?: AgentMessageLink;
  created_at: string;
}

export interface Dialog {
  id: string;
  title: string;
  messages: AgentMessage[];
  created_at: string;
  updated_at: string;
}

export interface AgentDbData {
  dialogs: Dialog[];
}

/** MCP-совместимое описание тула (JSON Schema для input_schema). */
export interface AgentToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Результат исполнения тула. summary — кратко для чата; data — полные данные LLM. */
export interface ToolCallResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
  /** Активная ссылка (например, скачивание файла) для отрисовки кнопкой в чате. */
  link?: { url: string; label: string };
}

/** Ссылка, отображаемая кнопкой в сообщении (например, скачивание сгенерированного файла). */
export interface AgentMessageLink {
  url: string;
  label: string;
}

/** Ответ agent-service на генерацию файла. */
export interface FileGenerateResponse {
  url: string;
  expires_at: string;
  file_name: string;
}

/** Ответ agent-service на разбор файла. */
export interface FileParseResponse {
  kind: string;
  text?: string;
  sheets?: Array<{ name: string; rows: unknown[][] }>;
  data?: unknown;
}

/** Структура документа для agent-service (docx/pdf). */
export interface DocSpecSection {
  heading?: string;
  paragraphs?: string[];
  table?: { headers?: string[]; rows?: string[][] };
}

export interface DocSpec {
  title?: string;
  sections?: DocSpecSection[];
  sheets?: Array<{ name: string; headers?: string[]; rows?: string[][] }>;
  data?: unknown;
}

/** Ответ LLM по протоколу тулов. */
export type LlmTurn =
  | { type: 'final'; text: string }
  | { type: 'tool_call'; tool: string; arguments: Record<string, unknown> };

/** Доступность источника данных для агента. */
export interface SourceAvailability {
  appId: string;
  name: string;
  available: boolean;
  role: string;
}
