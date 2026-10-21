import type { DouyinCollectionRun } from "../../domain/douyin-collection.js";

export interface DouyinCollectionRepository {
  create(run: DouyinCollectionRun): Promise<{ run: DouyinCollectionRun; created: boolean }>;
  get(projectId: string, id: string): Promise<DouyinCollectionRun | null>;
  findByRequestKey?(projectId:string,requestKey:string):Promise<DouyinCollectionRun|null>;
  resumeAfterHuman?(projectId:string,id:string,revision:number,now:string):Promise<DouyinCollectionRun|null>;
  list(projectId: string): Promise<DouyinCollectionRun[]>;
  claim(input: { projectId: string; id: string; revision: number; owner: string; now: string; until: string }): Promise<DouyinCollectionRun | null>;
  checkpoint(run: DouyinCollectionRun, owner: string, until: string): Promise<DouyinCollectionRun>;
  release(projectId: string, id: string, owner: string): Promise<void>;
  countSaved(input: { projectId: string; bindingId: string; awemeId: string; parentCid?: string }): Promise<number>;
}
