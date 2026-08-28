// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------------------
// Google A2A Protocol v1.0 — Canonical Data Types (JSON-RPC 2.0 binding)
// Reference: https://a2aproject.github.io/A2A/latest/specification
// ---------------------------------------------------------------------------

// ======================== 4.1 Core Objects ==================================

export enum TaskState {
  UNSPECIFIED = "TASK_STATE_UNSPECIFIED",
  SUBMITTED = "TASK_STATE_SUBMITTED",
  WORKING = "TASK_STATE_WORKING",
  COMPLETED = "TASK_STATE_COMPLETED",
  FAILED = "TASK_STATE_FAILED",
  CANCELED = "TASK_STATE_CANCELED",
  INPUT_REQUIRED = "TASK_STATE_INPUT_REQUIRED",
  REJECTED = "TASK_STATE_REJECTED",
  AUTH_REQUIRED = "TASK_STATE_AUTH_REQUIRED",
}

export const TERMINAL_STATES = new Set<TaskState>([
  TaskState.COMPLETED,
  TaskState.FAILED,
  TaskState.CANCELED,
  TaskState.REJECTED,
]);

export enum Role {
  UNSPECIFIED = "ROLE_UNSPECIFIED",
  USER = "ROLE_USER",
  AGENT = "ROLE_AGENT",
}

export interface Part {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  filename?: string;
  mediaType?: string;
}

