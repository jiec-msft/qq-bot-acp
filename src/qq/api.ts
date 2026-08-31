const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_BASE_URL = "https://api.sgroup.qq.com";

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
}

interface GatewayResponse {
  url?: string;
}

export interface QQSendTextInput {
  chatType: "direct" | "group" | "channel";
  targetId: string;
  text: string;
  replyToId?: string;
  sequence?: number;
  markdown?: boolean;
}

export type QQMediaFileType = 1 | 2 | 3 | 4;

export interface QQUploadMediaInput {
  chatType: "direct" | "group";
  targetId: string;
  data: Buffer;
  fileType: QQMediaFileType;
  fileName?: string;
}

export interface QQSendMediaInput {
  chatType: "direct" | "group";
  targetId: string;
  fileInfo: string;
  replyToId?: string;
  sequence?: number;
  caption?: string;
}

export interface QQSendStreamInput {
  targetId: string;
  text: string;
  replyToId: string;
  sequence: number;
  index: number;
  state: 1 | 10;
  contentType: "text" | "markdown";
  streamMessageId?: string;
  isWakeup?: boolean;
}

export interface QQStreamMessageResponse {
  id: string;
  pendingCharacters?: number;
}

export type QQPanelScope = "c2c" | "group" | "channel" | "dm";

export interface QQPanelItem {
  name: string;
  desc: string;
  type: "command" | "link";
  only_admin?: boolean;
  link?: string;
}

export interface QQPanelRecord {
  panel_id: string;
  scope: QQPanelScope;
  target_type: "all" | "specific";
  panel: {
    items?: QQPanelItem[];
    remark?: string;
    version?: number;
  };
}

export class QQApiError extends Error {
  constructor(
    operation: string,
    readonly status: number,
    readonly code?: string | number,
    readonly traceId?: string,
  ) {
    const details = [
      code === undefined ? undefined : `code ${code}`,
      traceId ? `trace ${traceId}` : undefined,
    ].filter(Boolean);
    super(
      `QQ ${operation} failed (${status}${
        details.length > 0 ? `; ${details.join("; ")}` : ""
      })`,
    );
    this.name = "QQApiError";
  }
}

export class QQApi {
  private accessToken?: string;
  private tokenExpiresAt = 0;

  constructor(
    readonly appId: string,
    private readonly clientSecret: string,
  ) {}

