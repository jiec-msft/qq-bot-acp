export type QQChatType = "direct" | "group" | "channel" | "forum";

export interface QQAttachment {
  contentType: string;
  url: string;
  filename?: string;
}

interface QQInboundMessageBase {
  accountId: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  targetId: string;
  messageId: string;
  timestamp: string;
  text: string;
  attachments: QQAttachment[];
  addressed?: boolean;
}

export interface QQStandardInboundMessage extends QQInboundMessageBase {
  chatType: Exclude<QQChatType, "forum">;
  forum?: never;
}

export interface QQForumInboundMessage extends QQInboundMessageBase {
  chatType: "forum";
  forum: {
    guildId: string;
    channelId: string;
    threadId: string;
    sourceTitle: string;
    botUsername: string;
  };
}

export type QQInboundMessage =
  | QQStandardInboundMessage
  | QQForumInboundMessage;

export interface QQGatewayEvent {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}