export interface Message {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: Role;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp?: string;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

export interface Task {
  id: string;
  contextId?: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

// ======================== 4.2 Streaming Events ==============================

export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  metadata?: Record<string, unknown>;
}

export interface TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

export type StreamResponse =
  | { task: Task }
  | { message: Message }
  | { statusUpdate: TaskStatusUpdateEvent }
  | { artifactUpdate: TaskArtifactUpdateEvent };

// ======================== 4.4 Agent Discovery ===============================

export interface AgentProvider {
  url: string;
  organization: string;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: AgentExtension[];
  extendedAgentCard?: boolean;
}

export interface AgentExtension {
  uri?: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentInterface {
  url: string;
  protocolBinding: string;
  tenant?: string;
  protocolVersion: string;
}

export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: AgentInterface[];
  provider?: AgentProvider;
  version: string;
  documentationUrl?: string;
  capabilities: AgentCapabilities;
  securitySchemes?: Record<string, SecurityScheme>;
  securityRequirements?: SecurityRequirement[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  iconUrl?: string;
}

// ======================== 4.5 Security ======================================

export interface HTTPAuthSecurityScheme {
  scheme: string;
  bearerFormat?: string;
  description?: string;
}

export interface APIKeySecurityScheme {
  in: "query" | "header" | "cookie";
  name: string;
  description?: string;
}

export type SecurityScheme =
  | { httpAuthSecurityScheme: HTTPAuthSecurityScheme }
  | { apiKeySecurityScheme: APIKeySecurityScheme };

export type SecurityRequirement = Record<string, string[]>;

// ======================== 3.2 Operation Parameters ==========================

export interface AuthenticationInfo {
  scheme: string;
  credentials?: string;
}

export interface PushNotificationConfig {
  url: string;
  token?: string;
  authentication?: AuthenticationInfo;
}

export interface TaskPushNotificationConfig {
  taskId?: string;
  pushNotificationConfig: PushNotificationConfig;
}

export interface SendMessageConfiguration {
  acceptedOutputModes?: string[];
  taskPushNotificationConfig?: TaskPushNotificationConfig;
  historyLength?: number;
  returnImmediately?: boolean;
}

export interface SendMessageRequest {
  message: Message;
  configuration?: SendMessageConfiguration;
  metadata?: Record<string, unknown>;
}

export interface GetTaskRequest {
  id: string;
  historyLength?: number;
}

export interface ListTasksRequest {
  contextId?: string;
  status?: TaskState;
  pageSize?: number;
  pageToken?: string;
  historyLength?: number;
  statusTimestampAfter?: string;
  includeArtifacts?: boolean;
}

export interface ListTasksResponse {
  tasks: Task[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

export interface CancelTaskRequest {
  id: string;
  metadata?: Record<string, unknown>;
}

export interface SubscribeToTaskRequest {
  id: string;
}

// ======================== 9. JSON-RPC 2.0 Binding ===========================

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

export interface JsonRpcErrorDetail {
  "@type": string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, unknown>;
  fieldViolations?: Array<{ field: string; description: string }>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: JsonRpcErrorDetail[];
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// Standard JSON-RPC 2.0 error codes
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

// A2A-specific error codes per spec §5.4 Error Code Mappings.
// DO NOT renumber: the codes are part of the wire protocol and clients
// match on them.
export const A2A_TASK_NOT_FOUND = -32001;
export const A2A_TASK_NOT_CANCELABLE = -32002;
export const A2A_PUSH_NOTIFICATION_NOT_SUPPORTED = -32003;
export const A2A_UNSUPPORTED_OPERATION = -32004;
export const A2A_CONTENT_TYPE_NOT_SUPPORTED = -32005;
export const A2A_INVALID_AGENT_RESPONSE = -32006;
export const A2A_EXTENDED_AGENT_CARD_NOT_CONFIGURED = -32007;
export const A2A_EXTENSION_SUPPORT_REQUIRED = -32008;
export const A2A_VERSION_NOT_SUPPORTED = -32009;

// JSON-RPC method names (PascalCase per spec §9.4)
export const A2A_METHODS = {
  SendMessage: "SendMessage",
  SendStreamingMessage: "SendStreamingMessage",
  GetTask: "GetTask",
  ListTasks: "ListTasks",
  CancelTask: "CancelTask",
  SubscribeToTask: "SubscribeToTask",
  CreateTaskPushNotificationConfig: "CreateTaskPushNotificationConfig",
  GetTaskPushNotificationConfig: "GetTaskPushNotificationConfig",
  ListTaskPushNotificationConfigs: "ListTaskPushNotificationConfigs",
  DeleteTaskPushNotificationConfig: "DeleteTaskPushNotificationConfig",
  GetExtendedAgentCard: "GetExtendedAgentCard",
} as const;

// ======================== Helpers ============================================

export function makeJsonRpcSuccess(id: string | number, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function makeJsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: JsonRpcErrorDetail[],
): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

export function makeA2AErrorDetail(reason: string, meta?: Record<string, unknown>): JsonRpcErrorDetail {
  return {
    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
    reason,
    domain: "a2a-protocol.org",
    ...(meta ? { metadata: meta } : {}),
  };
}

export function makeTaskNotFoundError(id: string | number | null, taskId: string): JsonRpcErrorResponse {
  return makeJsonRpcError(id, A2A_TASK_NOT_FOUND, "Task not found", [
    makeA2AErrorDetail("TASK_NOT_FOUND", { taskId }),
  ]);
}

export function makeUnsupportedOperationError(id: string | number | null, detail: string): JsonRpcErrorResponse {
  return makeJsonRpcError(id, A2A_UNSUPPORTED_OPERATION, detail, [
    makeA2AErrorDetail("UNSUPPORTED_OPERATION"),
  ]);
}

export function makePushNotificationNotSupportedError(id: string | number | null): JsonRpcErrorResponse {
  return makeJsonRpcError(id, A2A_PUSH_NOTIFICATION_NOT_SUPPORTED, "Push notifications are not supported", [
    makeA2AErrorDetail("PUSH_NOTIFICATION_NOT_SUPPORTED"),
  ]);
}

export function makeVersionNotSupportedError(
  id: string | number | null,
  requestedVersion: string,
): JsonRpcErrorResponse {
  return makeJsonRpcError(id, A2A_VERSION_NOT_SUPPORTED, "A2A protocol version is not supported", [
    makeA2AErrorDetail("VERSION_NOT_SUPPORTED", { requestedVersion, supportedVersion: "1.0" }),
  ]);
}

export function makeTaskNotCancelableError(
  id: string | number | null,
  taskId: string,
  currentState: string,
): JsonRpcErrorResponse {
  return makeJsonRpcError(id, A2A_TASK_NOT_CANCELABLE, "Task is not in a cancelable state", [
    makeA2AErrorDetail("TASK_NOT_CANCELABLE", { taskId, currentState }),
  ]);
}