  async getAccessToken(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret,
      }),
    });
    const body = (await response.json()) as TokenResponse;
    if (!response.ok || !body.access_token) {
      throw new Error(`QQ authentication failed (${response.status}): ${JSON.stringify(body)}`);
    }
    const expiresIn = Number(body.expires_in ?? 7200);
    this.accessToken = body.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, expiresIn) * 1000;
    return this.accessToken;
  }

  async getGatewayUrl(): Promise<string> {
    const response = await this.request("/gateway", { method: "GET" });
    const body = (await response.json()) as GatewayResponse;
    if (!body.url) throw new Error("QQ gateway response did not include a WebSocket URL");
    return body.url;
  }

  async sendText(input: QQSendTextInput): Promise<string> {
    const body = buildTextMessageBody(input);
    const endpoint =
      input.chatType === "direct"
        ? `/v2/users/${encodeURIComponent(input.targetId)}/messages`
        : input.chatType === "group"
          ? `/v2/groups/${encodeURIComponent(input.targetId)}/messages`
          : `/channels/${encodeURIComponent(input.targetId)}/messages`;
    const response = await this.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw qqApiError("send", response, result);
    }
    return confirmedMessageId("send", response, result);
  }

  async uploadMedia(input: QQUploadMediaInput): Promise<string> {
    const endpoint =
      input.chatType === "direct"
        ? `/v2/users/${encodeURIComponent(input.targetId)}/files`
        : `/v2/groups/${encodeURIComponent(input.targetId)}/files`;
    const response = await this.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        buildMediaUploadBody(input.data, input.fileType, input.fileName),
      ),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw qqApiError("media upload", response, result);
    }
    if (typeof result.file_info !== "string" || !result.file_info.trim()) {
      throw new QQApiError(
        "media upload confirmation",
        response.status,
        "missing-file-info",
      );
    }
    return result.file_info;
  }

  async sendMedia(input: QQSendMediaInput): Promise<string> {
    const endpoint =
      input.chatType === "direct"
        ? `/v2/users/${encodeURIComponent(input.targetId)}/messages`
        : `/v2/groups/${encodeURIComponent(input.targetId)}/messages`;
    const response = await this.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildMediaMessageBody(input)),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw qqApiError("media send", response, result);
    }
    return confirmedMessageId("media send", response, result);
  }

  async sendStream(input: QQSendStreamInput): Promise<QQStreamMessageResponse> {
    const endpoint = `/v2/users/${encodeURIComponent(input.targetId)}/stream_messages`;
    const response = await this.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildStreamMessageBody(input)),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw qqApiError("stream send", response, result);
    }
    return parseStreamMessageResponse(result);
  }

  async updateMenu(items: Record<string, unknown>[]): Promise<void> {
    const response = await this.request("/v2/menu", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ menu: { items } }),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw qqApiError("menu update", response, result);
  }

  async listPanels(
    scope: QQPanelScope,
    cursor = "",
  ): Promise<{
    records: QQPanelRecord[];
    nextCursor: string;
    isEnd: boolean;
  }> {
    const query = new URLSearchParams({ scope, limit: "50" });
    if (cursor) query.set("cursor", cursor);
    const response = await this.request(`/v2/panels?${query}`, {
      method: "GET",
    });
    const result = (await response.json().catch(() => ({}))) as {
      records?: QQPanelRecord[];
      next_cursor?: string;
      is_end?: boolean;
    } & Record<string, unknown>;
    if (!response.ok) throw qqApiError("panel list", response, result);
    return {
      records: Array.isArray(result.records) ? result.records : [],
      nextCursor:
        typeof result.next_cursor === "string" ? result.next_cursor : "",
      isEnd: result.is_end === true || !result.next_cursor,
    };
  }

  async createPanel(
    scope: QQPanelScope,
    panel: { items: QQPanelItem[]; remark: string },
  ): Promise<string> {
    const response = await this.request("/v2/panels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        target_type: "all",
        panel,
      }),
    });
    const result = (await response.json().catch(() => ({}))) as {
      panel_id?: string;
    } & Record<string, unknown>;
    if (!response.ok) throw qqApiError("panel create", response, result);
    if (!result.panel_id) {
      throw new Error("QQ panel create response did not include panel_id");
    }
    return result.panel_id;
  }

  async updatePanel(
    panelId: string,
    panel: { items: QQPanelItem[]; remark: string },
  ): Promise<void> {
    const response = await this.request(
      `/v2/panels/${encodeURIComponent(panelId)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ panel }),
      },
    );
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw qqApiError("panel update", response, result);
  }

  private async request(endpoint: string, init: RequestInit, retry = true): Promise<Response> {
    const token = await this.getAccessToken();
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `QQBot ${token}`,
        "x-union-appid": this.appId,
      },
    });
    if (response.status === 401 && retry) {
      await this.getAccessToken(true);
      return this.request(endpoint, init, false);
    }
    return response;
  }
}

export function buildTextMessageBody(input: QQSendTextInput): Record<string, unknown> {
  if (input.chatType === "channel") {
    return { content: input.text, msg_id: input.replyToId };
  }
  if (input.markdown) {
    return {
      msg_type: 2,
      markdown: { content: input.text },
      ...(input.replyToId
        ? { msg_id: input.replyToId, msg_seq: input.sequence ?? 1 }
        : {}),
    };
  }

  return {
    content: input.text,
    msg_type: 0,
    ...(input.replyToId
      ? { msg_id: input.replyToId, msg_seq: input.sequence ?? 1 }
      : {}),
  };
}

export function buildMediaUploadBody(
  data: Buffer,
  fileType: QQMediaFileType,
  fileName?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    file_type: fileType,
    file_data: data.toString("base64"),
    srv_send_msg: false,
  };
  if (fileType === 4) {
    if (!fileName?.trim()) {
      throw new Error("QQ ordinary file uploads require a file name");
    }
    body.file_name = sanitizeQQFileName(fileName);
  }
  return body;
}

export function buildMediaMessageBody(input: QQSendMediaInput): Record<string, unknown> {
  return {
    content: input.caption?.trim() || " ",
    msg_type: 7,
    media: { file_info: input.fileInfo },
    ...(input.replyToId
      ? { msg_id: input.replyToId, msg_seq: input.sequence ?? 1 }
      : {}),
  };
}

export function buildStreamMessageBody(
  input: QQSendStreamInput,
): Record<string, unknown> {
  return {
    input_mode: "replace",
    input_state: input.state,
    index: input.index,
    content_type: input.contentType,
    content_raw: input.text,
    ...(!input.isWakeup ? { msg_id: input.replyToId } : {}),
    ...(input.streamMessageId
      ? { stream_msg_id: input.streamMessageId }
      : {}),
    ...(!input.isWakeup ? { msg_seq: input.sequence } : {}),
    ...(input.isWakeup ? { is_wakeup: true } : {}),
  };
}

export function parseStreamMessageResponse(
  result: Record<string, unknown>,
): QQStreamMessageResponse {
  if (typeof result.id !== "string" || !result.id) {
    throw new Error("QQ stream response did not include a message ID");
  }
  if (
    result.remain_msg_len !== undefined &&
    (!Number.isInteger(result.remain_msg_len) ||
      (result.remain_msg_len as number) < 0)
  ) {
    throw new Error("QQ stream response included an invalid remaining length");
  }
  return {
    id: result.id,
    pendingCharacters:
      result.remain_msg_len === undefined
        ? undefined
        : result.remain_msg_len as number,
  };
}

function sanitizeQQFileName(fileName: string): string {
  const sanitized = fileName
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || "file";
}

function qqApiError(
  operation: string,
  response: Response,
  result: Record<string, unknown>,
): QQApiError {
  const rawCode = result.code ?? result.err_code;
  const code =
    typeof rawCode === "number" || typeof rawCode === "string"
      ? rawCode
      : undefined;
  const rawTraceId =
    response.headers.get("x-tps-trace-id") ??
    response.headers.get("x-request-id") ??
    result.trace_id;
  const traceId =
    typeof rawTraceId === "string"
      ? diagnosticValue(rawTraceId)
      : undefined;
  return new QQApiError(
    operation,
    response.status,
    code,
    traceId,
  );
}

function confirmedMessageId(
  operation: string,
  response: Response,
  result: Record<string, unknown>,
): string {
  if (typeof result.id === "string" && result.id.trim()) {
    return result.id;
  }
  throw new QQApiError(
    `${operation} confirmation`,
    response.status,
    "missing-message-id",
  );
}

function diagnosticValue(value: string): string | undefined {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return normalized ? normalized.slice(0, 300) : undefined;
}
