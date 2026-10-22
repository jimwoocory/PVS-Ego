/** Process-local persistence authority, never accepted from HTTP or stored as data. */
export type OperationsWriteFence={projectId:string;scheduleId:string;revision:number;owner:string;now:()=>string;deadlineAt?:string};
