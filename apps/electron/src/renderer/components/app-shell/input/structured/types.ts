import type { PermissionRequest, CredentialRequest, CredentialResponse } from '../../../../../shared/types'
import type { AdminApprovalRequestData } from './AdminApprovalRequest'

/**
 * Input mode determines which component is rendered in InputContainer
 */
export type InputMode = 'freeform' | 'structured'

/**
 * Types of structured input UIs
 */
export type StructuredInputType = 'permission' | 'credential' | 'admin_approval'

/**
 * Union type for structured input data
 */
export type StructuredInputData =
  | { type: 'permission'; data: PermissionRequest }
  | { type: 'credential'; data: CredentialRequest }
  | { type: 'admin_approval'; data: AdminApprovalRequestData }

/**
 * State for structured input
 */
export interface StructuredInputState {
  type: StructuredInputType
  data: PermissionRequest | CredentialRequest | AdminApprovalRequestData
}

/**
 * Response from permission request
 * sourcePermission: once=仅本次 / session=本会话 / always=工具级始终允许（持久）/
 * deny=本会话禁止 / deny-permanent=工具级永久禁止（持久）
 */
export interface PermissionResponse {
  type: 'permission'
  allowed: boolean
  alwaysAllow: boolean
  sourcePermission?: 'once' | 'session' | 'always' | 'deny' | 'deny-permanent'
}

/**
 * Response from admin approval request
 */
export interface AdminApprovalResponse {
  type: 'admin_approval'
  approved: boolean
  rememberForMinutes?: number
}

/**
 * Union type for all structured responses
 */
export type StructuredResponse = PermissionResponse | CredentialResponse | AdminApprovalResponse

// Re-export CredentialResponse for convenience
export type { CredentialResponse }
