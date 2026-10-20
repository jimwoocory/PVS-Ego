export type DouyinReplyWriteStatus =
  | "REPLY_POSTED_CONFIRMED"
  | "SUBMISSION_UNKNOWN"
  | "REJECTED";

export type DouyinReplyWriteResult = {
  status: DouyinReplyWriteStatus;
  confirmed: boolean;
  writeIntentId: string;
  replyCid?: string;
  text?: string;
  createdAt?: number;
  platformStatusCode?: number;
  message?: string;
};

export interface DouyinReplyWriterRuntime {
  postReply(input: {
    awemeId: string;
    cid: string;
    text: string;
    writeIntentId: string;
    confirmed: true;
  }): Promise<DouyinReplyWriteResult>;
}
