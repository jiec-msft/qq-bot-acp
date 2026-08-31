export type QQChatType = "direct" | "group" | "channel";

export interface QQAttachment {
  contentType: string;
  url: string;
  filename?: string;
}

export interface QQInboundMessage {
  accountId: string;
  conversationId: string;
  chatType: QQChatType;
  senderId: string;
  senderName?: string;
  targetId: string;
  messageId: string;
  timestamp: string;
  text: string;
  attachments: QQAttachment[];
  addressed?: boolean;
}

export interface QQGatewayEvent {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}
