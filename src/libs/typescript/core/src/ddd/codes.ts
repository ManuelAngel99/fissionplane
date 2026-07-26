/**
 * HTTP status and default message for each failure class FissionPlane emits.
 *
 * Entries exist only for statuses a real path produces today. Concrete errors
 * carry their own machine-readable `code`; this catalog owns the transport
 * status so an error and its HTTP mapping can never drift apart.
 */
export const ErrorCode = {
  UNAUTHENTICATED: {
    message: 'You are not authenticated',
    statusCode: 401,
  },
  UNAUTHORIZED: {
    message: 'You are not authorized to perform this action',
    statusCode: 403,
  },
  INTERNAL: {
    message: 'Internal server error',
    statusCode: 500,
  },
} as const

export type ErrorCodeKey = keyof typeof ErrorCode
export type ErrorCodeEntry = (typeof ErrorCode)[ErrorCodeKey]
