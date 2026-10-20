export type CanvasVideoDownloadRequest={canvasProjectId:string;nodeId:string;submitId:string;resourceId:string;accountFingerprint:string;outputPath:string};
export interface CanvasVideoDownload {
  readiness(accountFingerprint:string):Promise<{ready:boolean;code?:string;message?:string}>;
  download(input:CanvasVideoDownloadRequest):Promise<{path:string;sha256:string;sizeBytes:number}>;
}
