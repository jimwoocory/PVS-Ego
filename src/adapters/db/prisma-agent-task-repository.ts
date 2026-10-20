import type { PrismaClient } from "@prisma/client";
import type {
  AgentMaterial,
  AgentTask,
  AgentTaskPlan,
  AgentTaskRepository,
  AgentTaskUpdate,
  AgentTaskStatus
} from "../../application/ports/agent-task-repository.js";
import type { DreaminaVideoOperation } from "../../domain/schemas.js";

function parseMaterials(value: string): AgentMaterial[] {
  return JSON.parse(value) as AgentMaterial[];
}

function parsePlan(value: string | null): AgentTaskPlan | undefined {
  return value ? (JSON.parse(value) as AgentTaskPlan) : undefined;
}

function mapRow(row: {
  id: string;
  projectId: string;
  skillId: string;
  status: string;
  requestText: string;
  requestedMethod: string;
  selectedOperation: string | null;
  model: string;
  durationMs: number;
  aspectRatio: string;
  videoResolution: string;
  nativeAudioOutputRequested: boolean;
  materialsJson: string;
  planJson: string | null;
  generationRequestId: string | null;
  generationAttemptId: string | null;
  outputArtifactId: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): AgentTask {
  return {
    id: row.id,
    projectId: row.projectId,
    skillId: "dreamina-cli",
    status: row.status as AgentTaskStatus,
    requestText: row.requestText,
    requestedMethod: row.requestedMethod as AgentTask["requestedMethod"],
    ...(row.selectedOperation
      ? { selectedOperation: row.selectedOperation as DreaminaVideoOperation }
      : {}),
    model: row.model,
    durationMs: row.durationMs,
    aspectRatio: row.aspectRatio,
    videoResolution: row.videoResolution,
    nativeAudioOutputRequested: row.nativeAudioOutputRequested,
    materials: parseMaterials(row.materialsJson),
    ...(parsePlan(row.planJson) ? { plan: parsePlan(row.planJson)! } : {}),
    ...(row.generationRequestId
      ? { generationRequestId: row.generationRequestId }
      : {}),
    ...(row.generationAttemptId
      ? { generationAttemptId: row.generationAttemptId }
      : {}),
    ...(row.outputArtifactId ? { outputArtifactId: row.outputArtifactId } : {}),
    ...(row.acceptedAt ? { acceptedAt: row.acceptedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export class PrismaAgentTaskRepository implements AgentTaskRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(task: AgentTask): Promise<AgentTask> {
    const row = await this.prisma.agentTaskRecord.create({
      data: {
        id: task.id,
        projectId: task.projectId,
        skillId: task.skillId,
        status: task.status,
        requestText: task.requestText,
        requestedMethod: task.requestedMethod,
        selectedOperation: task.selectedOperation ?? null,
        model: task.model,
        durationMs: task.durationMs,
        aspectRatio: task.aspectRatio,
        videoResolution: task.videoResolution,
        nativeAudioOutputRequested: task.nativeAudioOutputRequested,
        materialsJson: JSON.stringify(task.materials),
        planJson: task.plan ? JSON.stringify(task.plan) : null,
        generationRequestId: task.generationRequestId ?? null,
        generationAttemptId: task.generationAttemptId ?? null,
        outputArtifactId: task.outputArtifactId ?? null,
        acceptedAt: task.acceptedAt ? new Date(task.acceptedAt) : null,
        createdAt: new Date(task.createdAt),
        updatedAt: new Date(task.updatedAt)
      }
    });
    return mapRow(row);
  }

  async update(id: string, update: AgentTaskUpdate): Promise<AgentTask> {
    const row = await this.prisma.agentTaskRecord.update({
      where: { id },
      data: {
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...("selectedOperation" in update
          ? { selectedOperation: update.selectedOperation ?? null }
          : {}),
        ...(update.materials !== undefined
          ? { materialsJson: JSON.stringify(update.materials) }
          : {}),
        ...("plan" in update
          ? { planJson: update.plan ? JSON.stringify(update.plan) : null }
          : {}),
        ...("generationRequestId" in update
          ? { generationRequestId: update.generationRequestId ?? null }
          : {}),
        ...("generationAttemptId" in update
          ? { generationAttemptId: update.generationAttemptId ?? null }
          : {}),
        ...("outputArtifactId" in update
          ? { outputArtifactId: update.outputArtifactId ?? null }
          : {}),
        ...("acceptedAt" in update
          ? { acceptedAt: update.acceptedAt ? new Date(update.acceptedAt) : null }
          : {})
      }
    });
    return mapRow(row);
  }

  async findById(id: string): Promise<AgentTask | null> {
    const row = await this.prisma.agentTaskRecord.findUnique({ where: { id } });
    return row ? mapRow(row) : null;
  }

  async listByProject(projectId: string): Promise<AgentTask[]> {
    const rows = await this.prisma.agentTaskRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapRow);
  }
}
