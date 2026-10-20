import type {
  DouyinOpsCommentPage,
  DouyinOpsDownloadMetadata,
  DouyinOpsIdentity,
  DouyinOpsProbe,
  DouyinOpsRuntime,
  DouyinOpsWork
} from "../ports/douyin-ops-runtime.js";

export class DouyinOpsService {
  constructor(
    private readonly runtime: DouyinOpsRuntime
  ) {}

  probe(): Promise<DouyinOpsProbe> {
    return this.runtime.probe();
  }

  identity(): Promise<DouyinOpsIdentity> {
    return this.runtime.identity();
  }

  listMyWorks(count = 20): Promise<DouyinOpsWork[]> {
    return this.runtime.listMyWorks(count);
  }

  searchWorks(input: {
    query: string;
    count?: number;
    offset?: number;
  }): Promise<DouyinOpsWork[]> {
    return this.runtime.searchWorks(input);
  }

  getWork(awemeId: string): Promise<DouyinOpsWork> {
    return this.runtime.getWork(awemeId);
  }

  getComments(input: {
    awemeId: string;
    cursor?: string;
    count?: number;
  }): Promise<DouyinOpsCommentPage> {
    return this.runtime.getComments(input);
  }

  getReplies(input: {
    awemeId: string;
    cid: string;
    cursor?: string;
    count?: number;
  }): Promise<DouyinOpsCommentPage> {
    return this.runtime.getReplies(input);
  }

  getDownloadMetadata(
    awemeId: string
  ): Promise<DouyinOpsDownloadMetadata> {
    return this.runtime.getDownloadMetadata(awemeId);
  }
}
