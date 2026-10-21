import type { DouyinOperationsSchedule } from "../../domain/douyin-operations-schedule.js";

export interface DouyinOperationsScheduleRepository {
  create(run: DouyinOperationsSchedule): Promise<DouyinOperationsSchedule>;
  get(projectId: string, id: string): Promise<DouyinOperationsSchedule | null>;
  list(projectId: string): Promise<DouyinOperationsSchedule[]>;
  due(now: string, limit: number): Promise<DouyinOperationsSchedule[]>;
  claim(projectId: string, id: string, revision: number, owner: string, now: string, until: string): Promise<DouyinOperationsSchedule | null>;
  save(run: DouyinOperationsSchedule, owner: string, until: string): Promise<DouyinOperationsSchedule>;
  pause(projectId: string, id: string, expectedRevision: number, now: string): Promise<DouyinOperationsSchedule | null>;
  release(projectId: string, id: string, owner: string): Promise<void>;
  assertLease?(projectId:string,id:string,revision:number,owner:string,now:string):Promise<void>;
  resume?(projectId:string,id:string,revision:number,inputHash:string,now:string):Promise<DouyinOperationsSchedule|null>;
  inspectLease?(projectId:string,id:string,now:string):Promise<{revision:number;state:"ACTIVE"|"EXPIRED"|"FREE";expiresAt?:string;checkedAt:string}|null>;
}
